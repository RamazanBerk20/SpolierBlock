package dev.spoilerblock;

import org.json.JSONObject;

import java.nio.ByteBuffer;
import java.nio.LongBuffer;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.regex.Pattern;

import ai.onnxruntime.OnnxTensor;
import ai.onnxruntime.OrtEnvironment;
import ai.onnxruntime.OrtSession;

/**
 * "Only block actual spoilers": the browser extension's sentence classifier (models/spoiler: MiniLM fine-tuned, int8
 * ONNX) on ONNX Runtime, run exactly like src/background/engine.js classify(): strip @handles, split into sentences,
 * score each sentence alone (the int8 model quantizes activations per tensor, so batching/padding would shift the
 * scores), take the max. Not thread-safe; SpoilerBlock runs it on one worker thread.
 */
final class Classifier implements AutoCloseable {
    // text.split(/(?<=[.!?])\s+|\n+/) with JavaScript's \s
    private static final Pattern SPLIT = Pattern.compile("(?<=[.!?])[\\t\\n\\x0B\\f\\r \\u00A0\\u1680\\u2000-\\u200A\\u2028\\u2029\\u202F\\u205F\\u3000\\uFEFF]+|\\n+");
    private static final Pattern HANDLE = Pattern.compile("@[A-Za-z0-9_]+");

    final double threshold;
    private final WordPiece tok;
    private final OrtEnvironment env;
    private final OrtSession session;

    /** model: the ONNX file in a direct buffer (kept off the Java heap; ORT copies what it needs). */
    Classifier(ByteBuffer model, String tokenizerJson, String metaJson) throws Exception {
        threshold = new JSONObject(metaJson).getDouble("threshold");
        tok = new WordPiece(tokenizerJson);
        env = OrtEnvironment.getEnvironment();
        try (OrtSession.SessionOptions o = new OrtSession.SessionOptions()) {
            o.setIntraOpNumThreads(1); // like the extension (1 WASM thread); leaves the other cores to the app
            session = env.createSession(model, o);
        }
    }

    /** The sentences the model scores (at most 16), as the extension cuts them. */
    static List<String> sentences(String text) {
        List<String> out = new ArrayList<>();
        for (String s : SPLIT.split(text, -1)) {
            s = WordPiece.JsRegex.trim(HANDLE.matcher(s).replaceAll(""));
            if (s.length() > 3 && out.size() < 16) out.add(s);
        }
        return out;
    }

    /** Spoiler probability of a post: the max over its sentences, 0 when it has none. */
    double prob(String text) throws Exception {
        double z = Double.NEGATIVE_INFINITY;
        List<String> sents = sentences(text);
        if (sents.isEmpty()) return 0;
        for (String s : sents) z = Math.max(z, logit(s));
        return 1 / (1 + Math.exp(-z));
    }

    float logit(String sentence) throws Exception {
        long[] ids = tok.encode(sentence, 64);
        long[] mask = new long[ids.length];
        Arrays.fill(mask, 1);
        long[] shape = {1, ids.length};
        try (OnnxTensor a = OnnxTensor.createTensor(env, LongBuffer.wrap(ids), shape);
             OnnxTensor b = OnnxTensor.createTensor(env, LongBuffer.wrap(mask), shape)) {
            java.util.Map<String, OnnxTensor> in = new java.util.HashMap<>(); // not Map.of: minSdk 28
            in.put("input_ids", a);
            in.put("attention_mask", b);
            try (OrtSession.Result r = session.run(in)) {
                return ((OnnxTensor) r.get(0)).getFloatBuffer().get(0);
            }
        }
    }

    @Override public void close() throws Exception { session.close(); }
}
