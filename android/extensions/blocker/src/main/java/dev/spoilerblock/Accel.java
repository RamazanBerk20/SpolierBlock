package dev.spoilerblock;

import android.content.Context;
import android.content.SharedPreferences;
import android.os.Build;
import android.os.SystemClock;
import android.util.Log;

import java.nio.ByteBuffer;
import java.util.ArrayList;
import java.util.Collections;
import java.util.EnumSet;
import java.util.List;

import ai.onnxruntime.OrtEnvironment;
import ai.onnxruntime.OrtSession;
import ai.onnxruntime.providers.NNAPIFlags;

/**
 * Optional hardware acceleration of the vision model (NNAPI, fp16 relaxed), used only after it proved itself on this
 * device: a reference picture must give the same embedding as on the CPU (cosine >= 0.99) and the accelerated run must
 * be faster. The shipped model has int8 weights, which only run on the CPU; the accelerated session folds them to
 * float when it is created (in memory, no second file). The check runs once per app version and OS build.
 * A native crash cannot be caught: a marker is written before the first accelerated run and cleared after it, and a
 * marker found at start means the last attempt took the process down, so acceleration stays off on this install.
 */
final class Accel {
    static final String CPU = "cpu", ACCELERATED = "accelerated", FAILED = "failed";
    private final Context app;
    private final SharedPreferences prefs;

    Accel(Context app) {
        this.app = app;
        prefs = app.getSharedPreferences("spoilerblock-accel", 0);
    }

    /** "CPU", "Accelerated (NNAPI)" or "CPU (acceleration failed its check: ...)", for Settings > About. */
    String status() {
        String mode = prefs.getString("mode", ""), why = prefs.getString("why", "");
        if (mode.isEmpty()) return "Not checked yet (runs with the first image)";
        if (mode.equals(ACCELERATED)) return "Accelerated (NNAPI): " + why;
        if (mode.equals(FAILED)) return "CPU: acceleration failed its self-check (" + why + ")";
        return "CPU: " + why;
    }

    private String fingerprint() {
        try {
            android.content.pm.PackageInfo p = app.getPackageManager().getPackageInfo(app.getPackageName(), 0);
            return p.lastUpdateTime + "/" + p.getLongVersionCode() + "/" + Build.FINGERPRINT;
        } catch (Exception e) {
            return Build.FINGERPRINT;
        }
    }

    private void result(String mode, String why) {
        prefs.edit().putString("mode", mode).putString("why", why).putString("for", fingerprint()).commit();
        Log.i(SpoilerBlock.TAG, "image acceleration: " + mode + " (" + why + ")");
    }

    /** An accelerated run failed after the check had passed: the CPU from now on (until the next app or OS update). */
    void failedAtRun(Exception e) {
        result(FAILED, "a run failed: " + e.getClass().getSimpleName());
    }

    /**
     * Worker thread, after the CPU vision session exists. The accelerated session to use (the caller then drops the CPU
     * one), or null for the CPU. The float weights take about 330 MB more than the int8 ones (measured +550 MB native
     * heap on the emulator), so phones with less than 6 GB of memory stay on the CPU.
     */
    OrtSession start(ByteBuffer model, OrtSession cpu, Clip clip) {
        if (Build.VERSION.SDK_INT < 27) { result(CPU, "NNAPI needs Android 8.1"); return null; }
        android.app.ActivityManager.MemoryInfo mem = new android.app.ActivityManager.MemoryInfo();
        app.getSystemService(android.app.ActivityManager.class).getMemoryInfo(mem);
        if (mem.totalMem < 6L << 30) { result(CPU, "acceleration needs 6 GB of memory, this device has " + (mem.totalMem >> 20) + " MB"); return null; }
        if (prefs.getBoolean("broken", false)) return null; // a native crash during an earlier attempt: off for good
        if (prefs.getBoolean("attempt", false)) {
            prefs.edit().putBoolean("broken", true).putBoolean("attempt", false).commit();
            result(FAILED, "the app stopped during the last attempt; acceleration stays off");
            return null;
        }
        boolean checked = fingerprint().equals(prefs.getString("for", ""));
        if (checked && !ACCELERATED.equals(prefs.getString("mode", ""))) return null; // CPU it is, until an update
        prefs.edit().putBoolean("attempt", true).commit(); // before anything accelerated runs
        OrtSession acc = null;
        long heap0 = android.os.Debug.getNativeHeapAllocatedSize();
        try {
            try (OrtSession.SessionOptions o = new OrtSession.SessionOptions()) {
                // basic optimisations run before the graph is split between providers: the int8 weights fold to float
                o.addConfigEntry("session.disable_quant_qdq", "1");
                o.setOptimizationLevel(OrtSession.SessionOptions.OptLevel.BASIC_OPT);
                o.addConfigEntry("session.intra_op.allow_spinning", "0");
                o.addNnapi(EnumSet.of(NNAPIFlags.USE_FP16));
                acc = OrtEnvironment.getEnvironment().createSession(model, o);
            }
            if (checked) { // proved itself for this version: one run on the reference to be sure it still works
                clip.embed(acc, Collections.singletonList(reference(clip.size)));
                prefs.edit().putBoolean("attempt", false).commit();
                return acc;
            }
            List<byte[]> ref = Collections.singletonList(reference(clip.size));
            float[] a = clip.embed(acc, ref)[0], c = clip.embed(cpu, ref)[0]; // warm-up runs, and the embeddings to compare
            double cos = cosine(a, c);
            long tAcc = median(acc, clip, ref), tCpu = median(cpu, clip, ref);
            prefs.edit().putBoolean("attempt", false).commit();
            String why = String.format(java.util.Locale.US, "cosine %.4f, %d ms against %d ms on the CPU, +%d MB", cos, tAcc, tCpu,
                (android.os.Debug.getNativeHeapAllocatedSize() - heap0) >> 20);
            if (cos >= 0.99 && tAcc < tCpu) { result(ACCELERATED, why); return acc; }
            result(CPU, (cos < 0.99 ? "different results: " : "not faster: ") + why);
        } catch (Throwable t) {
            prefs.edit().putBoolean("attempt", false).commit();
            result(FAILED, t.getClass().getSimpleName() + (t.getMessage() == null ? "" : ": " + t.getMessage().split("\n")[0]));
        }
        try { if (acc != null) acc.close(); } catch (Throwable ignored) { }
        return null;
    }

    private static long median(OrtSession s, Clip clip, List<byte[]> ref) throws Exception {
        List<Long> t = new ArrayList<>();
        for (int i = 0; i < 3; i++) {
            long t0 = SystemClock.uptimeMillis();
            clip.embed(s, ref);
            t.add(SystemClock.uptimeMillis() - t0);
        }
        Collections.sort(t);
        return t.get(1);
    }

    static double cosine(float[] a, float[] b) {
        double ab = 0, aa = 0, bb = 0;
        for (int i = 0; i < a.length; i++) { ab += (double) a[i] * b[i]; aa += (double) a[i] * a[i]; bb += (double) b[i] * b[i]; }
        return ab / Math.sqrt(aa * bb);
    }

    /** A fixed, busy test picture (gradients, stripes, a disc): no asset needed, the same on every device. */
    static byte[] reference(int S) {
        byte[] rgb = new byte[S * S * 3];
        for (int y = 0; y < S; y++) for (int x = 0; x < S; x++) {
            int i = (y * S + x) * 3;
            double dx = x - S * 0.6, dy = y - S * 0.4;
            boolean disc = dx * dx + dy * dy < S * S / 16.0;
            rgb[i] = (byte) (disc ? 230 : x * 255 / S);
            rgb[i + 1] = (byte) (disc ? 40 : ((x / 16 + y / 16) % 2 == 0 ? 200 : 60));
            rgb[i + 2] = (byte) (disc ? 60 : y * 255 / S);
        }
        return rgb;
    }
}
