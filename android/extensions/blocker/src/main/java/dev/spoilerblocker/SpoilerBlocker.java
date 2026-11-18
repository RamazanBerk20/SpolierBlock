package dev.spoilerblocker;

import android.app.Activity;
import android.app.Application;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.ShortcutInfo;
import android.content.pm.ShortcutManager;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.util.Log;
import android.view.View;
import android.view.Window;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.Collections;
import java.util.HashSet;
import java.util.Map;
import java.util.Set;
import java.util.WeakHashMap;

/**
 * Entry point called by the patch from Application.onCreate. App-agnostic: it only uses public Android APIs on the
 * host's views. Every call from host code is wrapped; any internal error disables the blocker for the session.
 */
public final class SpoilerBlocker implements Application.ActivityLifecycleCallbacks {
    static final String TAG = "SpoilerBlocker";
    static final String EXTRA_MANAGE = "dev.spoilerblocker.MANAGE";
    static volatile boolean dead;
    static SpoilerBlocker I;

    final Application app;
    final SharedPreferences prefs;
    final Handler main = new Handler(Looper.getMainLooper());
    private Thread loader;
    volatile Matcher matcher;
    volatile boolean[] seenWork;
    boolean enabled;
    int generation; // bumped when seen works or the switch change: every item is re-evaluated
    final Set<String> revealed = new HashSet<>(); // "Show once": item texts shown this session
    final Map<View, Scanner> scanners = new WeakHashMap<>(); // decor view -> scanner
    private Activity resumed;
    private boolean pendingManage;

    public static void init(Application app) {
        try {
            if (I == null && !dead) I = new SpoilerBlocker(app);
        } catch (Throwable t) {
            fail("init", t);
        }
    }

    private SpoilerBlocker(Application app) {
        this.app = app;
        prefs = app.getSharedPreferences("spoilerblocker", 0);
        enabled = prefs.getBoolean("enabled", true);
        spoilerMode = "spoiler".equals(prefs.getString("mode", "any"));
        scanImages = prefs.getBoolean("scanImages", true);
        images = new Images(this);
        app.registerActivityLifecycleCallbacks(this);
        Log.i(TAG, "initialised in " + app.getPackageName() + " (enabled=" + enabled + ")");
    }

    /** Text of custom-drawn host views, reported by app-specific setter hooks (see the X and Instagram patches). */
    static final Map<View, CharSequence> hookedText = Collections.synchronizedMap(new WeakHashMap<>());

    /**
     * Called by a patch at the start of a host text setter, for views that draw text themselves and expose it neither
     * as TextView text, content description nor accessibility node. src: a CharSequence or an android.text.Layout.
     */
    public static void text(View v, Object src) {
        try {
            if (dead || v == null) return;
            CharSequence t = src instanceof android.text.Layout ? ((android.text.Layout) src).getText() : (CharSequence) src;
            if (t == null) hookedText.remove(v); else hookedText.put(v, t);
        } catch (Throwable t) {
            fail("text hook", t);
        }
    }

    /** Disables the blocker for this session, removing every cover so the app stays usable. */
    static void fail(String where, Throwable t) {
        dead = true;
        Log.e(TAG, "disabled for this session after an error in " + where, t);
        SpoilerBlocker b = I;
        if (b == null) return;
        b.main.post(() -> {
            for (Scanner s : b.scanners.values()) try { s.clear(); } catch (Throwable ignored) { }
        });
    }

    // The index (3 MB) is read on first activity, not in Application.onCreate: background processes never pay for it.
    private synchronized void startLoading() {
        if (loader != null) return;
        loader = new Thread(() -> {
            try {
                long t0 = SystemClock.uptimeMillis();
                CatalogUpdate.Stored st = storedIndex();
                Matcher m = st != null ? new Matcher(st.bin, st.json)
                    : new Matcher(asset("spoilerblocker/index.bin"), new String(asset("spoilerblocker/index.json"), StandardCharsets.UTF_8));
                seenWork = seenArray(m);
                updatedIndex = st != null;
                matcher = m;
                Log.i(TAG, "index loaded" + (st != null ? " (updated catalog)" : "") + ": " + m.ids.length + " works, " + m.labels.length +
                    " names in " + (SystemClock.uptimeMillis() - t0) + " ms");
                main.post(this::invalidateAll);
            } catch (Throwable t) {
                fail("index load", t);
            }
        }, "SpoilerBlocker-index");
        loader.start();
    }

    /** Called from the first pre-draw that has items to judge: waits for the index instead of showing them unjudged. */
    Matcher awaitMatcher() {
        Matcher m = matcher;
        if (m != null || loader == null) return m;
        try {
            long t0 = SystemClock.uptimeMillis();
            loader.join(2000); // shortcut: blocks the UI thread at most once per process, move to a placeholder cover if 2 s ever shows up
            Log.i(TAG, "waited " + (SystemClock.uptimeMillis() - t0) + " ms for the index before first draw");
        } catch (InterruptedException ignored) { }
        return matcher;
    }

    /** An asset in a direct buffer (kept off the Java heap; ONNX Runtime copies what it needs). */
    java.nio.ByteBuffer directAsset(String name) throws Exception {
        try (InputStream in = app.getAssets().open(name)) {
            java.nio.ByteBuffer b = java.nio.ByteBuffer.allocateDirect(in.available()); // an asset stream knows its full length
            byte[] buf = new byte[1 << 16];
            for (int n; (n = in.read(buf)) > 0; ) b.put(buf, 0, n);
            b.flip();
            return b;
        }
    }

    byte[] asset(String name) throws Exception {
        try (InputStream in = app.getAssets().open(name)) {
            ByteArrayOutputStream out = new ByteArrayOutputStream(1 << 20);
            byte[] buf = new byte[1 << 16];
            for (int n; (n = in.read(buf)) > 0; ) out.write(buf, 0, n);
            return out.toByteArray();
        }
    }

    // ---------- opt-in catalog update (the only network use; see CatalogUpdate) ----------

    static final String[] CATALOG_MODES = {"off", "daily", "weekly", "monthly"};
    private static final long[] CATALOG_INTERVALS = {0, 86400000L, 7 * 86400000L, 30 * 86400000L};
    private volatile boolean updating;
    Runnable catalogListener; // the open manage dialog's status line

    private File indexFile() { return new File(app.getFilesDir(), "spoilerblocker-index.dat"); }

    /** The updated index, or null when there is none or it was built from an older bundled catalog than this APK's. */
    private CatalogUpdate.Stored storedIndex() {
        File f = indexFile();
        if (!f.exists()) return null;
        try {
            CatalogUpdate.Stored st = CatalogUpdate.read(f);
            if (st.bundledBuiltAt.equals(bundledBuiltAt())) return st;
            Log.i(TAG, "updated index is from another bundled catalog: dropped");
        } catch (Throwable t) {
            Log.w(TAG, "updated index unreadable, using the bundled one: " + t);
        }
        f.delete();
        prefs.edit().putInt("catalogAdded", 0).apply();
        return null;
    }

    private String bundledBuiltAt() throws Exception {
        return CatalogUpdate.builtAtOf(new String(asset("spoilerblocker/catalog-info.json"), StandardCharsets.UTF_8));
    }

    String catalogMode() { return prefs.getString("catalogMode", "off"); }

    void setCatalogMode(String mode) {
        prefs.edit().putString("catalogMode", mode).apply();
        maybeUpdateCatalog(false);
    }

    /** On app start / resume, and from "Update now" (force). Never runs while the mode is off unless forced. */
    void maybeUpdateCatalog(boolean force) {
        long interval = 0;
        for (int i = 0; i < CATALOG_MODES.length; i++) if (CATALOG_MODES[i].equals(catalogMode())) interval = CATALOG_INTERVALS[i];
        if (!force && (interval == 0 || System.currentTimeMillis() - prefs.getLong("catalogLastCheck", 0) < interval)) return;
        if (updating) return;
        updating = true;
        notifyCatalog();
        Thread t = new Thread(this::updateCatalog, "SpoilerBlocker-catalog");
        t.setPriority(Thread.MIN_PRIORITY);
        t.start();
    }

    private void updateCatalog() {
        android.os.Process.setThreadPriority(android.os.Process.THREAD_PRIORITY_BACKGROUND);
        long now = System.currentTimeMillis(), t0 = SystemClock.uptimeMillis();
        prefs.edit().putLong("catalogLastCheck", now).apply();
        HeapProbe heap = new HeapProbe();
        CatalogUpdate u = null;
        String error = null;
        try {
            CatalogUpdate.Bundle b = new CatalogUpdate.Bundle(
                Catalog.readWorks(new java.io.InputStreamReader(app.getAssets().open("spoilerblocker/catalog.json"), StandardCharsets.UTF_8)),
                new String(asset("spoilerblocker/common-words.txt"), StandardCharsets.UTF_8),
                CatalogUpdate.readClasses(new String(asset("spoilerblocker/catalog-classes.json"), StandardCharsets.UTF_8)),
                bundledBuiltAt());
            CatalogUpdate.Stored prev = storedIndex();
            u = new CatalogUpdate(CatalogUpdate.httpTransport(), endpoint(), Thread::sleep);
            CatalogUpdate.Result r = u.run(b, prev != null ? prev.added : new java.util.ArrayList<>());
            if (r.built != null) {
                CatalogUpdate.write(indexFile(), new CatalogUpdate.Stored(b.builtAt, r.built.bin, r.built.json, r.added));
                Matcher m = new Matcher(r.built.bin, r.built.json);
                main.post(() -> { // live swap: every visible item is judged again on the next frame
                    seenWork = seenArray(m);
                    updatedIndex = true;
                    matcher = m;
                    generation++;
                    invalidateAll();
                });
            }
            prefs.edit().putLong("catalogLastSuccess", now).putInt("catalogAdded", r.added.size()).putInt("catalogFound", r.fresh.size())
                .remove("catalogLastError").apply();
            Log.i(TAG, "catalog update: " + r.fresh.size() + " new works (" + r.added.size() + " added in total)");
        } catch (CatalogUpdate.Failure e) {
            error = e.getMessage();
        } catch (OutOfMemoryError e) {
            error = "Not enough memory to rebuild the catalog";
        } catch (InterruptedException e) {
            error = "Update interrupted";
        } catch (Throwable t) {
            Log.w(TAG, "catalog update failed", t);
            error = "Update failed (" + t.getClass().getSimpleName() + ")";
        } finally {
            heap.stop();
            if (error != null) prefs.edit().putString("catalogLastError", error).apply();
            Log.i(TAG, "catalog update done in " + (SystemClock.uptimeMillis() - t0) + " ms: " + (u == null ? 0 : u.stats.queries) + " queries, " +
                (u == null ? 0 : u.stats.bytes) + " bytes, heap peak +" + heap.peak / (1 << 20) + " MB" + (error == null ? "" : ", error: " + error));
            updating = false;
            notifyCatalog();
        }
    }

    // Test builds only: the demo patch ships this asset to point the update at a local mock server.
    private String endpoint() {
        try {
            return new String(asset("spoilerblocker/test-endpoint.txt"), StandardCharsets.UTF_8).trim();
        } catch (Exception e) {
            return CatalogUpdate.ENDPOINT;
        }
    }

    private void notifyCatalog() { main.post(() -> { Runnable l = catalogListener; if (l != null) l.run(); }); }

    /** "25,467 titles + 3 new · updated 3 days ago", plus the last error in plain words. */
    String catalogStatus() {
        int added = prefs.getInt("catalogAdded", 0);
        Matcher m = matcher;
        String s = (m == null ? "" : String.format(java.util.Locale.US, "%,d titles", m.ids.length - added)) + (added > 0 ? " + " + added + " new" : "");
        long ok = prefs.getLong("catalogLastSuccess", 0);
        s += updating ? " · updating…" : ok == 0 ? " · never updated" : " · updated " + ago(System.currentTimeMillis() - ok);
        String err = prefs.getString("catalogLastError", null);
        return err == null || updating ? s : s + "\nLast update failed: " + err;
    }

    private static String ago(long ms) {
        long min = ms / 60000;
        if (min < 1) return "just now";
        if (min < 60) return min + (min == 1 ? " minute ago" : " minutes ago");
        if (min < 1440) return min / 60 + (min / 60 == 1 ? " hour ago" : " hours ago");
        return min / 1440 + (min / 1440 == 1 ? " day ago" : " days ago");
    }

    /** Java-heap growth while an update runs, sampled every 10 ms (for the log). */
    private static final class HeapProbe implements Runnable {
        private final Runtime rt = Runtime.getRuntime();
        private final long base = rt.totalMemory() - rt.freeMemory();
        private volatile boolean running = true;
        volatile long peak;
        private final Thread t = new Thread(this, "SpoilerBlocker-heap");

        HeapProbe() { t.setDaemon(true); t.start(); }

        @Override public void run() {
            while (running) {
                peak = Math.max(peak, rt.totalMemory() - rt.freeMemory() - base);
                try { Thread.sleep(10); } catch (InterruptedException e) { return; }
            }
        }

        void stop() { running = false; t.interrupt(); }
    }

    // ---------- seen works (SharedPreferences: work ids, like the extension's storage) ----------

    Set<String> seenIds() { return new HashSet<>(prefs.getStringSet("seen", Collections.emptySet())); }

    private boolean[] seenArray(Matcher m) {
        Set<String> ids = seenIds();
        boolean[] seen = new boolean[m.ids.length];
        for (int i = 0; i < seen.length; i++) seen[i] = ids.contains(m.ids[i]);
        return seen;
    }

    /** "I've seen {title}": every work carrying the name, in one write. */
    void markSeen(int group) {
        Matcher m = matcher;
        Set<String> ids = seenIds();
        for (int w : m.groupWorks(group)) ids.add(m.ids[w]);
        prefs.edit().putStringSet("seen", ids).apply();
        Log.i(TAG, "marked seen: " + m.labels[group]);
        changed();
    }

    void unmarkSeen(String id) {
        Set<String> ids = seenIds();
        ids.remove(id);
        prefs.edit().putStringSet("seen", ids).apply();
        changed();
    }

    void setEnabled(boolean on) {
        enabled = on;
        prefs.edit().putBoolean("enabled", on).apply();
        Log.i(TAG, "enabled=" + on);
        changed();
    }

    // ---------- "Only block actual spoilers" (prefs "mode": "any" | "spoiler", the extension's setting) ----------

    boolean spoilerMode;
    private final Map<String, Boolean> verdicts = new java.util.LinkedHashMap<String, Boolean>(64, 0.75f, true) { // main thread
        @Override protected boolean removeEldestEntry(Map.Entry<String, Boolean> e) { return size() > 2000; }
    };
    private final Set<String> classifying = new HashSet<>(); // main thread
    private java.util.concurrent.ExecutorService worker;
    private Classifier classifier; // worker thread only: loaded on the first item to judge in spoiler mode
    private boolean classifierFailed; // worker thread only

    void setSpoilerMode(boolean on) {
        spoilerMode = on;
        prefs.edit().putString("mode", on ? "spoiler" : "any").apply();
        Log.i(TAG, "mode=" + (on ? "spoiler" : "any"));
        if (!on && worker != null) worker.execute(() -> { // "any" mode holds no model
            try { if (classifier != null) classifier.close(); } catch (Throwable ignored) { }
            classifier = null;
        });
        changed();
    }

    /** Whether a matched item is covered: always in "any" mode; in spoiler mode until the classifier says it is no spoiler. */
    boolean coverMatch(String text) {
        if (!spoilerMode) return true;
        Boolean v = verdicts.get(text);
        if (v != null) return v;
        if (classifying.add(text)) {
            if (worker == null) worker = java.util.concurrent.Executors.newSingleThreadExecutor(r -> new Thread(() -> {
                android.os.Process.setThreadPriority(android.os.Process.THREAD_PRIORITY_BACKGROUND); // never compete with frames
                r.run();
            }, "SpoilerBlocker-classify"));
            worker.execute(() -> classify(text));
        }
        return true; // covered until the verdict is in
    }

    private void classify(String text) {
        boolean spoiler = true; // fail closed: any error keeps the item covered
        try {
            if (classifier == null && !classifierFailed) loadClassifier();
            if (classifier != null) {
                long t0 = SystemClock.uptimeMillis();
                double p = classifier.prob(text.length() > 4000 ? text.substring(0, 4000) : text);
                spoiler = p >= classifier.threshold;
                if (Log.isLoggable(TAG, Log.DEBUG)) Log.d(TAG, "verdict " + (spoiler ? "spoiler" : "no spoiler") + String.format(java.util.Locale.US,
                    " p=%.3f", p) + " (" + Classifier.sentences(text).size() + " sentences in " + (SystemClock.uptimeMillis() - t0) + " ms) text=" + text.replace('\n', '|'));
            }
        } catch (Throwable t) {
            Log.w(TAG, "classifier failed, item stays covered", t);
        }
        boolean v = spoiler;
        main.post(() -> {
            classifying.remove(text);
            verdicts.put(text, v);
            verdictsChanged();
        });
    }

    private void loadClassifier() {
        long t0 = SystemClock.uptimeMillis(), native0 = android.os.Debug.getNativeHeapAllocatedSize();
        try {
            classifier = new Classifier(directAsset("spoilerblocker/spoiler/model_int8.onnx"), new String(asset("spoilerblocker/spoiler/tokenizer.json"), StandardCharsets.UTF_8),
                new String(asset("spoilerblocker/spoiler/meta.json"), StandardCharsets.UTF_8));
            Log.i(TAG, "spoiler model loaded in " + (SystemClock.uptimeMillis() - t0) + " ms, native heap +" +
                (android.os.Debug.getNativeHeapAllocatedSize() - native0) / (1 << 20) + " MB");
        } catch (Throwable t) { // e.g. no ONNX Runtime library for this ABI: every match stays covered, as in "any" mode
            classifierFailed = true;
            Log.e(TAG, "spoiler model unavailable, spoiler mode blocks every match", t);
        }
    }

    /** A classifier or image verdict came in: every item is judged again on the next frame. */
    void verdictsChanged() {
        generation++;
        invalidateAll();
    }

    // ---------- "Scan images and video" (prefs "scanImages", the extension's setting) ----------

    boolean scanImages;
    volatile boolean updatedIndex; // the matcher is a catalog update's, not the bundled index CLIP's groups refer to
    final Images images;

    void setScanImages(boolean on) {
        scanImages = on;
        prefs.edit().putBoolean("scanImages", on).apply();
        Log.i(TAG, "scanImages=" + on);
        if (!on) images.release(); // no image model stays loaded
        changed();
    }

    private void changed() {
        if (matcher != null) seenWork = seenArray(matcher);
        generation++;
        invalidateAll();
    }

    private void invalidateAll() {
        for (View decor : scanners.keySet()) decor.invalidate();
    }

    // ---------- activities ----------

    // The settings request is read before the activity's own onCreate can act on its intent (API 29+), onActivityCreated as fallback.
    @Override public void onActivityPreCreated(Activity a, Bundle b) {
        try { checkManageIntent(a); } catch (Throwable t) { fail("onActivityPreCreated", t); }
    }

    @Override public void onActivityCreated(Activity a, Bundle b) {
        try {
            startLoading();
            checkManageIntent(a);
        } catch (Throwable t) { fail("onActivityCreated", t); }
    }

    @Override public void onActivityResumed(Activity a) {
        if (dead) return;
        try {
            resumed = a;
            checkManageIntent(a);
            Window w = a.getWindow();
            View decor = w.getDecorView();
            Scanner s = scanners.get(decor);
            if (s == null) {
                scanners.put(decor, s = new Scanner(this, decor));
                addShortcutOnce();
            }
            if (!(w.getCallback() instanceof TouchGate)) w.setCallback(new TouchGate(w.getCallback(), s));
            maybeUpdateCatalog(false); // interval elapsed? runs on a background thread, never before or during the first frame's work

            if (pendingManage) {
                main.postDelayed(() -> { // trampoline activities finish right away: show on the one that stays
                    if (resumed == a && pendingManage && !a.isFinishing()) { pendingManage = false; ManageDialog.show(a, this); }
                    else Log.i(TAG, "settings not shown on " + a.getClass().getName() + " (resumed: " + (resumed == a) + ", finishing: " + a.isFinishing() + ")");
                }, 700);
            }
        } catch (Throwable t) { fail("onActivityResumed", t); }
    }

    @Override public void onActivityPaused(Activity a) { if (resumed == a) resumed = null; }
    @Override public void onActivityStarted(Activity a) { }
    @Override public void onActivityStopped(Activity a) { }
    @Override public void onActivitySaveInstanceState(Activity a, Bundle b) { }
    @Override public void onActivityDestroyed(Activity a) {
        try {
            Scanner s = scanners.remove(a.getWindow().getDecorView());
            if (s != null) s.detach();
            if (scanners.isEmpty()) images.destroyRenderer();
        } catch (Throwable t) { fail("onActivityDestroyed", t); }
    }

    private void checkManageIntent(Activity a) {
        Intent i = a.getIntent();
        // YouTube empties the extras of incoming intents before any callback of ours runs; a category survives that
        if (i != null && (i.hasCategory(EXTRA_MANAGE) || i.getBooleanExtra(EXTRA_MANAGE, false))) {
            i.removeCategory(EXTRA_MANAGE);
            i.removeExtra(EXTRA_MANAGE);
            pendingManage = true;
            Log.i(TAG, "settings requested by " + a.getClass().getName());
        }
    }

    private boolean shortcutAdded;

    /** Long-press the app icon -> "Spoiler settings": the way back in when blocking is switched off. */
    private void addShortcutOnce() {
        if (shortcutAdded) return;
        shortcutAdded = true;
        Intent launch = app.getPackageManager().getLaunchIntentForPackage(app.getPackageName());
        ShortcutManager sm = app.getSystemService(ShortcutManager.class);
        if (launch == null || sm == null) return;
        launch.setAction(Intent.ACTION_MAIN).addCategory(EXTRA_MANAGE).putExtra(EXTRA_MANAGE, true);
        try {
            sm.addDynamicShortcuts(Collections.singletonList(new ShortcutInfo.Builder(app, "spoilerblocker")
                .setShortLabel("Spoiler settings").setIntent(launch).build()));
        } catch (RuntimeException e) { // rate limits / launcher quirks: not fatal
            Log.w(TAG, "shortcut not added: " + e);
        }
    }
}
