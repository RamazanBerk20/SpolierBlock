package dev.spoilerblocker.demo;

import android.content.Context;
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

/**
 * On-device parity run (test app only): scores android/build/vectors/spoiler-eval.json, pushed to the app's external
 * files dir, with the patched-in dev.spoilerblocker.Classifier (reached by reflection: the demo is built without it).
 * Logs "SBEVAL i p" per post; android/tools/spoiler-eval-compare.mjs compares them with the extension's values.
 */
final class SpoilerEval {
    static void run(Context c) {
        new Thread(() -> {
            try {
                JSONArray cases = new JSONObject(new String(Files.readAllBytes(new File(c.getExternalFilesDir(null), "spoiler-eval.json").toPath()),
                    StandardCharsets.UTF_8)).getJSONArray("cases");
                byte[] model = read(c, "spoilerblocker/spoiler/model_int8.onnx");
                ByteBuffer buf = ByteBuffer.allocateDirect(model.length).put(model);
                buf.flip();
                Class<?> k = Class.forName("dev.spoilerblocker.Classifier");
                Constructor<?> ctor = k.getDeclaredConstructor(ByteBuffer.class, String.class, String.class);
                ctor.setAccessible(true);
                Object cl = ctor.newInstance(buf, new String(read(c, "spoilerblocker/spoiler/tokenizer.json"), StandardCharsets.UTF_8),
                    new String(read(c, "spoilerblocker/spoiler/meta.json"), StandardCharsets.UTF_8));
                Method prob = k.getDeclaredMethod("prob", String.class);
                prob.setAccessible(true);
                long t0 = SystemClock.uptimeMillis();
                for (int i = 0; i < cases.length(); i++) Log.i("SBEVAL", i + " " + prob.invoke(cl, cases.getJSONObject(i).getString("text")));
                Log.i("SBEVAL", "done " + cases.length() + " posts in " + (SystemClock.uptimeMillis() - t0) + " ms, abi " + System.getProperty("os.arch"));
            } catch (Throwable t) {
                Log.e("SBEVAL", "failed", t);
            }
        }, "SBEVAL").start();
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
