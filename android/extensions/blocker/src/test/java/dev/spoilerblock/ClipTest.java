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
import java.util.List;

/**
 * Java image verdict == the extension's (engine.js clipCheck, onnxruntime-web) on the pixels android/tools/clip-vectors.mjs
 * wrote for test/fixtures/images, on the shared pixels: model run + verdict rule. Decoding and Images.clipPixels are
 * compared on the device by the demo app's ImageEval (javax.imageio mangles grayscale and ICC-tagged JPEGs, so not here).
 */
public class ClipTest {
    private static final File V = new File(System.getProperty("sb.vectors"), "clip");
    private static final File DIST = new File(System.getProperty("sb.dist"));
    private static final File MODEL = new File(System.getProperty("sb.dist"), "../models/clip/onnx/vision_model_quantized.onnx");

    static String kind(List<double[]> hits) { return hits.isEmpty() ? "none" : hits.get(0)[0] == Clip.UNKNOWN ? "generic" : "title " + (int) hits.get(0)[0]; }

    @Test public void verdictsMatchExtension() throws Exception {
        byte[] model = Files.readAllBytes(MODEL.toPath());
        ByteBuffer buf = ByteBuffer.allocateDirect(model.length).put(model);
        buf.flip();
        JSONArray cases = new JSONArray(new String(Files.readAllBytes(new File(V, "clip-cases.json").toPath()), StandardCharsets.UTF_8));
        assertEquals(75, cases.length());
        try (Clip clip = new Clip(buf, Files.readAllBytes(new File(DIST, "clip-text.bin").toPath()),
            new String(Files.readAllBytes(new File(DIST, "clip-meta.json").toPath()), StandardCharsets.UTF_8))) {
            int differ = 0;
            double maxCos = 0;
            long t0 = System.nanoTime();
            for (int i = 0; i < cases.length(); i++) {
                JSONObject c = cases.getJSONObject(i);
                float[] v = clip.embed(Files.readAllBytes(new File(V, c.getString("file") + ".rgb").toPath()));
                double n = 0, dotJs = 0;
                for (float a : v) n += (double) a * a;
                JSONArray e = c.getJSONArray("embed");
                for (int j = 0; j < v.length; j++) dotJs += v[j] / Math.sqrt(n) * e.getDouble(j);
                maxCos = Math.max(maxCos, 1 - dotJs);
                List<double[]> hits = clip.verdict(v);
                JSONArray want = c.getJSONArray("hits");
                String js = want.length() == 0 ? "none" : want.getJSONArray(0).getInt(0) == -1 ? "generic" : "title " + want.getJSONArray(0).getInt(0);
                if (!js.equals(kind(hits))) {
                    differ++;
                    System.err.println("VERDICT DIFFERS " + c.getString("file") + " js=" + js + " java=" + kind(hits));
                }
            }
            System.out.printf("clip: %d images in %d ms, %d verdicts differ, embedding 1-cos max %.2e%n", cases.length(),
                (System.nanoTime() - t0) / 1_000_000, differ, maxCos);
            // ORT's x86-64 AVX2 int8 kernels round slightly differently from WASM (see ClassifierTest)
            assertTrue("too many verdicts differ: " + differ, differ <= 2);

        }
    }
}
