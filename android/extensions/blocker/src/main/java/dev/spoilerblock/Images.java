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
import java.nio.ByteBuffer;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.WeakHashMap;
import java.nio.charset.StandardCharsets;

import ai.onnxruntime.OrtEnvironment;
import ai.onnxruntime.OrtSession;

/**
 * "Scan images": finds the media views of a feed item (ImageViews of at least 96 dp, as the extension skips smaller
 * images), captures what they draw and judges it like the extension does (SigLIP 2 title/media verdict + PP-OCR text
 * that goes through the matcher with the post's text). Capture: the view's own display list is recorded into a
 * RenderNode and rendered off screen by a HardwareRenderer into an ImageReader, which works for hardware bitmaps and
 * any drawable type, and leaves out the cover (it lives in the item's overlay, not in the media view).
 * Main thread: candidates, states, capture. One worker thread: model loading, title checks (in batches), OCR.
 */
final class Images {
    private static final int MIN_DP = 96, MAX_SIDE = Ocr.SRC_MAX, QUEUE = 8; // OCR reads pictures at up to 1280 px, as the extension
    static final String TAG = SpoilerBlock.TAG;

    /** Verdict of one media view for one drawable (main thread). */
    static final class State {
        final long key;
        boolean done, failed;
        List<double[]> hits = new ArrayList<>();
        String ocr = "";
        Matcher namesFor; boolean ocrNames; // main thread: whether ocr names any work (rule 7), for that index
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
        accel = new Accel(sb.app);
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

    private long firstVerdict; // main thread
    private volatile long loadStart, loadEnd, cacheHits;

    String coldStats(long start) {
        return ", models loaded " + (loadStart == 0 ? "-" : (loadStart - start) + "-" + (loadEnd - start)) + " ms, first verdict " +
            (firstVerdict == 0 ? "-" : String.valueOf(firstVerdict - start)) + " ms, " + cacheHits + " verdicts from the verdict cache";
    }

    private void retry() { retryPosted = false; sb.invalidateAll(); } // a new frame: only items with pending images are judged again

    private void enqueue(Job j) { // any thread
        synchronized (jobs) {
            jobs.addFirst(j);
            while (jobs.size() > QUEUE) { // a fling: forget the oldest; still on screen, it is captured again on its next judge
                Job old = jobs.removeLast();
                sb.main.post(() -> { if (states.get(old.view) == old.state && !old.state.done) states.remove(old.view); });
            }
            startWorker();
            jobs.notifyAll();
        }
    }

    private void startWorker() { // under jobs
        if (worker == null) {
            worker = new Thread(this::work, "SpoilerBlock-images");
            worker.start();
        }
    }

    private volatile boolean warm;

    /**
     * Loads the models (and the saved verdicts) now, at the first activity, so that the first pictures do not wait for
     * them: the load (1-2 s on a phone) overlaps the host's own start instead of following its first feed. Main thread.
     */
    void prewarm() {
        if (warm) return;
        warm = true;
        synchronized (jobs) { startWorker(); jobs.notifyAll(); }
    }

    /** Drops every model (switch turned off). */
    void release() {
        warm = false;
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
            reader = ImageReader.newInstance(MAX_SIDE, MAX_SIDE, PixelFormat.RGBA_8888, 2,
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

    private static final int BATCH = 4; // title checks waiting together run as one batch, as engine.js TITLE_BATCH

    private void work() {
        android.os.Process.setThreadPriority(android.os.Process.THREAD_PRIORITY_BACKGROUND); // never compete with frames
        while (true) {
            List<Job> batch = new ArrayList<>();
            boolean drop = false;
            if (warm && jobs.isEmpty()) { // first pictures not there yet: get ready for them
                try { loadClip(); readSaved(); if (clip != null && !loadFailed && !sessionsLoaded()) load(); }
                catch (Throwable t) { Log.w(TAG, "prewarm: " + t); }
            }
            synchronized (jobs) {
                while (jobs.isEmpty()) try { jobs.wait(); } catch (InterruptedException e) { return; }
                while (!jobs.isEmpty() && batch.size() < BATCH && !drop) {
                    Job j = jobs.removeFirst();
                    if (j.view == null) drop = true; else batch.add(j);
                }
            }
            if (drop) { closeModels(); continue; }
            judge(batch);
        }
    }

    /**
     * Title check (one vision run for the batch) and OCR of each new picture; each verdict is posted to the main thread
     * as soon as it is known (a saved one before any model runs), so the first picture does not wait for the batch.
     */
    private void judge(List<Job> batch) {
        List<Job> live = new ArrayList<>();
        for (Job j : batch) {
            if (j.view.isAttachedToWindow()) live.add(j);
            else sb.main.post(() -> { if (states.get(j.view) == j.state && !j.state.done) states.remove(j.view); }); // judged again when back
        }
        if (live.isEmpty()) return;
        Object[][] res = new Object[live.size()][]; // {hits, text}
        try {
            loadClip();
            readSaved();
            byte[][] rgb = new byte[live.size()][];
            long[] keys = new long[live.size()];
            List<byte[]> todo = new ArrayList<>();
            List<Integer> at = new ArrayList<>();
            for (int i = 0; i < live.size(); i++) {
                rgb[i] = visionPixels(live.get(i).bmp, clip.size);
                keys[i] = hash(rgb[i]);
                Object[] c = byPixels.get(keys[i]);
                if (c != null) { res[i] = new Object[]{map((List<double[]>) c[0]), c[1]}; cacheHits++; post(live.get(i), res[i]); }
                else { todo.add(rgb[i]); at.add(i); }
            }
            if (!todo.isEmpty()) { // the models are needed only for pictures not seen before
                if (!sessionsLoaded() && !loadFailed) load();
                if (!sessionsLoaded()) throw new IllegalStateException("image models unavailable");
                long t0 = SystemClock.uptimeMillis();
                float[][] e = embed(todo);
                long t1 = SystemClock.uptimeMillis();
                stClip += t1 - t0; stClipN += todo.size();
                for (int k = 0; k < todo.size(); k++) {
                    int i = at.get(k);
                    List<double[]> raw = clip.verdict(e[k]);
                    long t2 = SystemClock.uptimeMillis();
                    String text = ocr(live.get(i).bmp);
                    stOcr += SystemClock.uptimeMillis() - t2; stOcrN++;
                    byPixels.put(keys[i], new Object[]{raw, text});
                    unsaved++;
                    res[i] = new Object[]{map(raw), text};
                    post(live.get(i), res[i]);
                    if (Log.isLoggable(TAG, Log.DEBUG)) Log.d(TAG, "image " + live.get(i).bmp.getWidth() + "x" + live.get(i).bmp.getHeight() + ": title " +
                        (t1 - t0) / todo.size() + " ms " + describe(raw) + ", ocr " + (SystemClock.uptimeMillis() - t2) + " ms \"" + text.replace('\n', '|') + "\"");
                }
            }
        } catch (Throwable t) { // fail closed: the item stays covered as far as unknown images are covered
            Log.w(TAG, "image check failed, item stays covered: " + t);
        }
        for (int i = 0; i < live.size(); i++) if (res[i] == null) post(live.get(i), null); // fail closed
        // saved when the queue runs dry (a process may be killed any time after), at most every few seconds while busy
        boolean idle;
        synchronized (jobs) { idle = jobs.isEmpty(); }
        if (unsaved > 0 && (idle || SystemClock.uptimeMillis() - savedAt > SAVE_MS)) save();
    }

    /** A verdict {hits, ocr text} to the main thread; null: the check failed. */
    private void post(Job j, Object[] res) {
        boolean f = res == null;
        @SuppressWarnings("unchecked") List<double[]> h = f ? new ArrayList<>() : (List<double[]>) res[0];
        String tx = f ? "" : (String) res[1];
        sb.main.post(() -> {
            if (firstVerdict == 0) firstVerdict = SystemClock.uptimeMillis();
            j.state.done = true;
            j.state.failed = f;
            j.state.hits = h;
            j.state.ocr = tx;
            sb.verdictsChanged();
        });
    }

    // ---------- models (worker thread) ----------

    private OrtSession visionCpu, visionAccel;
    private OrtSession.RunOptions ocrRun;

    /** The vision run, accelerated when the self-check chose it; an accelerated run that fails sends us back to the CPU for good. */
    private float[][] embed(List<byte[]> rgbs) throws Exception {
        if (visionAccel == null) return clip.embed(visionCpu, rgbs);
        try {
            return clip.embed(visionAccel, rgbs);
        } catch (Exception e) {
            accel.failedAtRun(e);
            try { visionAccel.close(); } catch (Exception ignored) { }
            visionAccel = null;
            try (OrtSession.SessionOptions o = cpuOptions()) { visionCpu = OrtEnvironment.getEnvironment().createSession(sb.directAsset("spoilerblock/vision/model.onnx"), o); }
            return clip.embed(visionCpu, rgbs);
        }
    }

    /** The title rows and the input size (1.5 MB, no model): enough to answer pictures from the saved verdicts. */
    private void loadClip() throws Exception {
        if (clip == null) clip = new Clip(sb.asset("spoilerblock/vision/clip-text.bin"), new String(sb.asset("spoilerblock/vision/clip-meta.json"), StandardCharsets.UTF_8));
    }

    private boolean sessionsLoaded() { return (visionCpu != null || visionAccel != null) && ocr != null; }

    // ---------- verdicts saved across restarts (worker thread) ----------
    // A cold start shows the same pictures again (a feed's top, a channel, a search): their verdicts are kept in the
    // app's cache directory, keyed by the hash of the model's input pixels, for the same build of the app (and so of the
    // models and the index the verdicts name). Nothing leaves the device.

    private static final long SAVE_MS = 5000;
    private static final int SAVED_VERSION = 1;
    private boolean savedRead;
    private int unsaved;
    private long savedAt;

    private File savedFile() { return new File(sb.app.getCacheDir(), "spoilerblock-images.bin"); }

    private long build() throws Exception {
        android.content.pm.PackageInfo pi = sb.app.getPackageManager().getPackageInfo(sb.app.getPackageName(), 0);
        return pi.lastUpdateTime;
    }

    private void readSaved() {
        if (savedRead) return;
        savedRead = true;
        File f = savedFile();
        if (!f.exists()) return;
        long t0 = SystemClock.uptimeMillis();
        int n = 0;
        try (java.io.DataInputStream in = new java.io.DataInputStream(new java.io.BufferedInputStream(new java.io.FileInputStream(f)))) {
            if (in.readInt() != SAVED_VERSION || in.readLong() != build()) return;
            n = in.readInt();
            for (int i = 0; i < n; i++) {
                long key = in.readLong();
                int h = in.readInt();
                List<double[]> hits = new ArrayList<>();
                for (int k = 0; k < h; k++) hits.add(new double[]{in.readInt(), in.readDouble()});
                byPixels.put(key, new Object[]{hits, in.readUTF()});
            }
            Log.i(TAG, "saved image verdicts: " + n + " read in " + (SystemClock.uptimeMillis() - t0) + " ms");
        } catch (Throwable t) {
            Log.w(TAG, "saved image verdicts unreadable, starting afresh: " + t);
            byPixels.clear();
        }
    }

    private void save() {
        unsaved = 0;
        savedAt = SystemClock.uptimeMillis();
        File f = savedFile(), tmp = new File(f.getPath() + ".tmp");
        try (java.io.DataOutputStream out = new java.io.DataOutputStream(new java.io.BufferedOutputStream(new java.io.FileOutputStream(tmp)))) {
            out.writeInt(SAVED_VERSION);
            out.writeLong(build());
            out.writeInt(byPixels.size());
            for (Map.Entry<Long, Object[]> e : byPixels.entrySet()) { // least recently used first: read back in the same order
                out.writeLong(e.getKey());
                @SuppressWarnings("unchecked") List<double[]> hits = (List<double[]>) e.getValue()[0];
                out.writeInt(hits.size());
                for (double[] h : hits) { out.writeInt((int) h[0]); out.writeDouble(h[1]); }
                String t = (String) e.getValue()[1];
                out.writeUTF(t.length() > 8000 ? t.substring(0, 8000) : t); // writeUTF holds 64 KB
            }
        } catch (Throwable t) {
            Log.w(TAG, "image verdicts not saved: " + t);
            tmp.delete();
            return;
        }
        if (!tmp.renameTo(f)) tmp.delete();
    }

    private void load() {
        long t0 = loadStart = SystemClock.uptimeMillis(), native0 = android.os.Debug.getNativeHeapAllocatedSize();
        try {
            OrtEnvironment env = OrtEnvironment.getEnvironment();
            ByteBuffer model = sb.directAsset("spoilerblock/vision/model.onnx");
            try (OrtSession.SessionOptions o = cpuOptions()) { visionCpu = env.createSession(model, o); }
            long t1 = SystemClock.uptimeMillis();
            try (OrtSession.SessionOptions o = cpuOptions(); OrtSession.SessionOptions o2 = cpuOptions()) {
                ocr = new Ocr(env.createSession(sb.directAsset("spoilerblock/ocr/det.onnx"), o), env.createSession(sb.directAsset("spoilerblock/ocr/rec.onnx"), o2),
                    new String(sb.asset("spoilerblock/ocr/dict.txt"), StandardCharsets.UTF_8));
            }
            watchdog = java.util.concurrent.Executors.newSingleThreadScheduledExecutor();
            Log.i(TAG, "image models loaded: vision " + (t1 - t0) + " ms, ocr " + (SystemClock.uptimeMillis() - t1) + " ms, " + threads() +
                " threads, native heap +" + (android.os.Debug.getNativeHeapAllocatedSize() - native0) / (1 << 20) + " MB");
            visionAccel = accel.start(model, visionCpu, clip);
            if (visionAccel != null) { visionCpu.close(); visionCpu = null; } // one copy of the weights in memory
            loadEnd = SystemClock.uptimeMillis();
        } catch (Throwable t) {
            loadFailed = true;
            closeModels();
            Log.e(TAG, "image models unavailable, media items stay covered", t);
        }
    }

    /** CPU: the big cores of a phone (half the cores, at most 4), threads that sleep rather than spin between runs. */
    static int threads() {
        int n = Runtime.getRuntime().availableProcessors();
        return n >= 8 ? 4 : Math.max(1, n / 2);
    }

    static OrtSession.SessionOptions cpuOptions() throws Exception {
        OrtSession.SessionOptions o = new OrtSession.SessionOptions();
        o.setIntraOpNumThreads(threads());
        o.addConfigEntry("session.intra_op.allow_spinning", "0");
        o.setOptimizationLevel(OrtSession.SessionOptions.OptLevel.ALL_OPT);
        return o;
    }

    /** OCR text of a picture, "" when there is none; a run past 10 s is stopped and counts as a failure. */
    private String ocr(Bitmap b) throws Exception {
        int w = b.getWidth(), h = b.getHeight();
        int[] px = new int[w * h];
        b.getPixels(px, 0, w, 0, 0, w, h);
        byte[] rgba = new byte[w * h * 4];
        for (int i = 0; i < px.length; i++) {
            int c = px[i];
            rgba[i * 4] = (byte) (c >> 16); rgba[i * 4 + 1] = (byte) (c >> 8); rgba[i * 4 + 2] = (byte) c; rgba[i * 4 + 3] = (byte) (c >>> 24);
        }
        OrtSession.RunOptions run = new OrtSession.RunOptions();
        ocr.run = run;
        java.util.concurrent.ScheduledFuture<?> stop = watchdog.schedule(() -> { try { run.setTerminate(true); } catch (Exception ignored) { } },
            OCR_TIMEOUT_MS, java.util.concurrent.TimeUnit.MILLISECONDS);
        try {
            return ocr.text(rgba, w, h, null);
        } finally {
            stop.cancel(false);
            ocr.run = null;
            run.close();
        }
    }

    static final long OCR_TIMEOUT_MS = 10_000;

    private void closeModels() {
        for (AutoCloseable c : new AutoCloseable[]{visionCpu, visionAccel, ocr}) try { if (c != null) c.close(); } catch (Throwable ignored) { }
        if (watchdog != null) watchdog.shutdownNow();
        clip = null; ocr = null; watchdog = null; visionCpu = null; visionAccel = null;
        loadFailed = false;
        byPixels.clear();
        savedRead = false; // switched on again: read back from the file
    }

    final Accel accel;

    /** Title-check groups of the bundled index -> groups of the index in use (the same unless it was rebuilt). */
    private List<double[]> map(List<double[]> raw) throws Exception {
        Matcher m = sb.matcher;
        if (!sb.updatedIndex || raw.isEmpty() || raw.get(0)[0] == Clip.UNKNOWN) return raw;
        if (mappedFor != m) {
            Matcher b = new Matcher(sb.asset("spoilerblock/index.bin"), new String(sb.asset("spoilerblock/index.json"), StandardCharsets.UTF_8));
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

    // ---------- pixels ----------

    /** The whole picture squashed to S x S RGB, as the extension does (see the int[] overload). */
    static byte[] visionPixels(Bitmap src, int S) {
        int w = src.getWidth(), h = src.getHeight();
        int[] px = new int[w * h];
        src.getPixels(px, 0, w, 0, 0, w, h);
        return visionPixels(px, w, h, S);
    }

    /**
     * src/background/pixels.js squashCHW, up to the 8-bit rounding (the normalisation is Clip.embed's): the whole picture
     * squashed to S x S with separable triangle-filter weights (PIL's antialiased BILINEAR, SigLIP's own preprocessing),
     * horizontal pass first into float32 rows, then vertical, rounded to 8 bits. Same order of operations as the JS.
     */
    static byte[] visionPixels(int[] argb, int W, int H, int S) {
        Object[] tx = taps(W, S), ty = taps(H, S);
        int[] xlo = (int[]) tx[0], ylo = (int[]) ty[0];
        double[][] xw = (double[][]) tx[1], yw = (double[][]) ty[1];
        float[] row = new float[H * S * 3];
        for (int y = 0; y < H; y++) for (int x = 0; x < S; x++) {
            double r = 0, g = 0, b = 0;
            double[] w = xw[x];
            for (int k = 0; k < w.length; k++) {
                int c = argb[y * W + xlo[x] + k];
                r += ((c >> 16) & 0xFF) * w[k]; g += ((c >> 8) & 0xFF) * w[k]; b += (c & 0xFF) * w[k];
            }
            int q = (y * S + x) * 3;
            row[q] = (float) r; row[q + 1] = (float) g; row[q + 2] = (float) b;
        }
        byte[] rgb = new byte[S * S * 3];
        for (int y = 0; y < S; y++) {
            double[] w = yw[y];
            for (int x = 0; x < S; x++) {
                double v0 = 0, v1 = 0, v2 = 0;
                for (int k = 0; k < w.length; k++) {
                    int q = ((ylo[y] + k) * S + x) * 3;
                    v0 += row[q] * w[k]; v1 += row[q + 1] * w[k]; v2 += row[q + 2] * w[k];
                }
                int o = (y * S + x) * 3;
                rgb[o] = (byte) Math.min(255, Math.max(0, Ocr.jsRound(v0)));
                rgb[o + 1] = (byte) Math.min(255, Math.max(0, Ocr.jsRound(v1)));
                rgb[o + 2] = (byte) Math.min(255, Math.max(0, Ocr.jsRound(v2)));
            }
        }
        return rgb;
    }

    /** pixels.js taps(n, m): {first input index per output, normalised weights per output}. */
    private static Object[] taps(int n, int m) {
        double scale = n / (double) m, fs = Math.max(scale, 1);
        int[] lo = new int[m];
        double[][] w = new double[m][];
        for (int x = 0; x < m; x++) {
            double c = (x + 0.5) * scale;
            int a = (int) Math.max(0, Math.floor(c - fs)), hi = (int) Math.min(n, Math.ceil(c + fs));
            double[] t = new double[hi - a];
            double sum = 0;
            for (int i = a; i < hi; i++) sum += t[i - a] = Math.max(0, 1 - Math.abs((i + 0.5 - c) / fs));
            for (int i = 0; i < t.length; i++) t[i] /= sum;
            lo[x] = a;
            w[x] = t;
        }
        return new Object[]{lo, w};
    }

    private static long hash(byte[] b) {
        long h = 0xcbf29ce484222325L;
        for (byte x : b) h = (h ^ (x & 0xFF)) * 0x100000001b3L;
        return h;
    }

    // ---------- on-device parity run (the demo app's ImageEval, by reflection) ----------

    /**
     * Judges the fixture images in dir (pushed by the test) with the production code: decode, visionPixels, the CPU
     * vision session, the verdict, and OCR on the ocr_* files; compares with clip-cases.json / ocr-cases.json from
     * android/tools/clip-vectors.mjs. Logs "SBIMG" lines; also times the CPU session against XNNPACK.
     */
    static void evalFixtures(android.content.Context c, File dir) throws Exception {
        SpoilerBlock sb = SpoilerBlock.I;
        Clip clip = new Clip(sb.asset("spoilerblock/vision/clip-text.bin"), new String(sb.asset("spoilerblock/vision/clip-meta.json"), StandardCharsets.UTF_8));
        OrtEnvironment env = OrtEnvironment.getEnvironment();
        ByteBuffer model = sb.directAsset("spoilerblock/vision/model.onnx");
        org.json.JSONArray cases = new org.json.JSONArray(new String(java.nio.file.Files.readAllBytes(new File(dir, "clip-cases.json").toPath()), StandardCharsets.UTF_8));
        android.graphics.BitmapFactory.Options opt = new android.graphics.BitmapFactory.Options();
        opt.inPreferredConfig = Bitmap.Config.ARGB_8888;
        opt.inPreferredColorSpace = android.graphics.ColorSpace.get(android.graphics.ColorSpace.Named.SRGB);
        for (String mode : new String[]{"cpu"}) { // XNNPACK was measured slower (690 ms alone, 355 in a batch of 4): not used
            long t0 = SystemClock.uptimeMillis();
            OrtSession s;
            try (OrtSession.SessionOptions o = cpuOptions()) {
                if (mode.equals("xnnpack")) {
                    o.setIntraOpNumThreads(1); // XNNPACK brings its own thread pool
                    java.util.Map<String, String> po = new java.util.HashMap<>();
                    po.put("intra_op_num_threads", String.valueOf(threads()));
                    o.addXnnpack(po);
                }
                s = env.createSession(model, o);
            }
            long load = SystemClock.uptimeMillis() - t0, run = 0;
            int differ = 0, runs = 0;
            for (int i = 0; i < cases.length(); i++) {
                org.json.JSONObject k = cases.getJSONObject(i);
                Bitmap b = android.graphics.BitmapFactory.decodeFile(new File(dir, k.getString("file")).getPath(), opt);
                if (b == null) { differ++; continue; }
                long a = SystemClock.uptimeMillis();
                List<double[]> hits = clip.verdict(clip.embed(s, java.util.Collections.singletonList(visionPixels(b, clip.size)))[0]);
                run += SystemClock.uptimeMillis() - a; runs++;
                String got = kind(hits), want = kindJs(k.getJSONArray("hits"));
                if (!got.equals(want)) differ++;
                if (mode.equals("cpu")) Log.i("SBIMG", (got.equals(want) ? "same " : "DIFF ") + k.getString("file") + " js=" + want + " android=" + got +
                    (hits.isEmpty() ? "" : " score=" + hits.get(0)[1]));
            }
            // batch of 4 (as the worker runs a burst of new pictures)
            List<byte[]> four = new ArrayList<>();
            for (int i = 0; i < 4; i++) four.add(visionPixels(android.graphics.BitmapFactory.decodeFile(new File(dir, cases.getJSONObject(i).getString("file")).getPath(), opt), clip.size));
            long a = SystemClock.uptimeMillis();
            clip.embed(s, four);
            long batch = SystemClock.uptimeMillis() - a;
            Log.i("SBIMG", mode + ": loaded in " + load + " ms, " + runs + " images, " + run / Math.max(1, runs) + " ms per image alone, " + batch / 4 +
                " ms per image in a batch of 4, " + differ + " verdicts differ from the extension");
            s.close();
        }
        // OCR
        File ocrCases = new File(dir, "ocr-cases.json");
        if (ocrCases.exists()) {
            org.json.JSONArray oc = new org.json.JSONArray(new String(java.nio.file.Files.readAllBytes(ocrCases.toPath()), StandardCharsets.UTF_8));
            try (OrtSession.SessionOptions o = cpuOptions(); OrtSession.SessionOptions o2 = cpuOptions();
                 Ocr ocr = new Ocr(env.createSession(sb.directAsset("spoilerblock/ocr/det.onnx"), o), env.createSession(sb.directAsset("spoilerblock/ocr/rec.onnx"), o2),
                     new String(sb.asset("spoilerblock/ocr/dict.txt"), StandardCharsets.UTF_8))) {
                int same = 0;
                long t = 0;
                for (int i = 0; i < oc.length(); i++) {
                    org.json.JSONObject k = oc.getJSONObject(i);
                    byte[] rgba = java.nio.file.Files.readAllBytes(new File(dir, k.getString("file") + ".rgba").toPath());
                    long a = SystemClock.uptimeMillis();
                    String text = ocr.text(rgba, k.getInt("width"), k.getInt("height"), null);
                    t += SystemClock.uptimeMillis() - a;
                    boolean eq = text.equals(k.getString("text"));
                    if (eq) same++;
                    Log.i("SBIMG", (eq ? "ocr same " : "OCR DIFF ") + k.getString("file") + " android=\"" + text.replace('\n', '|') + "\"" +
                        (eq ? "" : " js=\"" + k.getString("text").replace('\n', '|') + "\""));
                }
                Log.i("SBIMG", "ocr: " + same + "/" + oc.length() + " texts identical, " + t / Math.max(1, oc.length()) + " ms per image");
            }
        }
        Log.i("SBIMG", "accel: " + sb.images.accel.status());
    }

    static String kind(List<double[]> hits) { return hits.isEmpty() ? "none" : hits.get(0)[0] == Clip.UNKNOWN ? "generic" : "title " + (int) hits.get(0)[0]; }

    static String kindJs(org.json.JSONArray h) throws Exception {
        return h.length() == 0 ? "none" : h.getJSONArray(0).getInt(0) == -1 ? "generic" : "title " + h.getJSONArray(0).getInt(0);
    }
}
