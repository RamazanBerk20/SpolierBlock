package dev.spoilerblock;

import org.json.JSONArray;
import org.json.JSONObject;

import java.math.BigDecimal;
import java.math.RoundingMode;
import java.nio.FloatBuffer;
import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import ai.onnxruntime.OnnxTensor;
import ai.onnxruntime.OrtEnvironment;
import ai.onnxruntime.OrtSession;

/**
 * The image title check of src/background/engine.js (titleChecks + verdict): the SigLIP 2 vision tower's embedding of
 * the whole image squashed to size x size, scored against the shipped int8 title rows (dist data/clip-text.bin) with
 * the cut-offs and prompts of data/clip-meta.json, and the optional footage head (meta `foot`) of
 * src/background/image-verdict.js. The session is passed in (CPU or accelerated, see Accel).
 */
final class Clip {
    static final int UNKNOWN = -1; // media with no certain title: "Possible film, show or game image", never "I've seen it"

    final int size, dim, n;
    private final double[] mean, std; // as JS numbers: the tensor gets the float32 of the double result
    final String output;
    private final byte[] mat;
    private final double[][] neg, media;
    final int[] rowGroup;
    private final int[] rowFamily;
    private final double minScore, margin, mediaGate, titleGap;
    private final double[] footW; // footage head: score = w . e + b on the L2-normalised embedding; null: no head in the meta
    private final double footB, footCut;

    Clip(byte[] textBin, String metaJson) throws Exception {
        JSONObject m = new JSONObject(metaJson);
        size = m.getInt("size");
        dim = m.getInt("dim");
        n = m.getInt("n");
        output = m.getString("output");
        mean = doubles(new JSONArray().put(m.getJSONArray("mean")))[0];
        std = doubles(new JSONArray().put(m.getJSONArray("std")))[0];
        neg = doubles(m.getJSONArray("neg"));
        media = doubles(m.getJSONArray("media"));
        rowGroup = ints(m.getJSONArray("rowGroup"));
        rowFamily = ints(m.getJSONArray("rowFamily"));
        minScore = m.getDouble("minScore");
        margin = m.getDouble("margin");
        mediaGate = m.getDouble("mediaGate");
        titleGap = m.getDouble("titleGap");
        JSONObject f = m.optJSONObject("foot");
        footW = f == null ? null : doubles(new JSONArray().put(f.getJSONArray("w")))[0];
        footB = f == null ? 0 : f.getDouble("b");
        footCut = f == null ? 0 : f.getDouble("cut");
        if (footW != null && footW.length != dim) throw new IllegalArgumentException("clip-meta.json foot.w: " + footW.length + " numbers, want " + dim);
        if (textBin.length != n * dim) throw new IllegalArgumentException("clip-text.bin: " + textBin.length + " bytes, want " + n * dim);
        mat = textBin;
    }

    /** Raw embeddings (not normalised) of images of size*size RGB pixels (row-major, 3 bytes each), one run for all. */
    float[][] embed(OrtSession s, List<byte[]> rgbs) throws Exception {
        int P = size * size, B = rgbs.size();
        float[] x = new float[B * 3 * P];
        for (int b = 0; b < B; b++) {
            byte[] px = rgbs.get(b);
            for (int i = 0; i < P; i++) for (int c = 0; c < 3; c++) x[(b * 3 + c) * P + i] = (float) (((px[i * 3 + c] & 0xFF) / 255.0 - mean[c]) / std[c]);
        }
        OrtEnvironment env = OrtEnvironment.getEnvironment();
        String in = s.getInputNames().iterator().next();
        try (OnnxTensor t = OnnxTensor.createTensor(env, FloatBuffer.wrap(x), new long[]{B, 3, size, size});
             OrtSession.Result r = s.run(Collections.singletonMap(in, t))) {
            FloatBuffer o = ((OnnxTensor) r.get(output).orElseThrow(IllegalStateException::new)).getFloatBuffer();
            float[][] out = new float[B][dim];
            for (int b = 0; b < B; b++) o.get(out[b]);
            return out;
        }
    }

    /**
     * image-verdict.js scores() + verdict(): hits as {group, score} (best first, up to 3 groups of one title family), {UNKNOWN, score}
     * for media with no certain title, empty for an ordinary image. Scores are float32 like the JS Float32Array.
     */
    List<double[]> verdict(float[] v) {
        double n2 = 0;
        for (float a : v) n2 += (double) a * a;
        double inv = 1 / Math.sqrt(n2);
        double ng = best(neg, v, inv), md = best(media, v, inv) - ng;
        double foot = footW == null ? Double.NaN : dot(footW, v, inv) + footB;
        float[] sc = new float[n];
        int top = 0;
        for (int r = 0; r < n; r++) {
            double s = 0;
            int o = r * dim;
            for (int j = 0; j < dim; j++) s += mat[o + j] * (double) v[j];
            sc[r] = (float) ((s * inv) / 127);
            if (sc[r] > sc[top]) top = r;
        }
        double second = -1;
        for (int r = 0; r < n; r++) if (rowFamily[r] != rowFamily[top] && sc[r] > second) second = sc[r];
        double mg = sc[top] - ng, gap = sc[top] - second;
        List<double[]> hits = new ArrayList<>();
        if (sc[top] >= minScore && mg >= margin && gap >= titleGap) {
            List<Integer> rows = new ArrayList<>();
            for (int r = 0; r < n; r++) if (sc[r] - ng >= margin && sc[top] - sc[r] < gap) rows.add(r);
            rows.sort((a, b) -> Float.compare(sc[b], sc[a])); // stable, like Array.prototype.sort
            Map<Integer, Double> groups = new LinkedHashMap<>(); // new Map(...): first position, last value per group
            for (int r : rows) groups.put(rowGroup[r], fixed3(sc[r]));
            for (Map.Entry<Integer, Double> e : groups.entrySet()) if (hits.size() < 3) hits.add(new double[]{e.getKey(), e.getValue()});
        } else if (md >= mediaGate || (footW != null && foot >= footCut)) { // media-looking (posters, stills) or footage of a made work
            hits.add(new double[]{UNKNOWN, fixed3(sc[top])});
        }
        return hits;
    }

    /** The footage head's score of a raw embedding, as in verdict(); NaN when the meta has no head. */
    double foot(float[] v) {
        if (footW == null) return Double.NaN;
        double n2 = 0;
        for (float a : v) n2 += (double) a * a;
        return dot(footW, v, 1 / Math.sqrt(n2)) + footB;
    }

    /** Number.prototype.toFixed(3), back to a number. */
    static double fixed3(double d) { return new BigDecimal(d).setScale(3, RoundingMode.HALF_UP).doubleValue(); }

    private double best(double[][] vs, float[] v, double inv) {
        double m = -1;
        for (double[] t : vs) m = Math.max(m, dot(t, v, inv));
        return m;
    }

    private double dot(double[] t, float[] v, double inv) {
        double s = 0;
        for (int j = 0; j < dim; j++) s += t[j] * v[j];
        return s * inv;
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
}
