package dev.spoilerblock;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;

import java.io.File;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.Map;
import java.util.TreeMap;

/** Java tokenizer and classifier == the extension's (transformers.js + onnxruntime-web) on android/tools/spoiler-vectors.mjs. */
public class ClassifierTest {
    private static final File V = new File(System.getProperty("sb.vectors"));
    private static final File MODEL = new File(System.getProperty("sb.model"));

    private static String read(File f) throws Exception { return new String(Files.readAllBytes(f.toPath()), StandardCharsets.UTF_8); }

    @Test public void tokenIdsMatchTransformersJs() throws Exception {
        WordPiece tok = new WordPiece(read(new File(MODEL, "tokenizer.json")));
        JSONArray cases = new JSONArray(read(new File(V, "spoiler-tokens.json")));
        assertTrue(cases.length() > 300);
        int failures = 0;
        for (int i = 0; i < cases.length(); i++) {
            JSONObject c = cases.getJSONObject(i);
            JSONArray want = c.getJSONArray("ids");
            long[] got = tok.encode(c.getString("text"), 64);
            boolean same = got.length == want.length();
            for (int j = 0; same && j < got.length; j++) same = got[j] == want.getLong(j);
            if (!same && ++failures <= 20) System.err.println("MISMATCH " + c.getString("text") + "\n  js=" + want + "\n  java=" + java.util.Arrays.toString(got));
        }
        System.out.println("tokenizer: " + cases.length() + " strings, " + failures + " mismatches");
        assertEquals(0, failures);
    }

    @Test public void verdictsMatchExtension() throws Exception {
        byte[] model = Files.readAllBytes(new File(MODEL, "model_int8.onnx").toPath());
        ByteBuffer buf = ByteBuffer.allocateDirect(model.length).put(model);
        buf.flip();
        JSONObject d = new JSONObject(read(new File(V, "spoiler-eval.json")));
        JSONArray cases = d.getJSONArray("cases");
        assertEquals(300, cases.length());
        try (Classifier c = new Classifier(buf, read(new File(MODEL, "tokenizer.json")), read(new File(MODEL, "meta.json")))) {
            assertEquals(d.getDouble("threshold"), c.threshold, 0);
            int differ = 0;
            double maxDiff = 0, sumDiff = 0;
            Map<String, int[]> byKind = new TreeMap<>();
            long t0 = System.nanoTime();
            for (int i = 0; i < cases.length(); i++) {
                JSONObject e = cases.getJSONObject(i);
                double js = e.getDouble("p"), java = c.prob(e.getString("text"));
                double diff = Math.abs(js - java);
                maxDiff = Math.max(maxDiff, diff);
                sumDiff += diff;
                boolean vj = java >= c.threshold, vs = js >= c.threshold;
                int[] k = byKind.computeIfAbsent(e.getString("kind"), x -> new int[2]);
                if (vj) k[0]++;
                k[1]++;
                if (vj != vs) {
                    differ++;
                    System.err.println("VERDICT DIFFERS js=" + js + " java=" + java + " " + e.getString("text"));
                    // ORT's x86-64 AVX2 int8 kernels round differently from WASM; a flip is tolerated only next to the threshold
                    assertTrue("verdict flipped far from the threshold", Math.abs(js - c.threshold) < 0.05);
                }
            }
            StringBuilder s = new StringBuilder();
            for (Map.Entry<String, int[]> k : byKind.entrySet()) s.append(" ").append(k.getKey()).append(" ").append(k.getValue()[0]).append("/").append(k.getValue()[1]);
            System.out.printf("classifier: 300 posts in %d ms, flagged by kind:%s; %d verdicts differ; |p_java - p_js| max %.2e mean %.2e%n",
                (System.nanoTime() - t0) / 1_000_000, s, differ, maxDiff, sumDiff / cases.length());
            // measured on x86-64 (AVX2): 0.2.3 model 2 of 300 flip, max 0.072, mean 0.004; the retrained model 1 flip,
            // max 0.163 (one sentence on the steep part of the sigmoid), mean 0.0017. A port bug moves the mean, not one post.
            assertTrue("too many verdicts differ: " + differ, differ <= 3);
            assertTrue("probabilities drift from the extension's: max " + maxDiff, maxDiff < 0.2 && sumDiff / cases.length() < 0.01);
        }
    }

    @Test public void sentencesLikeTheExtension() {
        assertEquals(java.util.Arrays.asList("Joel dies.", "Ellie cries!", "what"),
            Classifier.sentences("Joel dies. Ellie cries!\n\nwhat\n@gus\nok @a_b"));
        assertEquals(0, Classifier.sentences("@gus @x lol").size());
    }
}
