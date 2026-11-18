package dev.spoilerblock;

import static org.junit.Assert.assertTrue;

import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;

import java.io.File;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.ArrayList;
import java.util.List;

import ai.onnxruntime.OrtEnvironment;
import ai.onnxruntime.OrtSession;

/**
 * Java OCR == src/background/ocr.js recognize() on the same pixels (android/tools/clip-vectors.mjs, ocr* fixtures).
 * Runs on desktop ONNX Runtime 1.32 (task ocrTestDebugUnitTest, see build.gradle.kts).
 */
public class OcrTest {
    private static final File V = new File(System.getProperty("sb.vectors"), "clip");
    private static final File OCR = new File(System.getProperty("sb.dist"), "../models/ocr");

    @Test public void textMatchesExtension() throws Exception {
        JSONArray cases = new JSONArray(new String(Files.readAllBytes(new File(V, "ocr-cases.json").toPath()), StandardCharsets.UTF_8));
        assertTrue(cases.length() >= 10);
        OrtEnvironment env = OrtEnvironment.getEnvironment();
        try (OrtSession.SessionOptions o = Images.cpuOptions();
             Ocr ocr = new Ocr(env.createSession(new File(OCR, "det.onnx").getPath(), o), env.createSession(new File(OCR, "rec.onnx").getPath(), o),
                 new String(Files.readAllBytes(new File(OCR, "dict.txt").toPath()), StandardCharsets.UTF_8))) {
            int same = 0, boxesOff = 0;
            long t0 = System.nanoTime();
            for (int i = 0; i < cases.length(); i++) {
                JSONObject c = cases.getJSONObject(i);
                List<Ocr.Line> lines = new ArrayList<>();
                String text = ocr.text(Files.readAllBytes(new File(V, c.getString("file") + ".rgba").toPath()), c.getInt("width"), c.getInt("height"), lines);
                JSONArray want = c.getJSONArray("lines");
                if (lines.size() != want.length()) boxesOff++;
                else for (int k = 0; k < lines.size(); k++) {
                    JSONArray b = want.getJSONObject(k).getJSONArray("box");
                    for (int q = 0; q < 4; q++) if (Math.abs(lines.get(k).box[q] - b.getLong(q)) > 1) { boxesOff++; k = lines.size(); break; }
                }
                if (text.equals(c.getString("text"))) same++;
                else System.err.println("OCR DIFFERS " + c.getString("file") + "\n  js:   " + c.getString("text").replace('\n', '|') + "\n  java: " + text.replace('\n', '|'));
            }
            System.out.printf("ocr: %d images in %d ms, %d texts identical, %d with other boxes%n", cases.length(), (System.nanoTime() - t0) / 1_000_000, same, boxesOff);
            // ORT 1.32 natively against the extension's WASM 1.22: a probability on the 0.3 / 0.6 edge may move one box or character
            assertTrue("too many texts differ: " + (cases.length() - same), cases.length() - same <= 1);
        }
    }
}
