package dev.spoilerblocker.demo;

import android.content.Context;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.os.SystemClock;
import android.util.Log;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.File;
import java.io.InputStream;
import java.lang.reflect.Constructor;
import java.lang.reflect.Method;
import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.List;

/**
 * On-device image parity run (test app only): decodes every test/fixtures/images file pushed to the app's external
 * files dir (images/), preprocesses it with the blocker's Android code (Images.clipPixels) and judges it with its Clip,
 * then compares with the extension's verdicts in clip-cases.json (android/tools/clip-vectors.mjs). OCR runs on the
 * ocr_* fixtures through the blocker's Ocr and Matcher. Reached by reflection (the demo is built without the blocker).
 * Logs "SBIMG ..." lines and a summary.
 */
final class ImageEval {
    static void run(Context c) {
        new Thread(() -> {
            try {
                File dir = c.getExternalFilesDir(null);
                JSONArray cases = new JSONArray(new String(Files.readAllBytes(new File(dir, "clip-cases.json").toPath()), StandardCharsets.UTF_8));
                Class<?> clipK = Class.forName("dev.spoilerblocker.Clip"), imgK = Class.forName("dev.spoilerblocker.Images");
                Constructor<?> ctor = clipK.getDeclaredConstructor(ByteBuffer.class, byte[].class, String.class);
                ctor.setAccessible(true);
                long t0 = SystemClock.uptimeMillis();
                byte[] model = read(c, "spoilerblocker/clip/vision_model_quantized.onnx");
                ByteBuffer buf = ByteBuffer.allocateDirect(model.length).put(model);
                buf.flip();
                model = null;
                Object clip = ctor.newInstance(buf, read(c, "spoilerblocker/clip/clip-text.bin"),
                    new String(read(c, "spoilerblocker/clip/clip-meta.json"), StandardCharsets.UTF_8));
                Log.i("SBIMG", "clip loaded in " + (SystemClock.uptimeMillis() - t0) + " ms");
                Method pixels = imgK.getDeclaredMethod("clipPixels", Bitmap.class), check = clipK.getDeclaredMethod("check", byte[].class);
                pixels.setAccessible(true);
                check.setAccessible(true);
                int differ = 0, rawDiffer = 0, titled = 0, generic = 0, missed = 0, ordinary = 0, media = 0, ordN = 0;
                long tc = 0;
                for (int i = 0; i < cases.length(); i++) {
                    JSONObject k = cases.getJSONObject(i);
                    Bitmap b = BitmapFactory.decodeFile(new File(dir, k.getString("file")).getPath(), srgb());
                    if (b == null) { Log.e("SBIMG", "cannot decode " + k.getString("file")); differ++; continue; }
                    long a = SystemClock.uptimeMillis();
                    @SuppressWarnings("unchecked") List<double[]> hits = (List<double[]>) check.invoke(clip, pixels.invoke(null, b));
                    tc += SystemClock.uptimeMillis() - a;
                    String got = hits.isEmpty() ? "none" : hits.get(0)[0] == -1 ? "generic" : "title " + (int) hits.get(0)[0];
                    JSONArray w = k.getJSONArray("hits");
                    String want = w.length() == 0 ? "none" : w.getJSONArray(0).getInt(0) == -1 ? "generic" : "title " + w.getJSONArray(0).getInt(0);
                    boolean isMedia = !k.isNull("want");
                    if (isMedia) { media++; if (got.equals("none")) missed++; else if (got.equals("generic")) generic++; else titled++; }
                    else { ordN++; if (!got.equals("none")) ordinary++; }
                    if (!got.equals(want)) differ++;
                    File raw = new File(dir, k.getString("file") + ".rgb"); // the extension's own 224x224 pixels: model + rule only
                    if (raw.exists()) {
                        @SuppressWarnings("unchecked") List<double[]> rh = (List<double[]>) check.invoke(clip, (Object) Files.readAllBytes(raw.toPath()));
                        String rgot = rh.isEmpty() ? "none" : rh.get(0)[0] == -1 ? "generic" : "title " + (int) rh.get(0)[0];
                        if (!rgot.equals(want)) { rawDiffer++; Log.i("SBIMG", "RAW DIFF " + k.getString("file") + " js=" + want + " android=" + rgot); }
                    }
                    Log.i("SBIMG", (got.equals(want) ? "same " : "DIFF ") + k.getString("file") + " js=" + want + " android=" + got +
                        (hits.isEmpty() ? "" : " score=" + hits.get(0)[1]));
                }
                Log.i("SBIMG", "done " + cases.length() + " images, clip avg " + tc / cases.length() + " ms; media " + media + ": " + titled + " titled / " +
                    generic + " generic / " + missed + " missed; ordinary blocked " + ordinary + "/" + ordN + "; " + differ + " differ from the extension; on the extension's own pixels " + rawDiffer + " differ");
                ((AutoCloseable) clip).close();

                // OCR fixtures
                Class<?> ocrK = Class.forName("dev.spoilerblocker.Ocr");
                Constructor<?> oc = ocrK.getDeclaredConstructor(File.class);
                oc.setAccessible(true);
                File data = new File(c.getCacheDir(), "ocr-eval");
                File td = new File(data, "tessdata/eng.traineddata");
                td.getParentFile().mkdirs();
                try (InputStream in = new java.util.zip.GZIPInputStream(c.getAssets().open("spoilerblocker/ocr/eng.traineddata.gz"));
                     java.io.FileOutputStream out = new java.io.FileOutputStream(td)) {
                    byte[] bb = new byte[1 << 16];
                    for (int n; (n = in.read(bb)) > 0; ) out.write(bb, 0, n);
                }
                long l0 = SystemClock.uptimeMillis();
                Object ocr = oc.newInstance(data);
                Log.i("SBIMG", "ocr loaded in " + (SystemClock.uptimeMillis() - l0) + " ms");
                Method text = ocrK.getDeclaredMethod("text", Bitmap.class, java.util.concurrent.ScheduledExecutorService.class);
                text.setAccessible(true);
                Class<?> mK = Class.forName("dev.spoilerblocker.Matcher");
                Object m = mK.getConstructor(byte[].class, String.class).newInstance(read(c, "spoilerblocker/index.bin"),
                    new String(read(c, "spoilerblocker/index.json"), StandardCharsets.UTF_8));
                String[] labels = (String[]) mK.getField("labels").get(m);
                String[] ids = (String[]) mK.getField("ids").get(m);
                Method eval = mK.getMethod("evaluate", String.class, boolean[].class);
                java.util.concurrent.ScheduledExecutorService wd = java.util.concurrent.Executors.newSingleThreadScheduledExecutor();
                String[] files = dir.list();
                java.util.Arrays.sort(files);
                for (String f : files) {
                    if (!f.startsWith("ocr_") && !f.startsWith("spoiler_") && !f.startsWith("clean_")) continue;
                    Bitmap b = BitmapFactory.decodeFile(new File(dir, f).getPath(), srgb());
                    if (b == null) { Log.e("SBIMG", "cannot decode " + f); continue; }
                    long a = SystemClock.uptimeMillis();
                    String t = (String) text.invoke(ocr, b, wd);
                    long ms = SystemClock.uptimeMillis() - a;
                    StringBuilder hit = new StringBuilder();
                    for (int g : (int[]) eval.invoke(m, t, new boolean[ids.length])) hit.append(labels[g]).append(';');
                    Log.i("SBIMG", "ocr " + f + " " + b.getWidth() + "x" + b.getHeight() + " in " + ms + " ms: \"" + t.replace('\n', '|') + "\" -> [" + hit + "]");
                }
                ((AutoCloseable) ocr).close();
                wd.shutdown();
                Log.i("SBIMG", "ocr done");
            } catch (Throwable t) {
                Log.e("SBIMG", "failed", t);
            }
        }, "SBIMG").start();
    }

    /** Decoded into sRGB like the extension's sharp pipeline (fixtures with an ICC profile otherwise keep their colour space). */
    private static BitmapFactory.Options srgb() {
        BitmapFactory.Options o = new BitmapFactory.Options();
        o.inPreferredColorSpace = android.graphics.ColorSpace.get(android.graphics.ColorSpace.Named.SRGB);
        return o;
    }

    private static byte[] read(Context c, String name) throws Exception {
        try (InputStream in = c.getAssets().open(name)) {
            byte[] b = new byte[in.available()];
            int n = 0;
            for (int r; n < b.length && (r = in.read(b, n, b.length - n)) > 0; ) n += r;
            return b;
        }
    }
}
