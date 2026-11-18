package dev.spoilerblock;

import android.app.Activity;
import android.app.Application;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.ShortcutInfo;
import android.content.pm.ShortcutManager;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.os.SystemClock;
import android.util.Log;
import android.view.View;
import android.view.Window;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.WeakHashMap;

/**
 * Entry point called by the patch from Application.onCreate. App-agnostic: it only uses public Android APIs on the
 * host's views. Every call from host code is wrapped; any internal error disables the blocker for the session.
 */
public final class SpoilerBlock implements Application.ActivityLifecycleCallbacks {
    static final String TAG = "SpoilerBlock";
    static final String EXTRA_MANAGE = "dev.spoilerblock.MANAGE";
    static volatile boolean dead;
    static SpoilerBlock I;

    final Application app;
    final SharedPreferences prefs; // this app's own state: catalog update times, the index it built
    final Store store;
    final Handler main = new Handler(Looper.getMainLooper());
    private Thread loader;
    volatile Matcher matcher;
    volatile Config.Works works; // the config seen through the matcher's work list
    boolean enabled, scanImages, blockUnlisted, unknownImages;
    int generation; // bumped when the config, the index or a verdict changes: every item is re-evaluated
    final Set<String> revealed = new HashSet<>(); // "Show once": item texts shown this session
    final Map<View, Scanner> scanners = new WeakHashMap<>(); // window root view -> scanner
    private Activity resumed;
    private boolean pendingManage;

    public static void init(Application app) {
        try {
            if (I == null && !dead) I = new SpoilerBlock(app);
        } catch (Throwable t) {
            fail("init", t);
        }
    }

    private SpoilerBlock(Application app) {
        this.app = app;
        prefs = app.getSharedPreferences("spoilerblock", 0);
        store = Store.get(app);
        images = new Images(this);
        readSettings(store.get());
        catalogMode = store.get().catalogUpdate();
        store.listen(this::configChanged);
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
        SpoilerBlock b = I;
        if (b == null) return;
        b.main.post(() -> {
            for (Scanner s : b.scanners.values()) try { s.clear(); } catch (Throwable ignored) { }
        });
    }

    // ---------- config ----------

    private void readSettings(Config c) {
        enabled = c.bool("enabled");
        scanImages = c.bool("scanImages");
        blockUnlisted = c.bool("blockUnlisted");
        unknownImages = c.bool("unknownImages");
        Matcher m = matcher;
        if (m != null) works = new Config.Works(c, m.ids);
    }

    /** Main thread: the config changed here or in another app (through the companion). */
    private void configChanged() {
        Config c = store.get();
        boolean hadImages = scanImages;
        String mode = catalogMode;
        readSettings(c);
        if (hadImages && !scanImages) images.release(); // no image model stays loaded
        Config.Works v = works;
        if (v != null && !v.anySpoilers) releaseClassifier();
        if (!c.catalogUpdate().equals(mode)) { catalogMode = c.catalogUpdate(); maybeUpdateCatalog(false); }
        if (matcher != null && !customSig(c).equals(indexCustom)) rebuildIndexAsync();
        generation++;
        invalidateAll();
    }

    /** "I've seen it": every work carrying the name, in one write. */
    void markSeen(int group) {
        Matcher m = matcher;
        Config c = store.get();
        JSONObject w = new JSONObject();
        long now = System.currentTimeMillis();
        try {
            for (int i : m.groupWorks(group)) {
                JSONObject old = c.work(m.ids[i]);
                w.put(m.ids[i], Config.entry(Config.SEEN, old == null || old.isNull("style") ? null : old.optString("style"),
                    m.titles[i], m.types[i], m.years[i], now));
            }
            store.patch(new JSONObject().put("works", w));
        } catch (org.json.JSONException e) {
            throw new IllegalStateException(e);
        }
        Log.i(TAG, "marked seen: " + m.labels[group]);
    }

    /** Fills the titles of entries that have none (migrated from 0.1, which stored only ids), once the index is known. */
    private void fillTitles(Matcher m) {
        Config c = store.get();
        JSONObject w = new JSONObject();
        try {
            for (int i = 0; i < m.ids.length; i++) {
                JSONObject e = c.work(m.ids[i]);
                if (e != null && e.isNull("title")) w.put(m.ids[i], new JSONObject().put("title", m.titles[i]).put("type", m.types[i]).put("year", m.years[i]));
            }
            if (w.length() > 0) main.post(() -> { try { store.patch(new JSONObject().put("works", w)); } catch (org.json.JSONException ignored) { } });
        } catch (org.json.JSONException e) {
            throw new IllegalStateException(e);
        }
    }

    // ---------- the index (bundled, or rebuilt with catalog-update and hand-added works) ----------

    private volatile String indexCustom = ""; // the custom works the loaded index was built with

    // The index (3 MB) is read on first activity, not in Application.onCreate: background processes never pay for it.
    private synchronized void startLoading() {
        if (loader != null) return;
        loader = new Thread(() -> {
            try {
                long t0 = SystemClock.uptimeMillis();
                store.awaitConnected(1500); // the first frames should use the shared list
                CatalogUpdate.Stored st = storedIndex();
                String sig = customSig(store.get());
                boolean fresh = st != null ? prefs.getString("indexCustom", "").equals(sig) : sig.isEmpty();
                Matcher m = st != null ? new Matcher(st.bin, st.json)
                    : new Matcher(asset("spoilerblock/index.bin"), new String(asset("spoilerblock/index.json"), StandardCharsets.UTF_8));
                indexCustom = st != null ? prefs.getString("indexCustom", "") : "";
                install(m, st != null);
                Log.i(TAG, "index loaded" + (st != null ? " (rebuilt catalog)" : "") + ": " + m.ids.length + " works, " + m.labels.length +
                    " names in " + (SystemClock.uptimeMillis() - t0) + " ms");
                fillTitles(m);
                if (!fresh) rebuildIndex(st != null ? st.added : new ArrayList<>()); // hand-added works changed: swapped in when built
            } catch (Throwable t) {
                fail("index load", t);
            }
        }, "SpoilerBlock-index");
        loader.start();
    }

    /** Main thread: the config seen through this matcher (an index swapped in on another thread may be newer than works). */
    Config.Works worksFor(Matcher m) {
        Config.Works v = works;
        if (v == null || v.seen.length != m.ids.length) works = v = new Config.Works(store.get(), m.ids);
        return v;
    }

    /** Any thread: the first pre-draw may be waiting for it on the main thread. */
    private void install(Matcher m, boolean rebuilt) {
        works = new Config.Works(store.get(), m.ids);
        updatedIndex = rebuilt;
        matcher = m;
        main.post(() -> {
            works = new Config.Works(store.get(), m.ids); // the config may have changed meanwhile
            generation++;
            invalidateAll();
        });
    }

    /** Called from the first pre-draw that has items to judge: waits for the index instead of showing them unjudged. */
    Matcher awaitMatcher() {
        Matcher m = matcher;
        if (m != null || loader == null) return m;
        try {
            long t0 = SystemClock.uptimeMillis();
            // shortcut: blocks the UI thread at most once per process, move to a placeholder cover if 2 s ever shows up
            for (int i = 0; i < 40 && matcher == null && loader.isAlive(); i++) Thread.sleep(50);
            Log.i(TAG, "waited " + (SystemClock.uptimeMillis() - t0) + " ms for the index before first draw");
        } catch (InterruptedException ignored) { }
        return matcher;
    }

    static String customSig(Config c) { return c.custom.length() == 0 ? "" : c.custom.toString(); }

    private Thread rebuilder;

    private synchronized void rebuildIndexAsync() {
        if (rebuilder != null && rebuilder.isAlive()) return; // it re-checks the custom list when done
        rebuilder = new Thread(() -> {
            try {
                CatalogUpdate.Stored st = storedIndex();
                rebuildIndex(st != null ? st.added : new ArrayList<>());
            } catch (Throwable t) {
                Log.w(TAG, "index rebuild failed, hand-added works not matched yet", t);
            }
        }, "SpoilerBlock-rebuild");
        rebuilder.setPriority(Thread.MIN_PRIORITY);
        rebuilder.start();
    }

    /**
     * Bundled catalog + catalog-update works + the config's hand-added works, built with the catalog update's own
     * builder, stored, and swapped in. Repeats while the hand-added list changes meanwhile.
     */
    private void rebuildIndex(List<Catalog.Work> added) throws Exception {
        for (int round = 0; round < 3; round++) {
            Config c = store.get();
            String sig = customSig(c);
            long t0 = SystemClock.uptimeMillis();
            CatalogUpdate.Bundle b = bundle();
            List<Catalog.Work> extra = new ArrayList<>(added);
            extra.addAll(customWorks(c, new Catalog.Ambiguity(b.words)));
            Matcher m;
            if (extra.isEmpty()) {
                indexFile().delete();
                m = new Matcher(asset("spoilerblock/index.bin"), new String(asset("spoilerblock/index.json"), StandardCharsets.UTF_8));
            } else {
                Catalog.Built built = Catalog.buildIndex(Catalog.merge(b.catalog, extra), new Catalog.Words(b.words));
                CatalogUpdate.write(indexFile(), new CatalogUpdate.Stored(b.builtAt, built.bin, built.json, added));
                m = new Matcher(built.bin, built.json);
            }
            prefs.edit().putString("indexCustom", sig).apply();
            indexCustom = sig;
            boolean rebuilt = !extra.isEmpty();
            install(m, rebuilt);
            Log.i(TAG, "index rebuilt with " + c.custom.length() + " hand-added works in " + (SystemClock.uptimeMillis() - t0) + " ms");
            if (customSig(store.get()).equals(sig)) return;
        }
    }

    /** Hand-added works in the catalog's schema. Popularity 0: like a little-known work, a one-word title must be capitalised. */
    static List<Catalog.Work> customWorks(Config c, Catalog.Ambiguity amb) {
        List<Catalog.Work> out = new ArrayList<>();
        for (int i = 0; i < c.custom.length(); i++) {
            JSONObject e = c.custom.optJSONObject(i);
            Catalog.Work w = new Catalog.Work();
            w.id = e.optString("id");
            w.title = e.optString("title");
            w.type = e.optString("type");
            JSONArray a = e.optJSONArray("aliases");
            List<String> al = new ArrayList<>();
            for (int k = 0; a != null && k < a.length(); k++) if (a.optString(k).length() >= 3) al.add(a.optString(k));
            w.aliases = al.toArray(new String[0]);
            w.ambiguous = amb.test(w.title);
            out.add(w);
        }
        return out;
    }

    private CatalogUpdate.Bundle bundle() throws Exception {
        return new CatalogUpdate.Bundle(
            Catalog.readWorks(new java.io.InputStreamReader(app.getAssets().open("spoilerblock/catalog.json"), StandardCharsets.UTF_8)),
            new String(asset("spoilerblock/common-words.txt"), StandardCharsets.UTF_8),
            CatalogUpdate.readClasses(new String(asset("spoilerblock/catalog-classes.json"), StandardCharsets.UTF_8)),
            bundledBuiltAt());
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

    byte[] asset(String name) throws Exception { return readAll(app.getAssets().open(name)); }

    static byte[] readAll(InputStream stream) throws java.io.IOException {
        try (InputStream in = stream) {
            ByteArrayOutputStream out = new ByteArrayOutputStream(1 << 20);
            byte[] buf = new byte[1 << 16];
            for (int n; (n = in.read(buf)) > 0; ) out.write(buf, 0, n);
            return out.toByteArray();
        }
    }

    // ---------- opt-in catalog update (the only network use; see CatalogUpdate) ----------

    private static final long[] CATALOG_INTERVALS = {0, 86400000L, 7 * 86400000L, 30 * 86400000L};
    private volatile boolean updating;
    private String catalogMode = "";
    Runnable catalogListener; // the open settings screen's status line

    private File indexFile() { return new File(app.getFilesDir(), "spoilerblock-index.dat"); }

    /** The rebuilt index, or null when there is none or it was built from an older bundled catalog than this APK's. */
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
        prefs.edit().putInt("catalogAdded", 0).remove("indexCustom").apply();
        return null;
    }

    private String bundledBuiltAt() throws Exception {
        return CatalogUpdate.builtAtOf(new String(asset("spoilerblock/catalog-info.json"), StandardCharsets.UTF_8));
    }

    /** On app start / resume, and from "Update now" (force). Never runs while the mode is off unless forced. */
    void maybeUpdateCatalog(boolean force) {
        long interval = CATALOG_INTERVALS[Math.max(0, Config.CATALOG_MODES.indexOf(store.get().catalogUpdate()))];
        if (!force && (interval == 0 || System.currentTimeMillis() - prefs.getLong("catalogLastCheck", 0) < interval)) return;
        if (updating) return;
        updating = true;
        notifyCatalog();
        Thread t = new Thread(this::updateCatalog, "SpoilerBlock-catalog");
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
            CatalogUpdate.Bundle b = bundle();
            CatalogUpdate.Stored prev = storedIndex();
            u = new CatalogUpdate(CatalogUpdate.httpTransport(), endpoint(), Thread::sleep);
            CatalogUpdate.Result r = u.run(b, prev != null ? prev.added : new ArrayList<>());
            if (r.built != null) {
                r.built = null; // built without the hand-added works: rebuild with them (the same builder)
                b = null;
                rebuildIndex(r.added);
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
            return new String(asset("spoilerblock/test-endpoint.txt"), StandardCharsets.UTF_8).trim();
        } catch (Exception e) {
            return CatalogUpdate.ENDPOINT;
        }
    }

    private void notifyCatalog() { main.post(() -> { Runnable l = catalogListener; if (l != null) l.run(); }); }

    /** "25,467 titles + 3 new · updated 3 days ago", plus the last error in plain words. */
    String catalogStatus() {
        int added = prefs.getInt("catalogAdded", 0);
        Matcher m = matcher;
        int custom = store.get().custom.length();
        String s = (m == null ? "" : String.format(java.util.Locale.US, "%,d titles", m.ids.length - added - custom)) + (added > 0 ? " + " + added + " new" : "");
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
        private final Thread t = new Thread(this, "SpoilerBlock-heap");

        HeapProbe() { t.setDaemon(true); t.start(); }

        @Override public void run() {
            while (running) {
                peak = Math.max(peak, rt.totalMemory() - rt.freeMemory() - base);
                try { Thread.sleep(10); } catch (InterruptedException e) { return; }
            }
        }

        void stop() { running = false; t.interrupt(); }
    }

    // ---------- style "spoilers": the classifier ----------

    private final Map<String, Boolean> verdicts = new java.util.LinkedHashMap<String, Boolean>(64, 0.75f, true) { // main thread
        @Override protected boolean removeEldestEntry(Map.Entry<String, Boolean> e) { return size() > 2000; }
    };
    private final Set<String> classifying = new HashSet<>(); // main thread
    private java.util.concurrent.ExecutorService worker;
    private Classifier classifier; // worker thread only: loaded on the first item to judge with style "spoilers"
    private boolean classifierFailed; // worker thread only

    private void releaseClassifier() {
        if (worker != null) worker.execute(() -> { // no work needs the classifier: no model stays loaded
            try { if (classifier != null) classifier.close(); } catch (Throwable ignored) { }
            classifier = null;
        });
    }

    /** The classifier's verdict on a text: null while it runs (the item stays covered), true for a spoiler. */
    Boolean spoilerVerdict(String text) {
        Boolean v = verdicts.get(text);
        if (v != null) return v;
        if (classifying.add(text)) classifierThread().execute(() -> classify(text));
        return null;
    }

    /** The index, loading it if needed and waiting at most ms (for code that runs before any activity: notifications). */
    Matcher matcherNow(long ms) {
        startLoading();
        long end = SystemClock.uptimeMillis() + ms;
        try {
            while (matcher == null && loader.isAlive() && SystemClock.uptimeMillis() < end) Thread.sleep(20);
        } catch (InterruptedException ignored) { }
        return matcher;
    }

    /**
     * The decision rule for a text alone (no images), any thread: the cover's message, or null when nothing covers.
     * Style "spoilers" runs the classifier and waits for it off the main thread; on the main thread it covers.
     */
    String textCover(Matcher m, String text) throws Exception {
        Config.Works v = new Config.Works(store.get(), m.ids);
        boolean unlisted = store.get().bool("blockUnlisted");
        java.util.List<Integer> all = new ArrayList<>(), spoilers = new ArrayList<>();
        for (int g : m.evaluate(text, v.seen)) {
            int k = Config.group(m.groupWorks(g), v, unlisted);
            if (k == Config.STYLE_ALL) all.add(g); else if (k == Config.STYLE_SPOILERS) spoilers.add(g);
        }
        java.util.List<Integer> named = new ArrayList<>(all);
        named.addAll(spoilers);
        if (named.isEmpty()) return null;
        String label = m.labels[named.get(0)] + (named.size() > 1 ? " and " + (named.size() - 1) + " more" : "");
        if (!all.isEmpty() || Looper.myLooper() == Looper.getMainLooper()) return "Mentions " + label;
        java.util.concurrent.Future<Boolean> f = classifierThread().submit(() -> classifyNow(text));
        Boolean spoiler;
        try { spoiler = f.get(10, java.util.concurrent.TimeUnit.SECONDS); } catch (java.util.concurrent.TimeoutException e) { spoiler = true; }
        return spoiler ? "Spoiler about " + label : null;
    }

    private synchronized java.util.concurrent.ExecutorService classifierThread() {
        if (worker == null) worker = java.util.concurrent.Executors.newSingleThreadExecutor(r -> new Thread(() -> {
            android.os.Process.setThreadPriority(android.os.Process.THREAD_PRIORITY_BACKGROUND); // never compete with frames
            r.run();
        }, "SpoilerBlock-classify"));
        return worker;
    }

    /** Worker thread: true for a spoiler, and on any failure (fail closed). */
    private boolean classifyNow(String text) {
        try {
            if (classifier == null && !classifierFailed) loadClassifier();
            if (classifier != null) return classifier.prob(text.length() > 4000 ? text.substring(0, 4000) : text) >= classifier.threshold;
        } catch (Throwable t) {
            Log.w(TAG, "classifier failed, text stays covered", t);
        }
        return true;
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
            classifier = new Classifier(directAsset("spoilerblock/spoiler/model_int8.onnx"), new String(asset("spoilerblock/spoiler/tokenizer.json"), StandardCharsets.UTF_8),
                new String(asset("spoilerblock/spoiler/meta.json"), StandardCharsets.UTF_8));
            Log.i(TAG, "spoiler model loaded in " + (SystemClock.uptimeMillis() - t0) + " ms, native heap +" +
                (android.os.Debug.getNativeHeapAllocatedSize() - native0) / (1 << 20) + " MB");
        } catch (Throwable t) { // e.g. no ONNX Runtime library for this ABI: every match stays covered, as with style "all"
            classifierFailed = true;
            Log.e(TAG, "spoiler model unavailable, style \"spoilers\" covers every match", t);
        }
    }

    /** A classifier or image verdict came in: every item is judged again on the next frame. */
    void verdictsChanged() {
        generation++;
        invalidateAll();
    }

    // ---------- "Scan images" ----------

    volatile boolean updatedIndex; // the matcher is a rebuilt one, not the bundled index CLIP's groups refer to
    final Images images;

    /** Whether any image could be covered at all under the current settings (else no image is captured or judged). */
    boolean imagesMatter() {
        Config.Works v = works;
        return scanImages && (blockUnlisted || unknownImages || (v != null && v.anyBlocked));
    }

    void invalidateAll() {
        for (View root : scanners.keySet()) root.invalidate();
    }

    // ---------- settings screen ----------

    void openSettings(Activity from) {
        from.startActivity(new Intent(from, SettingsActivity.class));
    }

    // ---------- activities and other windows ----------

    // The settings request is read before the activity's own onCreate can act on its intent (API 29+), onActivityCreated as fallback.
    @Override public void onActivityPreCreated(Activity a, Bundle b) {
        try { checkManageIntent(a); } catch (Throwable t) { fail("onActivityPreCreated", t); }
    }

    @Override public void onActivityCreated(Activity a, Bundle b) {
        try {
            if (a instanceof SettingsActivity) return;
            startLoading();
            checkManageIntent(a);
        } catch (Throwable t) { fail("onActivityCreated", t); }
    }

    @Override public void onActivityResumed(Activity a) {
        if (dead) return;
        try {
            resumed = a;
            activityDecors.put(a.getWindow().getDecorView(), true); // before the window is added (after onResume)
            store.recheck(); // the companion may have been installed or removed meanwhile, or changed while we were frozen
            if (a instanceof SettingsActivity) return; // our own screen lists titles: never covered
            checkManageIntent(a);
            Window w = a.getWindow();
            View decor = w.getDecorView();
            Scanner s = scanners.get(decor);
            if (s == null) {
                scanners.put(decor, s = new Scanner(this, decor, true));
                addShortcutOnce();
            }
            if (!(w.getCallback() instanceof TouchGate)) w.setCallback(new TouchGate(w.getCallback(), s));
            maybeUpdateCatalog(false); // interval elapsed? runs on a background thread, never before or during the first frame's work
            main.removeCallbacks(windowPoll);
            main.post(windowPoll);
            watchWindows();

            if (pendingManage) {
                main.postDelayed(() -> { // trampoline activities finish right away: open from the one that stays
                    if (resumed == a && pendingManage && !a.isFinishing()) { pendingManage = false; openSettings(a); }
                    else Log.i(TAG, "settings not shown on " + a.getClass().getName() + " (resumed: " + (resumed == a) + ", finishing: " + a.isFinishing() + ")");
                }, 700);
            }
        } catch (Throwable t) { fail("onActivityResumed", t); }
    }

    /**
     * Dialogs, bottom sheets, popup menus and drop-downs (search suggestions) are windows of their own, not part of
     * the activity's. Their root views are found through WindowInspector: on every frame for a second after a touch,
     * a key or a resume (what opens such windows), so a new window gets its scanner before its first traversal, and
     * every half second otherwise (a window the app opens on its own may show that long before it is covered).
     */
    private final Runnable windowPoll = new Runnable() {
        @Override public void run() {
            if (dead || resumed == null) return;
            checkWindows();
            main.postDelayed(this, 500);
        }
    };
    private long watchUntil;
    private boolean frameWatch;
    private final android.view.Choreographer.FrameCallback windowFrame = new android.view.Choreographer.FrameCallback() {
        @Override public void doFrame(long t) {
            checkWindows();
            if (!dead && resumed != null && SystemClock.uptimeMillis() < watchUntil) android.view.Choreographer.getInstance().postFrameCallback(this);
            else frameWatch = false;
        }
    };

    /** Main thread: look for new windows on every frame for the next second. */
    void watchWindows() {
        watchUntil = SystemClock.uptimeMillis() + 1000;
        if (!frameWatch && Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            frameWatch = true;
            android.view.Choreographer.getInstance().postFrameCallback(windowFrame);
        }
    }

    void checkWindows() {
        if (dead || Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) return;
        try {
            List<View> roots = android.view.inspector.WindowInspector.getGlobalWindowViews();
            for (View r : roots) {
                // activity windows get their scanner in onActivityResumed; our own screen is never covered (nor its dialogs)
                if (scanners.containsKey(r) || activityDecors.containsKey(r) || activityOf(r.getContext()) instanceof SettingsActivity) continue;
                // not attached yet is fine: a new window's tree listeners are merged in at its first traversal
                scanners.put(r, new Scanner(this, r, false));
                Log.i(TAG, "scanning window " + r.getClass().getName());
            }
            for (java.util.Iterator<Map.Entry<View, Scanner>> i = scanners.entrySet().iterator(); i.hasNext(); ) {
                Map.Entry<View, Scanner> e = i.next();
                if (!e.getValue().activityWindow && !roots.contains(e.getKey())) { e.getValue().detach(); i.remove(); }
            }
        } catch (Throwable t) { fail("window watch", t); }
    }

    // An activity's decor view has a DecorContext, not the activity, as its context: activity windows are known by their decor.
    private final Map<View, Boolean> activityDecors = new WeakHashMap<>();

    static Activity activityOf(android.content.Context c) {
        while (c instanceof android.content.ContextWrapper && !(c instanceof Activity)) c = ((android.content.ContextWrapper) c).getBaseContext();
        return c instanceof Activity ? (Activity) c : null;
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

    /** Long-press the app icon -> "SpolierBlock settings": the way back in when blocking is switched off. */
    private void addShortcutOnce() {
        if (shortcutAdded) return;
        shortcutAdded = true;
        Intent launch = app.getPackageManager().getLaunchIntentForPackage(app.getPackageName());
        ShortcutManager sm = app.getSystemService(ShortcutManager.class);
        if (launch == null || sm == null) return;
        launch.setAction(Intent.ACTION_MAIN).addCategory(EXTRA_MANAGE).putExtra(EXTRA_MANAGE, true);
        try {
            sm.addDynamicShortcuts(Collections.singletonList(new ShortcutInfo.Builder(app, "spoilerblock")
                .setShortLabel("SpolierBlock settings").setIntent(launch).build()));
        } catch (RuntimeException e) { // rate limits / launcher quirks: not fatal
            Log.w(TAG, "shortcut not added: " + e);
        }
    }
}
