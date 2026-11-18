package dev.spoilerblock;

import java.nio.FloatBuffer;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

import ai.onnxruntime.OnnxTensor;
import ai.onnxruntime.OrtEnvironment;
import ai.onnxruntime.OrtSession;

/**
 * Text in images: a port of src/background/ocr.js (PP-OCR v5 mobile detector + English recogniser on ONNX Runtime),
 * step for step and with its constants: bilinear resize to the detector's input, DB probability map thresholded into
 * 4-connected boxes, each box cropped, recognised and CTC-decoded, then read in rows. Works on RGBA bytes, so the JVM
 * parity test runs the same code. Not thread-safe; SpoilerBlock runs it on its image worker thread.
 */
final class Ocr implements AutoCloseable {
    static final int DET_MAX = 960, DET_MIN = 384, MIN_BOX = 4, REC_H = 48, REC_MAX_W = 960, SRC_MAX = 1280;
    static final double BIN_THRESH = 0.3, BOX_THRESH = 0.6, UNCLIP = 1.6, MIN_CONF = 0.6;
    private static final double[] DET_MEAN = {0.485, 0.456, 0.406}, DET_STD = {0.229, 0.224, 0.225};
    private static final double[] REC_MEAN = {0.5, 0.5, 0.5}, REC_STD = {0.5, 0.5, 0.5};

    private final OrtSession det, rec;
    private final String[] chars; // recogniser alphabet: class i is chars[i - 1], class 0 the CTC blank
    volatile OrtSession.RunOptions run; // the current run, for the caller's timeout

    Ocr(OrtSession det, OrtSession rec, String dict) {
        this.det = det;
        this.rec = rec;
        chars = dict.split("\n", -1); // like JS split: a trailing newline leaves an empty last entry
    }

    /** One text line: its text, mean character probability and box {x, y, w, h} in image pixels. */
    static final class Line {
        final String text; final double conf; final long[] box;
        Line(String text, double conf, long[] box) { this.text = text; this.conf = conf; this.box = box; }
    }

    /** recognize(): the text, rows joined by newlines; lines (if not null) receives every kept line. */
    String text(byte[] rgba, int W0, int H0, List<Line> lines) throws Exception {
        double s = Math.min(DET_MAX / (double) Math.max(W0, H0), Math.max(1, DET_MIN / (double) Math.min(W0, H0)));
        int dw = (int) Math.max(32, jsRound(W0 * s / 32) * 32), dh = (int) Math.max(32, jsRound(H0 * s / 32) * 32);
        float[] prob = run(det, toTensor(rgba, W0, H0, 0, 0, W0, H0, dw, dh, DET_MEAN, DET_STD, dw), new long[]{1, 3, dh, dw}, null);
        double sx = W0 / (double) dw, sy = H0 / (double) dh;
        List<Line> found = new ArrayList<>();
        for (double[] b : boxes(prob, dw, dh)) {
            double bx = b[0] * sx, by = b[1] * sy, bw = (b[2] - b[0]) * sx, bh = (b[3] - b[1]) * sy;
            int rw = (int) Math.min(REC_MAX_W, Math.max(REC_H, jsRound(REC_H * bw / bh)));
            int outW = (int) Math.ceil(rw / 8.0) * 8;
            long[][] dims = new long[1][];
            float[] p = run(rec, toTensor(rgba, W0, H0, bx, by, bw, bh, rw, REC_H, REC_MEAN, REC_STD, outW), new long[]{1, 3, REC_H, outW}, dims);
            int T = (int) dims[0][1], C = (int) dims[0][2];
            StringBuilder text = new StringBuilder();
            double conf = 0;
            int k = 0, prev = 0;
            for (int ti = 0; ti < T; ti++) {
                int best = 0;
                double bp = -1;
                for (int c = 0; c < C; c++) if (p[ti * C + c] > bp) { bp = p[ti * C + c]; best = c; }
                if (best != 0 && best != prev) { if (best - 1 < chars.length) text.append(chars[best - 1]); conf += bp; k++; }
                prev = best;
            }
            String t = Catalog.jsTrim(text.toString());
            if (!t.isEmpty() && conf / k >= MIN_CONF) found.add(new Line(t, conf / k, new long[]{jsRound(bx), jsRound(by), jsRound(bw), jsRound(bh)}));
        }
        // reading order: rows (vertical centre within half a box height) top to bottom, left to right inside a row
        found.sort((a, b) -> Double.compare(a.box[1] + a.box[3] / 2.0, b.box[1] + b.box[3] / 2.0));
        List<double[]> rowKey = new ArrayList<>(); // {cy, h}
        List<List<Line>> rows = new ArrayList<>();
        for (Line f : found) {
            double cy = f.box[1] + f.box[3] / 2.0;
            int at = -1;
            for (int r = 0; r < rows.size() && at < 0; r++) if (Math.abs(rowKey.get(r)[0] - cy) < Math.min(rowKey.get(r)[1], f.box[3]) / 2.0) at = r;
            if (at >= 0) rows.get(at).add(f);
            else { rowKey.add(new double[]{cy, f.box[3]}); List<Line> l = new ArrayList<>(); l.add(f); rows.add(l); }
        }
        StringBuilder out = new StringBuilder();
        for (List<Line> row : rows) {
            row.sort((a, b) -> Long.compare(a.box[0], b.box[0]));
            if (out.length() > 0) out.append('\n');
            for (int i = 0; i < row.size(); i++) out.append(i > 0 ? " " : "").append(row.get(i).text);
        }
        if (lines != null) lines.addAll(found);
        return out.toString();
    }

    /** Math.round of JS: halves round up (towards +infinity). */
    static long jsRound(double d) { return (long) Math.floor(d + 0.5); }

    /**
     * ocr.js toTensor: bilinear resize of the RGBA region (sx, sy, sw, sh) to dw x dh, as normalised CHW float32 in BGR
     * order (PaddleOCR feeds cv2 BGR images), padded on the right to outW with the normalised value of 0.
     */
    static float[] toTensor(byte[] img, int width, int height, double sx, double sy, double sw, double sh, int dw, int dh,
                            double[] mean, double[] std, int outW) {
        float[] x = new float[3 * dh * outW];
        int plane = dh * outW;
        double fx = sw / dw, fy = sh / dh;
        for (int c = 0; c < 3 && outW > dw; c++) {
            float pad = (float) ((0 - mean[c]) / std[c]);
            for (int y = 0; y < dh; y++) java.util.Arrays.fill(x, c * plane + y * outW + dw, c * plane + (y + 1) * outW, pad);
        }
        for (int y = 0; y < dh; y++) {
            double yy = Math.min(Math.max(sy + (y + 0.5) * fy - 0.5, 0), height - 1);
            int y0 = (int) yy, y1 = Math.min(y0 + 1, height - 1);
            double wy = yy - y0;
            for (int xo = 0; xo < dw; xo++) {
                double xx = Math.min(Math.max(sx + (xo + 0.5) * fx - 0.5, 0), width - 1);
                int x0 = (int) xx, x1 = Math.min(x0 + 1, width - 1);
                double wx = xx - x0;
                int a = (y0 * width + x0) * 4, b = (y0 * width + x1) * 4, c0 = (y1 * width + x0) * 4, d = (y1 * width + x1) * 4;
                for (int c = 0; c < 3; c++) {
                    double v = ((img[a + c] & 0xFF) * (1 - wx) + (img[b + c] & 0xFF) * wx) * (1 - wy)
                        + ((img[c0 + c] & 0xFF) * (1 - wx) + (img[d + c] & 0xFF) * wx) * wy;
                    int ch = 2 - c; // RGB -> BGR
                    x[ch * plane + y * outW + xo] = (float) ((v / 255 - mean[ch]) / std[ch]);
                }
            }
        }
        return x;
    }

    /** ocr.js boxes(): 4-connected components of prob > binThresh, kept by size and mean probability, grown by the DB unclip distance. */
    static List<double[]> boxes(float[] prob, int W, int H) {
        int[] lab = new int[W * H], stack = new int[W * H];
        List<double[]> out = new ArrayList<>();
        int n = 0;
        for (int i = 0; i < W * H; i++) {
            if (lab[i] != 0 || prob[i] <= BIN_THRESH) continue;
            n++;
            int sp = 0, x0 = W, y0 = H, x1 = -1, y1 = -1, cnt = 0;
            double sum = 0;
            stack[sp++] = i;
            lab[i] = n;
            while (sp > 0) {
                int p = stack[--sp], px = p % W, py = p / W;
                sum += prob[p]; cnt++;
                if (px < x0) x0 = px; if (px > x1) x1 = px; if (py < y0) y0 = py; if (py > y1) y1 = py;
                if (px > 0 && lab[p - 1] == 0 && prob[p - 1] > BIN_THRESH) { lab[p - 1] = n; stack[sp++] = p - 1; }
                if (px < W - 1 && lab[p + 1] == 0 && prob[p + 1] > BIN_THRESH) { lab[p + 1] = n; stack[sp++] = p + 1; }
                if (py > 0 && lab[p - W] == 0 && prob[p - W] > BIN_THRESH) { lab[p - W] = n; stack[sp++] = p - W; }
                if (py < H - 1 && lab[p + W] == 0 && prob[p + W] > BIN_THRESH) { lab[p + W] = n; stack[sp++] = p + W; }
            }
            int w = x1 - x0 + 1, h = y1 - y0 + 1;
            if (Math.min(w, h) < MIN_BOX || sum / cnt < BOX_THRESH) continue;
            double d = (w * (double) h * UNCLIP) / (2.0 * (w + h));
            out.add(new double[]{Math.max(0, x0 - d), Math.max(0, y0 - d), Math.min(W, x1 + 1 + d), Math.min(H, y1 + 1 + d)});
        }
        return out;
    }

    private float[] run(OrtSession s, float[] x, long[] shape, long[][] dims) throws Exception {
        OrtEnvironment env = OrtEnvironment.getEnvironment();
        try (OnnxTensor t = OnnxTensor.createTensor(env, FloatBuffer.wrap(x), shape);
             OrtSession.Result r = run == null ? s.run(Collections.singletonMap(s.getInputNames().iterator().next(), t))
                 : s.run(Collections.singletonMap(s.getInputNames().iterator().next(), t), run)) {
            OnnxTensor o = (OnnxTensor) r.get(0);
            if (dims != null) dims[0] = o.getInfo().getShape();
            FloatBuffer b = o.getFloatBuffer();
            float[] v = new float[b.remaining()];
            b.get(v);
            return v;
        }
    }

    @Override public void close() throws Exception {
        det.close();
        rec.close();
    }
}
