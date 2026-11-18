package dev.spoilerblock;

import org.json.JSONArray;
import org.json.JSONObject;

import java.math.BigDecimal;
import java.math.RoundingMode;
import java.nio.ByteBuffer;
import java.nio.FloatBuffer;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

import ai.onnxruntime.OnnxTensor;
import ai.onnxruntime.OrtEnvironment;
import ai.onnxruntime.OrtSession;

/**
 * Image verdict of the browser extension (src/background/engine.js clipCheck): the CLIP ViT-B/32 int8 vision model and
 * the shipped int8 text matrix of the 2,000 most popular names (dist data/clip-text.bin + clip-meta.json), with the same
 * media gate, min score, margin and title gap. Not thread-safe; SpoilerBlock runs it on its one worker thread.
 */
final class Clip implements AutoCloseable {
    static final int S = 224;
    static final int UNKNOWN = -1; // a media image whose title is not certain: "May contain a spoiler", never "I've seen"
    private static final float[] MEAN = {0.48145466f, 0.4578275f, 0.40821073f}, STD = {0.26862954f, 0.26130258f, 0.27577711f};

    private final OrtEnvironment env;
    private final OrtSession session;
    private final byte[] mat;
    private final double[][] neg, media;
    final int[] rowGroup;
    private final int[] rowFamily;
    private final int n, dim;
    private final double minScore, margin, mediaGate, titleGap;

    Clip(ByteBuffer model, byte[] textBin, String metaJson) throws Exception {
        JSONObject m = new JSONObject(metaJson);
        n = m.getInt("n");
        dim = m.getInt("dim");
        neg = doubles(m.getJSONArray("neg"));
        media = doubles(m.getJSONArray("media"));
        rowGroup = ints(m.getJSONArray("rowGroup"));
        rowFamily = ints(m.getJSONArray("rowFamily"));
        minScore = m.getDouble("minScore");
        margin = m.getDouble("margin");
        mediaGate = m.getDouble("mediaGate");
        titleGap = m.getDouble("titleGap");
        if (textBin.length != n * dim) throw new IllegalArgumentException("clip-text.bin: " + textBin.length + " bytes, want " + n * dim);
        mat = textBin;
        env = OrtEnvironment.getEnvironment();
        try (OrtSession.SessionOptions o = new OrtSession.SessionOptions()) {
            o.setIntraOpNumThreads(2); // ViT-B/32 is ~4 GFLOP: 2 threads halve the wait for a covered thumbnail
            session = env.createSession(model, o);
        }
    }

    /** Unit image embedding of S*S RGB pixels (row-major, 3 bytes each), preprocessed like engine.js. */
    float[] embed(byte[] rgb) throws Exception {
        float[] x = new float[3 * S * S];
        for (int i = 0; i < S * S; i++) for (int c = 0; c < 3; c++) x[c * S * S + i] = ((rgb[i * 3 + c] & 0xFF) / 255f - MEAN[c]) / STD[c];
        try (OnnxTensor t = OnnxTensor.createTensor(env, FloatBuffer.wrap(x), new long[]{1, 3, S, S});
             OrtSession.Result r = session.run(Collections.singletonMap("pixel_values", t))) {
            OnnxTensor e = (OnnxTensor) r.get("image_embeds").orElseThrow(IllegalStateException::new);
            FloatBuffer b = e.getFloatBuffer();
            float[] v = new float[b.remaining()];
            b.get(v);
            return v;
        }
    }

    /** Hits as {group, score} (best first), or {UNKNOWN, score} for an uncertain title; empty for an ordinary image. */
    List<double[]> check(byte[] rgb) throws Exception { return verdict(embed(rgb)); }

    /** engine.js clipCheck() on a raw (not normalised) embedding; same order of float operations. */
    List<double[]> verdict(float[] v) {
        double n2 = 0;
        for (float a : v) n2 += (double) a * a;
        double inv = 1 / Math.sqrt(n2);
        double ng = -1, md = -1;
        for (double[] t : neg) ng = Math.max(ng, dot(t, v) * inv);
        for (double[] t : media) md = Math.max(md, dot(t, v) * inv);
        List<double[]> scores = new ArrayList<>(); // {row, score rounded like toFixed(3)}
        for (int r = 0; r < n && md - ng >= mediaGate; r++) {
            double s = row(r, v) * (inv / 127);
            if (s >= minScore && s - ng >= margin) scores.add(new double[]{r, new BigDecimal(s).setScale(3, RoundingMode.HALF_UP).doubleValue()});
        }
        List<double[]> hits = new ArrayList<>();
        if (scores.isEmpty()) return hits;
        scores.sort((a, b) -> Double.compare(b[1], a[1])); // stable, like Array.prototype.sort
        int top = (int) scores.get(0)[0];
        double best = scores.get(0)[1], second = -1;
        for (int r = 0; r < n; r++) if (rowFamily[r] != rowFamily[top]) second = Math.max(second, row(r, v) * inv / 127);
        if (best - second >= titleGap) {
            for (int i = 0; i < Math.min(3, scores.size()); i++) hits.add(new double[]{rowGroup[(int) scores.get(i)[0]], scores.get(i)[1]});
        } else {
            hits.add(new double[]{UNKNOWN, best});
        }
        return hits;
    }

    private double row(int r, float[] v) {
        double s = 0;
        int o = r * dim;
        for (int j = 0; j < dim; j++) s += mat[o + j] * (double) v[j];
        return s;
    }

    private double dot(double[] t, float[] v) {
        double s = 0;
        for (int j = 0; j < dim; j++) s += t[j] * v[j];
        return s;
    }

    private static double[][] doubles(JSONArray a) throws Exception {
        double[][] out = new double[a.length()][];
        for (int i = 0; i < out.length; i++) {
            JSONArray r = a.getJSONArray(i);
            out[i] = new double[r.length()];
            for (int j = 0; j < out[i].length; j++) out[i][j] = r.getDouble(j);
        }
        return out;
    }

    private static int[] ints(JSONArray a) throws Exception {
        int[] out = new int[a.length()];
        for (int i = 0; i < out.length; i++) out[i] = a.getInt(i);
        return out;
    }

    @Override public void close() throws Exception { session.close(); }
}
