package dev.spoilerblock;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;

import java.io.File;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.Collections;
import java.util.List;

import ai.onnxruntime.OrtEnvironment;
import ai.onnxruntime.OrtSession;

/**
 * Java title check == the extension's (engine.js, onnxruntime-web) on test/fixtures/images, from the vectors of
 * android/tools/clip-vectors.mjs: (1) on the extension's own 256x256 pixels (model run + verdict rule), (2) from the
 * picture at <= 512 px through Java's own resize (Images.visionPixels), against the extension's pixels' verdict.
 */
public class ClipTest {
    private static final File V = new File(System.getProperty("sb.vectors"), "clip");
    private static final File DIST = new File(System.getProperty("sb.dist")); // dist/firefox/data

    static String kind(List<double[]> hits) { return Images.kind(hits); }

    @Test public void verdictsMatchExtension() throws Exception {
        JSONArray cases = new JSONArray(new String(Files.readAllBytes(new File(V, "clip-cases.json").toPath()), StandardCharsets.UTF_8));
        assertTrue(cases.length() >= 70);
        Clip clip = new Clip(Files.readAllBytes(new File(DIST, "clip-text.bin").toPath()),
            new String(Files.readAllBytes(new File(DIST, "clip-meta.json").toPath()), StandardCharsets.UTF_8));
        try (OrtSession.SessionOptions o = Images.cpuOptions();
             OrtSession s = OrtEnvironment.getEnvironment().createSession(new File(DIST, "../models/vision/model.onnx").getPath(), o)) {
            int differ = 0, differResize = 0;
            double worst = 0, worstResize = 0, worstScore = 0;
            long t0 = System.nanoTime();
            for (int i = 0; i < cases.length(); i++) {
                JSONObject c = cases.getJSONObject(i);
                String js = Images.kindJs(c.getJSONArray("hits"));
                float[] v = clip.embed(s, Collections.singletonList(Files.readAllBytes(new File(V, c.getString("file") + ".rgb").toPath())))[0];
                worst = Math.max(worst, 1 - cos(v, c.getJSONArray("embed")));
                List<double[]> hits = clip.verdict(v);
                if (!js.equals(kind(hits))) { differ++; System.err.println("VERDICT DIFFERS " + c.getString("file") + " js=" + js + " java=" + kind(hits)); }
                else if (!hits.isEmpty()) worstScore = Math.max(worstScore, Math.abs(hits.get(0)[1] - c.getJSONArray("hits").getJSONArray(0).getDouble(1)));

                // Java's resize, from the picture at <= 512 px
                byte[] src = Files.readAllBytes(new File(V, c.getString("file") + ".src.rgba").toPath());
                int w = c.getInt("srcW"), h = c.getInt("srcH");
                int[] argb = new int[w * h];
                for (int p = 0; p < argb.length; p++) argb[p] = 0xFF000000 | (src[p * 4] & 0xFF) << 16 | (src[p * 4 + 1] & 0xFF) << 8 | src[p * 4 + 2] & 0xFF;
                float[] vr = clip.embed(s, Collections.singletonList(Images.visionPixels(argb, w, h, clip.size)))[0];
                worstResize = Math.max(worstResize, 1 - cos(vr, c.getJSONArray("embed")));
                String jr = kind(clip.verdict(vr));
                if (!js.equals(jr)) { differResize++; System.err.println("RESIZED VERDICT DIFFERS " + c.getString("file") + " js=" + js + " java=" + jr); }
            }
            System.out.printf("image titles: %d images in %d ms; extension's pixels: %d verdicts differ, embedding 1-cos max %.1e, top score max diff %.3f; " +
                "Java resize: %d differ, 1-cos max %.1e%n", cases.length(), (System.nanoTime() - t0) / 1_000_000, differ, worst, worstScore, differResize, worstResize);
            // the same model on ORT 1.32's native x86-64 kernels against the extension's WASM 1.22: measured 1-cos 1.5e-3,
            // top scores within 0.002 (the cut-offs' smallest step is 0.0275 apart)
            assertEquals("verdicts differ on the extension's own pixels", 0, differ);
            assertTrue("embedding drifted: 1-cos " + worst, worst < 5e-3);
            // another resize (triangle filter vs sharp's lanczos3): a borderline image may flip
            assertTrue("too many verdicts differ after Java's resize: " + differResize, differResize <= 3);
        }
    }

    static double cos(float[] v, JSONArray unit) throws Exception {
        double n = 0, d = 0;
        for (float a : v) n += (double) a * a;
        for (int j = 0; j < v.length; j++) d += v[j] * unit.getDouble(j);
        return d / Math.sqrt(n);
    }
}
