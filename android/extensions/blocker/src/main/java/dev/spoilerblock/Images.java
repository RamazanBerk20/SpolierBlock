package dev.spoilerblock;

import android.graphics.Bitmap;
import android.graphics.Canvas;
import android.graphics.HardwareRenderer;
import android.graphics.PixelFormat;
import android.graphics.RecordingCanvas;
import android.graphics.RenderNode;
import android.graphics.drawable.BitmapDrawable;
import android.graphics.drawable.ColorDrawable;
import android.graphics.drawable.Drawable;
import android.hardware.HardwareBuffer;
import android.media.Image;
import android.media.ImageReader;
import android.os.Build;
import android.os.SystemClock;
import android.util.Log;
import android.view.View;
import android.view.ViewGroup;
import android.widget.ImageView;

import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.nio.ByteBuffer;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.WeakHashMap;
import java.util.zip.GZIPInputStream;

/**
 * "Scan images and video": finds the media views of a feed item (ImageViews of at least 96 dp, as the extension skips
 * smaller images), captures what they draw and judges it like the extension does (CLIP title/media verdict + OCR text
 * that goes through the matcher with the post's text). Capture: the view's own display list is recorded into a
 * RenderNode and rendered off screen by a HardwareRenderer into an ImageReader, which works for hardware bitmaps and
 * any drawable type, and leaves out the cover (it lives in the item's overlay, not in the media view).
 * Main thread: candidates, states, capture. One worker thread: model loading, CLIP, OCR.
 */
final class Images {
    private static final int MIN_DP = 96, MAX_SIDE = 768, QUEUE = 8;
    static final String TAG = SpoilerBlock.TAG;

    /** Verdict of one media view for one drawable (main thread). */
    static final class State {
        final long key;
        boolean done, failed;
        List<double[]> hits = new ArrayList<>();
        String ocr = "";
        State(long key) { this.key = key; }
    }

    private final SpoilerBlock sb;
    private final Map<View, State> states = new WeakHashMap<>();
    private final ArrayDeque<Job> jobs = new ArrayDeque<>(); // guarded by itself; newest first (just scrolled in)
    private Thread worker;
    private final float density;
    // worker thread only
    private Clip clip;
    private Ocr ocr;
    private boolean loadFailed;
    private java.util.concurrent.ScheduledExecutorService watchdog;
    private Matcher mappedFor;
    private int[] fromBundled; // CLIP groups name the bundled index; an updated catalog maps them (as the extension does)
    private final Map<Long, Object[]> byPixels = new LinkedHashMap<Long, Object[]>(64, 0.75f, true) { // pixel hash -> {hits, ocr}
        @Override protected boolean removeEldestEntry(Map.Entry<Long, Object[]> e) { return size() > 500; }
    };
    volatile long stClip, stClipN, stOcr, stOcrN; // for the log (worker writes, main reads)
    private long stCapture, stCaptureN, stCaptureMax;

    /** ", N captures (avg/max ms), clip/ocr averages" since the last call; "" when nothing was captured. Main thread. */
    String stats() {
        if (stCaptureN == 0) return "";
        String s = ", " + stCaptureN + " image captures (avg " + stCapture / stCaptureN + " ms, max " + stCaptureMax + " ms)" +
            (stClipN > 0 ? ", clip avg " + stClip / stClipN + " ms, ocr avg " + stOcr / Math.max(1, stOcrN) + " ms (" + stClipN + " images)" : "");
        stCapture = stCaptureN = stCaptureMax = 0;
        stClip = stClipN = stOcr = stOcrN = 0;
        return s;
    }

    private static final class Job {
        final View view; final State state; final Bitmap bmp;
        Job(View view, State state, Bitmap bmp) { this.view = view; this.state = state; this.bmp = bmp; }
    }

    Images(SpoilerBlock sb) {
        this.sb = sb;
        density = sb.app.getResources().getDisplayMetrics().density;
    }

    /** Media views of an item (nested lists excluded: their children are items of their own). */
    void candidates(View v, Scanner sc, List<View> out, boolean root) {
        if (v.getVisibility() != View.VISIBLE) return;
        if (!root && v instanceof ViewGroup && sc.isList((ViewGroup) v)) return;
        if (v instanceof ImageView && v.getWidth() >= MIN_DP * density && v.getHeight() >= MIN_DP * density) {
            Drawable d = ((ImageView) v).getDrawable();
            if (d != null && !(d instanceof ColorDrawable)) { out.add(v); return; }
        }
        if (v instanceof ViewGroup) {
            ViewGroup g = (ViewGroup) v;
            for (int i = 0; i < g.getChildCount(); i++) candidates(g.getChildAt(i), sc, out, false);
        }
    }

    /** What the view shows: its drawable (and the bitmap inside one) and size. Also part of the item fingerprint. */
    static long key(View v) {
        long h = v.getWidth() * 8191L + v.getHeight();
        if (v instanceof ImageView) {
            Drawable d = ((ImageView) v).getDrawable();
            if (d != null) {
                h = h * 31 + System.identityHashCode(d);
                h = h * 31 + System.identityHashCode(d.getCurrent());
                // a wrapper that swaps its image in place (Fresco's drawee in X) reports the new image's size
                // shortcut: an in-place swap to an image of the same size keeps the old verdict; re-capture on a timer if an app does that
                h = h * 31 + d.getIntrinsicWidth() * 65537L + d.getIntrinsicHeight();
                if (d instanceof BitmapDrawable && ((BitmapDrawable) d).getBitmap() != null) {
                    Bitmap b = ((BitmapDrawable) d).getBitmap();
                    h = h * 31 + System.identityHashCode(b);
                    h = h * 31 + b.getGenerationId();
                }
            }
        }
        return h;
    }

    /** The verdict for what the view shows now, requesting it (capture + queue) when there is none yet. Main thread. */
    State state(View v) {
        long k = key(v);
        State s = states.get(v);
        if (s != null && s.key == k) return s;
        State st = new State(k);
        if (capturedThisFrame) { // one capture per frame (a second one would be dropped by the renderer): the rest next frame
            if (!retryPosted) { retryPosted = true; sb.main.postDelayed(this::retry, 16); }
            return st; // pending, not stored: requested again on the next judge
        }
        capturedThisFrame = true;
        states.put(v, st);
        long t0 = SystemClock.uptimeMillis();
        try {
            capture(v, b -> enqueue(new Job(v, st, b)));
        } catch (FrameDropped e) {
            states.remove(v);
            if (!retryPosted) { retryPosted = true; sb.main.postDelayed(this::retry, 16); }
        } catch (Throwable t) {
            Log.w(TAG, "capture of " + v.getClass().getName() + " failed, item stays covered", t);
            st.done = st.failed = true;
        }
        long dt = SystemClock.uptimeMillis() - t0;
        stCapture += dt; stCaptureN++; stCaptureMax = Math.max(stCaptureMax, dt);
        return st;
    }

    private void retry() { retryPosted = false; sb.invalidateAll(); } // a new frame: only items with pending images are judged again

    private void enqueue(Job j) { // any thread
        synchronized (jobs) {
            jobs.addFirst(j);
            while (jobs.size() > QUEUE) { // a fling: forget the oldest; still on screen, it is captured again on its next judge
                Job old = jobs.removeLast();
                sb.main.post(() -> { if (states.get(old.view) == old.state && !old.state.done) states.remove(old.view); });
            }
            if (worker == null) {
                worker = new Thread(this::work, "SpoilerBlock-images");
                worker.start();
            }
            jobs.notifyAll();
        }
    }

    /** Drops every model (switch turned off). */
    void release() {
        synchronized (jobs) { // null job: the worker closes the models (none loaded when it never ran)
            jobs.clear();
            if (worker != null) { jobs.add(new Job(null, null, null)); jobs.notifyAll(); }
        }
        states.clear();
    }

    // ---------- capture (main thread; the pixels arrive on the capture thread) ----------

    private void capture(View v, java.util.function.Consumer<Bitmap> done) {
        int w = v.getWidth(), h = v.getHeight();
        float s = Math.min(1f, MAX_SIDE / (float) Math.max(w, h));
        int bw = Math.max(1, Math.round(w * s)), bh = Math.max(1, Math.round(h * s));
        Drawable d = ((ImageView) v).getDrawable();
        // Android 9 draws in software (hardware bitmaps then fail closed); so does an animated image, whose native frame
        // clock lives on the render thread of whichever renderer draws it
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q || d.getCurrent() instanceof android.graphics.drawable.AnimatedImageDrawable) {
            Bitmap b = Bitmap.createBitmap(bw, bh, Bitmap.Config.ARGB_8888);
            Canvas c = new Canvas(b);
            c.scale(s, s);
            drawContent((ImageView) v, c);
            done.accept(b);
            return;
        }
        if (renderer == null) { // one off-screen renderer for every capture: creating one costs a new GPU surface
            thread = new android.os.HandlerThread("SpoilerBlock-capture");
            thread.start();
            reader = ImageReader.newInstance(MAX_SIDE, MAX_SIDE, PixelFormat.RGBA_8888, 3,
                HardwareBuffer.USAGE_GPU_COLOR_OUTPUT | HardwareBuffer.USAGE_GPU_SAMPLED_IMAGE | HardwareBuffer.USAGE_CPU_READ_OFTEN);
            ArrayDeque<Object[]> order = pending; // frames come out in the order they were drawn
            reader.setOnImageAvailableListener(r -> {
                Object[] want;
                synchronized (order) { want = order.pollFirst(); }
                try (Image img = r.acquireNextImage()) {
                    if (want == null || img == null) return;
                    Image.Plane p = img.getPlanes()[0];
                    Bitmap b = Bitmap.createBitmap(p.getRowStride() / p.getPixelStride(), MAX_SIDE, Bitmap.Config.ARGB_8888);
                    b.copyPixelsFromBuffer(p.getBuffer());
                    @SuppressWarnings("unchecked") java.util.function.Consumer<Bitmap> cb = (java.util.function.Consumer<Bitmap>) want[2];
                    cb.accept(Bitmap.createBitmap(b, 0, 0, (int) want[0], (int) want[1]));
                } catch (Throwable t) {
                    Log.w(TAG, "capture readback failed: " + t);
                }
            }, new android.os.Handler(thread.getLooper()));
            renderer = new HardwareRenderer();
            renderer.setSurface(reader.getSurface());
            node = new RenderNode("SpoilerBlock");
            node.setPosition(0, 0, MAX_SIDE, MAX_SIDE);
            renderer.setContentRoot(node);
        }
        RecordingCanvas c = node.beginRecording(MAX_SIDE, MAX_SIDE);
        c.drawColor(0, android.graphics.PorterDuff.Mode.CLEAR);
        c.scale(s, s);
        drawContent((ImageView) v, c);
        node.endRecording();
        synchronized (pending) { pending.addLast(new Object[]{bw, bh, done}); }
        int r = renderer.createRenderRequest().syncAndDraw(); // drawn on the render thread; the main thread does not wait for it
        if ((r & (HardwareRenderer.SYNC_CONTEXT_IS_STOPPED | HardwareRenderer.SYNC_FRAME_DROPPED)) != 0) {
            synchronized (pending) { pending.pollLast(); }
            throw new FrameDropped();
        }
    }

    /**
     * What ImageView.onDraw draws, without View.draw: View.draw on a hardware canvas would put the host's own RenderNodes
     * (the background's, overlay children's) into this renderer's tree, and whichever renderer syncs a shared node first
     * takes its damage. On devices with partial screen updates (buffer age) the app's next frame then leaves those regions
     * unpainted: stale covers and posts, "jumping" feeds. A drawable is not a RenderNode, so the host's tree is never touched.
     */
    static void drawContent(ImageView v, Canvas c) {
        Drawable d = v.getDrawable();
        if (d == null) return;
        int save = c.save();
        if (v.getCropToPadding()) c.clipRect(v.getPaddingLeft(), v.getPaddingTop(), v.getWidth() - v.getPaddingRight(), v.getHeight() - v.getPaddingBottom());
        c.translate(v.getPaddingLeft(), v.getPaddingTop());
        c.concat(v.getImageMatrix());
        d.draw(c);
        c.restoreToCount(save);
    }

    private static final class FrameDropped extends RuntimeException { }
    boolean capturedThisFrame; // reset by the scanner before each frame's scan
    private boolean retryPosted;

    private android.os.HandlerThread thread;
    private ImageReader reader;
    private HardwareRenderer renderer;
    private RenderNode node;
    private final ArrayDeque<Object[]> pending = new ArrayDeque<>(); // {width, height, callback} per frame drawn

    /** Frees the off-screen renderer (the last activity went away). Main thread. */
    void destroyRenderer() {
        if (renderer == null) return;
        renderer.destroy();
        reader.close();
        thread.quitSafely();
        renderer = null; reader = null; node = null; thread = null;
        synchronized (pending) { pending.clear(); }
    }

    // ---------- worker ----------

    private void work() {
        android.os.Process.setThreadPriority(android.os.Process.THREAD_PRIORITY_BACKGROUND); // never compete with frames
        while (true) {
            Job j;
            synchronized (jobs) {
                while (jobs.isEmpty()) try { jobs.wait(); } catch (InterruptedException e) { return; }
                j = jobs.removeFirst();
            }
            if (j.view == null) { closeModels(); continue; }
            boolean failed = false;
            List<double[]> hits = new ArrayList<>();
            String text = "";
            try {
                if (!j.view.isAttachedToWindow()) { // scrolled away and recycled: judged again when it comes back
                    sb.main.post(() -> { if (states.get(j.view) == j.state && !j.state.done) states.remove(j.view); });
                    continue;
                }
                if (clip == null && !loadFailed) load();
                if (clip == null) throw new IllegalStateException("image models unavailable");
                byte[] rgb = clipPixels(j.bmp);
                long hash = hash(rgb);
                Object[] cached = byPixels.get(hash);
                if (cached != null) {
                    hits = map((List<double[]>) cached[0]);
                    text = (String) cached[1];
                } else {
                    long t0 = SystemClock.uptimeMillis();
                    List<double[]> raw = clip.check(rgb);
                    long t1 = SystemClock.uptimeMillis();
                    text = ocr.text(j.bmp, watchdog);
                    long t2 = SystemClock.uptimeMillis();
                    stClip += t1 - t0; stClipN++; stOcr += t2 - t1; stOcrN++;
                    byPixels.put(hash, new Object[]{raw, text});
                    hits = map(raw);
                    if (Log.isLoggable(TAG, Log.DEBUG)) Log.d(TAG, "image " + j.bmp.getWidth() + "x" + j.bmp.getHeight() + ": clip " + (t1 - t0) +
                        " ms " + describe(raw) + ", ocr " + (t2 - t1) + " ms \"" + text.replace('\n', '|') + "\"");
                }
            } catch (Throwable t) { // fail closed: the item stays covered as "may contain a spoiler"
                failed = true;
                Log.w(TAG, "image check failed, item stays covered: " + t);
            }
            boolean f = failed;
            List<double[]> h = hits;
            String tx = text;
            sb.main.post(() -> {
                j.state.done = true;
                j.state.failed = f;
                j.state.hits = h;
                j.state.ocr = tx;
                sb.verdictsChanged();
            });
        }
    }

    private void load() {
        long t0 = SystemClock.uptimeMillis(), native0 = android.os.Debug.getNativeHeapAllocatedSize();
        try {
            clip = new Clip(sb.directAsset("spoilerblock/clip/vision_model_quantized.onnx"), sb.asset("spoilerblock/clip/clip-text.bin"),
                new String(sb.asset("spoilerblock/clip/clip-meta.json"), java.nio.charset.StandardCharsets.UTF_8));
            long t1 = SystemClock.uptimeMillis();
            File dir = new File(sb.app.getNoBackupFilesDir(), "spoilerblock-ocr");
            File data = new File(dir, "tessdata/eng.traineddata");
            if (!data.exists()) { // tesseract reads its model from a file
                data.getParentFile().mkdirs();
                File tmp = new File(data.getPath() + ".tmp");
                try (InputStream in = new GZIPInputStream(sb.app.getAssets().open("spoilerblock/ocr/eng.traineddata.gz"));
                     FileOutputStream out = new FileOutputStream(tmp)) {
                    byte[] buf = new byte[1 << 16];
                    for (int n; (n = in.read(buf)) > 0; ) out.write(buf, 0, n);
                }
                if (!tmp.renameTo(data)) throw new IllegalStateException("cannot write " + data);
            }
            ocr = new Ocr(dir);
            watchdog = java.util.concurrent.Executors.newSingleThreadScheduledExecutor();
            Log.i(TAG, "image models loaded: clip " + (t1 - t0) + " ms, ocr " + (SystemClock.uptimeMillis() - t1) + " ms, native heap +" +
                (android.os.Debug.getNativeHeapAllocatedSize() - native0) / (1 << 20) + " MB");
        } catch (Throwable t) {
            loadFailed = true;
            closeModels();
            Log.e(TAG, "image models unavailable, media items stay covered", t);
        }
    }

    private void closeModels() {
        try { if (clip != null) clip.close(); } catch (Throwable ignored) { }
        if (ocr != null) ocr.close();
        if (watchdog != null) watchdog.shutdownNow();
        clip = null; ocr = null; watchdog = null;
        loadFailed = false;
        byPixels.clear();
    }

    /** CLIP groups of the bundled index -> groups of the index in use (the same unless a catalog update replaced it). */
    private List<double[]> map(List<double[]> raw) throws Exception {
        Matcher m = sb.matcher;
        if (!sb.updatedIndex || raw.isEmpty() || raw.get(0)[0] == Clip.UNKNOWN) return raw;
        if (mappedFor != m) {
            Matcher b = new Matcher(sb.asset("spoilerblock/index.bin"), new String(sb.asset("spoilerblock/index.json"), java.nio.charset.StandardCharsets.UTF_8));
            Map<String, List<Integer>> byLabel = new java.util.HashMap<>();
            for (int g = 0; g < m.labels.length; g++) byLabel.computeIfAbsent(m.labels[g], x -> new ArrayList<>()).add(g);
            Map<String, Integer> pos = new java.util.HashMap<>();
            for (int w = 0; w < m.ids.length; w++) pos.put(m.ids[w], w);
            fromBundled = new int[b.labels.length];
            for (int g = 0; g < fromBundled.length; g++) {
                fromBundled[g] = -1;
                Integer first = pos.get(b.ids[b.groupWorks(g)[0]]);
                List<Integer> cands = byLabel.get(b.labels[g]);
                if (first == null || cands == null) continue;
                for (int c : cands) for (int w : m.groupWorks(c)) if (w == first && fromBundled[g] < 0) fromBundled[g] = c;
            }
            mappedFor = m;
        }
        List<double[]> out = new ArrayList<>();
        for (double[] h : raw) out.add(new double[]{fromBundled[(int) h[0]] >= 0 ? fromBundled[(int) h[0]] : Clip.UNKNOWN, h[1]});
        return out;
    }

    private String describe(List<double[]> hits) {
        if (hits.isEmpty()) return "no media";
        StringBuilder s = new StringBuilder();
        Matcher m = sb.matcher;
        for (double[] h : hits) s.append(h[0] == Clip.UNKNOWN ? "(unrecognised)" : m.labels[(int) h[0]]).append(' ').append(h[1]).append(' ');
        return s.toString().trim();
    }

    /** Centre square of a bitmap, scaled to 224 like the extension's preprocessing (see the int[] overload). */
    static byte[] clipPixels(Bitmap src) {
        int w = src.getWidth(), h = src.getHeight();
        int[] px = new int[w * h];
        src.getPixels(px, 0, w, 0, 0, w, h);
        return clipPixels(px, w, h);
    }

    /**
     * Centre-square crop and resize to 224 with a triangle (linear) filter as wide as the scale factor, vertical pass then
     * horizontal, rounding in between: what sharp/libvips 'linear' does for tools/calibrate-clip.mjs (within 2 levels).
     * Plain bilinear sampling (Bitmap.createScaledBitmap) aliases and flipped verdicts at the media gate.
     */
    static byte[] clipPixels(int[] argb, int w, int h) {
        int side = Math.min(w, h), x0 = (w - side) / 2, y0 = (h - side) / 2, S = Clip.S;
        double[] v = new double[S * side * 3]; // vertical pass straight from the source pixels, rounded like 8-bit storage
        double[][] wy = weights(side);
        for (int o = 0; o < S; o++) {
            int lo = (int) wy[o][0];
            for (int x = 0; x < side; x++) for (int q = 0; q < 3; q++) {
                double a = 0;
                for (int k = 1; k < wy[o].length; k++) {
                    int y = Math.min(Math.max(lo + k - 1, 0), side - 1);
                    a += wy[o][k] * ((argb[(y0 + y) * w + x0 + x] >> (16 - 8 * q)) & 0xFF);
                }
                v[(o * side + x) * 3 + q] = Math.round(a);
            }
        }
        byte[] rgb = new byte[S * S * 3];
        for (int o = 0; o < S; o++) {
            int lo = (int) wy[o][0];
            for (int y = 0; y < S; y++) for (int q = 0; q < 3; q++) {
                double a = 0;
                for (int k = 1; k < wy[o].length; k++) a += wy[o][k] * v[(y * side + Math.min(Math.max(lo + k - 1, 0), side - 1)) * 3 + q];
                rgb[(y * S + o) * 3 + q] = (byte) Math.max(0, Math.min(255, Math.round(a)));
            }
        }
        return rgb;
    }

    /** Per output pixel: {first input index, normalised tent weights...}; tent as wide as the scale (1 when enlarging). */
    private static double[][] weights(int len) {
        int n = Clip.S;
        double f = len / (double) n, r = Math.max(f, 1);
        double[][] out = new double[n][];
        for (int o = 0; o < n; o++) {
            double c = (o + 0.5) * f - 0.5;
            int lo = (int) Math.ceil(c - r), hi = (int) Math.floor(c + r);
            double[] wt = new double[hi - lo + 2];
            wt[0] = lo;
            double sum = 0;
            for (int i = lo; i <= hi; i++) sum += wt[i - lo + 1] = Math.max(0, 1 - Math.abs(i - c) / r);
            for (int i = 1; i < wt.length; i++) wt[i] /= sum;
            out[o] = wt;
        }
        return out;
    }

    private static long hash(byte[] b) {
        long h = 0xcbf29ce484222325L;
        for (byte x : b) h = (h ^ (x & 0xFF)) * 0x100000001b3L;
        return h;
    }
}
