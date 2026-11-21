package dev.spoilerblock;

import org.json.JSONObject;

import java.nio.ByteBuffer;
import java.nio.LongBuffer;
import java.util.List;

import ai.onnxruntime.OnnxTensor;
import ai.onnxruntime.OrtEnvironment;
import ai.onnxruntime.OrtSession;

/**
 * The title-in-context model (models/context; docs/agents/contract.md, "Names the matcher is unsure about"): does this
 * name, in this post, mean this work? A port of src/shared/context-input.js (the two strings and the pair's ids) and of
 * engine.js context() (one pair per run, no padding). Not thread-safe; SpoilerBlock runs it on its worker thread.
 */
final class ContextClassifier implements AutoCloseable {
    static final int WINDOW = 100; // SBContext.WINDOW
    static final String[] TYPES = {"movie", "tv", "game", "book", "anime", "manga", "comic"};

    final double threshold, thresholdOther;
    final int maxLength;
    private final WordPiece tok;
    private final OrtEnvironment env;
    private final OrtSession session;

    ContextClassifier(ByteBuffer model, String tokenizerJson, String metaJson) throws Exception {
        JSONObject meta = new JSONObject(metaJson);
        threshold = meta.getDouble("threshold");
        thresholdOther = meta.optDouble("thresholdOther", threshold); // as engine.js: one threshold serves both when absent
        maxLength = meta.getInt("maxLength");
        tok = new WordPiece(tokenizerJson);
        env = OrtEnvironment.getEnvironment();
        try (OrtSession.SessionOptions o = new OrtSession.SessionOptions()) {
            o.setIntraOpNumThreads(1);
            session = env.createSession(model, o);
        }
    }

    /** Segment A: the post's own text cut to the window around [s, e), the name marked <name> (SBContext.windowText). */
    static String windowText(String text, int s, int e) {
        int a = Math.max(0, s - WINDOW), b = Math.min(text.length(), e + WINDOW);
        if (a > 0) { int i = a; while (i < s && !WordPiece.JsRegex.isSpace(text.charAt(i))) i++; a = i < s ? i + 1 : s; }
        if (b < text.length()) { int i = b - 1; while (i >= e && !WordPiece.JsRegex.isSpace(text.charAt(i))) i--; b = i >= e ? i : e; }
        String w = text.substring(a, s) + '<' + text.substring(s, e) + '>' + text.substring(e, b);
        StringBuilder out = new StringBuilder(w.length()); // .replace(/\s+/g, ' ').trim()
        for (int i = 0; i < w.length(); i++) {
            char c = w.charAt(i);
            if (!WordPiece.JsRegex.isSpace(c)) out.append(c);
            else if (out.length() > 0 && out.charAt(out.length() - 1) != ' ') out.append(' ');
        }
        int n = out.length();
        if (n > 0 && out.charAt(n - 1) == ' ') out.setLength(n - 1);
        return out.toString();
    }

    /** Segment B: `{group label} [{types}]`, the group's distinct work types in TYPES order (SBContext.workText). */
    static String workText(Matcher m, int g) {
        StringBuilder b = new StringBuilder(m.labels[g]).append(" [");
        boolean first = true;
        for (String t : TYPES) {
            boolean has = false;
            for (int w : m.groupWorks(g)) has |= t.equals(m.types[w]);
            if (has) { b.append(first ? "" : ", ").append(t); first = false; }
        }
        return b.append(']').toString();
    }

    /** {input_ids, token_type_ids}: [CLS] A [SEP] B [SEP], A cut from its end to fit maxLength (SBContext.pairIds). */
    long[][] encode(String a, String b) {
        List<Integer> ta = tok.tokens(a), tb = tok.tokens(b);
        int ka = Math.max(0, Math.min(ta.size(), maxLength - tb.size() - 3));
        int n = ka + tb.size() + 3;
        long[] ids = new long[n], types = new long[n];
        int k = 0;
        ids[k++] = tok.cls;
        for (int i = 0; i < ka; i++) ids[k++] = ta.get(i);
        ids[k++] = tok.sep;
        for (int x : tb) ids[k++] = x;
        ids[k] = tok.sep;
        for (int i = ka + 2; i < n; i++) types[i] = 1;
        return new long[][]{ids, types};
    }

    /** sigmoid(logit) for the pair (A, B). */
    double prob(String a, String b) throws Exception {
        long[][] enc = encode(a, b);
        long[] mask = new long[enc[0].length];
        java.util.Arrays.fill(mask, 1);
        long[] shape = {1, mask.length};
        try (OnnxTensor ids = OnnxTensor.createTensor(env, LongBuffer.wrap(enc[0]), shape);
             OnnxTensor am = OnnxTensor.createTensor(env, LongBuffer.wrap(mask), shape);
             OnnxTensor tt = OnnxTensor.createTensor(env, LongBuffer.wrap(enc[1]), shape)) {
            java.util.Map<String, OnnxTensor> in = new java.util.HashMap<>(); // not Map.of: minSdk 28
            in.put("input_ids", ids);
            in.put("attention_mask", am);
            in.put("token_type_ids", tt);
            try (OrtSession.Result r = session.run(in)) {
                float z = ((OnnxTensor) r.get("logit").get()).getFloatBuffer().get(0);
                return 1 / (1 + Math.exp(-z));
            }
        }
    }

    @Override public void close() throws Exception { session.close(); }
}
