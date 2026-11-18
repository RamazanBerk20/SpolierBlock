package dev.spoilerblock.demo;

import android.content.Context;
import android.util.Log;

import java.io.File;
import java.lang.reflect.Method;

/**
 * On-device image parity run (test app only): the blocker's Images.evalFixtures judges every test/fixtures/images file
 * pushed to the app's external files dir with the production code (decode, resize, title check, OCR) and compares with
 * the extension's verdicts and texts (android/tools/clip-vectors.mjs: clip-cases.json, ocr-cases.json and *.rgba).
 * Reached by reflection (the demo is built without the blocker). Logs "SBIMG ..." lines and a summary.
 */
final class ImageEval {
    static void run(Context c) {
        new Thread(() -> {
            try {
                Method m = Class.forName("dev.spoilerblock.Images").getDeclaredMethod("evalFixtures", Context.class, File.class);
                m.setAccessible(true);
                m.invoke(null, c, c.getExternalFilesDir(null));
                Log.i("SBIMG", "done");
            } catch (Throwable t) {
                Log.e("SBIMG", "failed", t);
            }
        }, "SBIMG").start();
    }
}
