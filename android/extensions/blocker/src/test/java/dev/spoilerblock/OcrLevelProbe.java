package dev.spoilerblock;

import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;

import java.io.File;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;

import ai.onnxruntime.OrtEnvironment;
import ai.onnxruntime.OrtSession;

/** Temporary probe: OCR texts per detector optimisation level (and NCHWc off), on whatever ORT version the tests use. */
public class OcrLevelProbe {
    @Test public void levels() throws Exception {
        File v = new File(System.getProperty("sb.vectors"), "clip"), m = new File(System.getProperty("sb.dist"), "../models/ocr");
        JSONArray cases = new JSONArray(new String(Files.readAllBytes(new File(v, "ocr-cases.json").toPath()), StandardCharsets.UTF_8));
        OrtEnvironment env = OrtEnvironment.getEnvironment();
        Object[][] configs = {
            {"NO_OPT", OrtSession.SessionOptions.OptLevel.NO_OPT, false},
            {"BASIC_OPT", OrtSession.SessionOptions.OptLevel.BASIC_OPT, false},
            {"EXTENDED_OPT", OrtSession.SessionOptions.OptLevel.EXTENDED_OPT, false},
            {"ALL_OPT", OrtSession.SessionOptions.OptLevel.ALL_OPT, false},
            {"ALL_OPT, NchwcTransformer off", OrtSession.SessionOptions.OptLevel.ALL_OPT, true},
            {"NO_OPT, 1 thread, no arena", OrtSession.SessionOptions.OptLevel.NO_OPT, null},
        };
        for (Object[] cfg : configs) {
            try (OrtSession.SessionOptions od = new OrtSession.SessionOptions(); OrtSession.SessionOptions or = Images.cpuOptions()) {
                od.setOptimizationLevel((OrtSession.SessionOptions.OptLevel) cfg[1]);
                if (Boolean.TRUE.equals(cfg[2])) od.addConfigEntry("optimization.disable_specified_optimizers", "NchwcTransformer");
                if (cfg[2] == null) { od.setIntraOpNumThreads(1); od.setCPUArenaAllocator(false); }
                else od.setIntraOpNumThreads(Images.threads());
                try (Ocr ocr = new Ocr(env.createSession(new File(m, "det.onnx").getPath(), od), env.createSession(new File(m, "rec.onnx").getPath(), or),
                    new String(Files.readAllBytes(new File(m, "dict.txt").toPath()), StandardCharsets.UTF_8))) {
                    int same = 0;
                    long t0 = System.nanoTime();
                    for (int i = 0; i < cases.length(); i++) {
                        JSONObject c = cases.getJSONObject(i);
                        if (ocr.text(Files.readAllBytes(new File(v, c.getString("file") + ".rgba").toPath()), c.getInt("width"), c.getInt("height"), null)
                            .equals(c.getString("text"))) same++;
                    }
                    System.out.printf("PROBE %s: %d/%d texts identical, %d ms%n", cfg[0], same, cases.length(), (System.nanoTime() - t0) / 1_000_000);
                }
            }
        }
    }
}
