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
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;

/**
 * The title-in-context model's Java port == the extension's on android/tools/context-vectors.mjs: the same unsure
 * names, the same segments A and B, the same token ids and types, and probabilities as close as ClassifierTest's.
 */
public class ContextClassifierTest {
    private static final File V = new File(System.getProperty("sb.vectors"));
    private static final File DIST = new File(System.getProperty("sb.dist"));
    private static final File MODEL = new File(System.getProperty("sb.context"));

    private static String read(File f) throws Exception { return new String(Files.readAllBytes(f.toPath()), StandardCharsets.UTF_8); }

    private static long[] longs(JSONArray a) throws Exception {
        long[] r = new long[a.length()];
        for (int i = 0; i < r.length; i++) r[i] = a.getLong(i);
        return r;
    }

    @Test public void windowRule() {
        assertEquals("i saw <Lost>", ContextClassifier.windowText("i saw Lost", 6, 10));
        String x = new String(new char[150]).replace('\0', 'x') + " alpha beta Heat gamma delta " + new String(new char[150]).replace('\0', 'y');
        int s = x.indexOf("Heat");
        assertEquals("alpha beta <Heat> gamma delta", ContextClassifier.windowText(x, s, s + 4));
        assertEquals("a b <Up> c", ContextClassifier.windowText("a\n\nb  Up\tc", 6, 8));
    }

    @Test public void matchesExtension() throws Exception {
        Matcher m = new Matcher(Files.readAllBytes(new File(DIST, "index.bin").toPath()), read(new File(DIST, "index.json")));
        JSONObject d = new JSONObject(read(new File(V, "context-cases.json")));
        JSONArray cases = d.getJSONArray("cases");
        byte[] model = Files.readAllBytes(new File(MODEL, "model_int8.onnx").toPath());
        ByteBuffer buf = ByteBuffer.allocateDirect(model.length).put(model);
        buf.flip();
        try (ContextClassifier c = new ContextClassifier(buf, read(new File(MODEL, "tokenizer.json")), read(new File(MODEL, "meta.json")))) {
            assertEquals(d.getDouble("threshold"), c.threshold, 0);
            assertEquals(d.getDouble("thresholdOther"), c.thresholdOther, 0);
            assertEquals(d.getInt("maxLength"), c.maxLength);
            int mismatches = 0, pairs = 0, differ = 0, truncated = 0;
            double maxDiff = 0, sumDiff = 0;
            String worst = "";
            long ns = 0;
            for (int i = 0; i < cases.length(); i++) {
                JSONObject k = cases.getJSONObject(i);
                String text = k.getString("text");
                List<int[]> unsure = new ArrayList<>();
                m.evaluate(text, new boolean[m.ids.length], unsure);
                List<String> got = new ArrayList<>(), want = new ArrayList<>();
                for (int[] u : unsure) got.add(Arrays.toString(u));
                JSONArray ju = k.getJSONArray("unsure");
                for (int j = 0; j < ju.length(); j++) want.add(Arrays.toString(longs(ju.getJSONArray(j))));
                JSONArray jp = k.getJSONArray("pairs");
                for (int j = 0; j < jp.length() && j < unsure.size(); j++) {
                    JSONObject p = jp.getJSONObject(j);
                    int[] u = unsure.get(j);
                    String a = ContextClassifier.windowText(text, u[1], u[2]), b = ContextClassifier.workText(m, u[0]);
                    long[][] enc = c.encode(a, b);
                    got.add(a + " | " + b + " | " + Arrays.toString(enc[0]) + Arrays.toString(enc[1]));
                    want.add(p.getString("a") + " | " + p.getString("b") + " | " + Arrays.toString(longs(p.getJSONArray("ids"))) + Arrays.toString(longs(p.getJSONArray("types"))));
                    if (enc[0].length == c.maxLength) truncated++;
                    long t0 = System.nanoTime();
                    double pj = c.prob(a, b), js = p.getDouble("p");
                    ns += System.nanoTime() - t0;
                    pairs++;
                    double diff = Math.abs(pj - js);
                    if (diff > maxDiff) worst = String.format(java.util.Locale.ROOT, "js %.3f java %.3f: %s | %s", js, pj, a, b);
                    maxDiff = Math.max(maxDiff, diff);
                    sumDiff += diff;
                    double th = u[3] == 1 ? c.thresholdOther : c.threshold;
                    if (pj >= th != js >= th) {
                        differ++;
                        System.err.println("ANSWER DIFFERS js=" + js + " java=" + pj + " " + a + " | " + b);
                        // ORT's x86-64 int8 kernels round differently from WASM (see ClassifierTest)
                        assertTrue("answer flipped far from the threshold", Math.abs(js - th) < 0.05);
                    }
                }
                if (!got.equals(want) && ++mismatches <= 20) System.err.println("MISMATCH " + text + "\n  js=" + want + "\n  java=" + got);
            }
            System.out.printf("context: %d texts, %d pairs (%d at maxLength), %d mismatches, %d answers differ; |p_java - p_js| max %.2e mean %.2e; %.1f ms per pair%n",
                cases.length(), pairs, truncated, mismatches, differ, maxDiff, sumDiff / Math.max(1, pairs), ns / 1e6 / Math.max(1, pairs));
            System.out.println("context: largest gap " + worst);
            assertTrue("too few pairs: " + pairs, pairs >= 100);
            assertEquals(0, mismatches);
            assertTrue("too many answers differ: " + differ, differ <= 3);
            assertTrue("probabilities drift from the extension's: max " + maxDiff, maxDiff < 0.2 && sumDiff / pairs < 0.01);
        }
    }
}
