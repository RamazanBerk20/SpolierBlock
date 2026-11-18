package dev.spoilerblocker;

import android.graphics.Bitmap;

import com.googlecode.tesseract.android.TessBaseAPI;

import java.io.File;

/**
 * Text inside images, as the extension reads it: Tesseract (here the native build of Tesseract4Android, in the extension
 * tesseract.js) with the same eng 4.0.0_best_int model, LSTM engine and default page segmentation, and the same rule
 * that a mean confidence below 60 means "no text" (photos without text give low-confidence garbage).
 * Not thread-safe; SpoilerBlocker runs it on its image worker thread.
 */
final class Ocr implements AutoCloseable {
    static final long TIMEOUT_MS = 10_000; // as the extension's OCR_RUN_MS
    private final TessBaseAPI api = new TessBaseAPI();

    /** dataDir holds tessdata/eng.traineddata. */
    Ocr(File dataDir) {
        if (!api.init(dataDir.getPath(), "eng", TessBaseAPI.OEM_LSTM_ONLY)) {
            api.recycle();
            throw new IllegalStateException("tesseract init failed");
        }
    }

    /** Recognised text, "" when there is none worth reading; throws on timeout (the caller fails closed). */
    String text(Bitmap b, java.util.concurrent.ScheduledExecutorService watchdog) throws Exception {
        java.util.concurrent.atomic.AtomicBoolean late = new java.util.concurrent.atomic.AtomicBoolean();
        java.util.concurrent.ScheduledFuture<?> f = watchdog.schedule(() -> { late.set(true); api.stop(); }, TIMEOUT_MS,
            java.util.concurrent.TimeUnit.MILLISECONDS);
        try {
            api.setImage(b.getConfig() == Bitmap.Config.ARGB_8888 ? b : b.copy(Bitmap.Config.ARGB_8888, false)); // the only config it reads
            String t = api.getUTF8Text();
            int conf = api.meanConfidence();
            if (late.get()) throw new java.util.concurrent.TimeoutException("ocr timeout");
            return t != null && conf >= 60 ? t.trim() : "";
        } finally {
            f.cancel(false);
            api.clear();
        }
    }

    @Override public void close() { api.recycle(); }
}
