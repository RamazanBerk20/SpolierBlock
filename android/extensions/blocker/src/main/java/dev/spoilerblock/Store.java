package dev.spoilerblock;

import android.content.Context;
import android.content.SharedPreferences;
import android.database.ContentObserver;
import android.net.Uri;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;

import org.json.JSONException;
import org.json.JSONObject;

import java.util.Arrays;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;

/**
 * The one config of this process. In a patched app it is the companion app's (through its provider) when the companion
 * is installed, and the app's own private copy otherwise; in the companion it is the companion's own. Readers get an
 * immutable snapshot ({@link #get()}); writers send merge patches ({@link #patch}). Listeners run on the main thread.
 */
final class Store {
    static final String COMPANION = "dev.spoilerblock";
    static final String AUTHORITY = "dev.spoilerblock.config";
    static final Uri URI = Uri.parse("content://" + AUTHORITY + "/config");
    /** Apps the companion answers: the patched hosts (YouTube under both of its names) and the test apps. */
    static final Set<String> CALLERS = new HashSet<>(Arrays.asList("com.google.android.youtube", "app.morphe.android.youtube",
        "com.twitter.android", "com.instagram.android", "dev.spoilerblock.demo", "dev.spoilerblock.demo2", COMPANION));
    static final String TAG = SpoilerBlock.TAG;

    /** The provider's caller check (getCallingPackage(), which the system verifies against the calling uid). */
    static boolean allowed(String caller) { return caller != null && CALLERS.contains(caller); }

    private static Store I;

    static synchronized Store get(Context c) {
        if (I == null) I = new Store(c.getApplicationContext());
        return I;
    }

    final Context app;
    final SharedPreferences prefs;
    final boolean owner; // this process is the companion: its own preferences are the shared config
    private final Handler main = new Handler(Looper.getMainLooper());
    private final ExecutorService io = Executors.newSingleThreadExecutor(r -> new Thread(r, "SpoilerBlock-config"));
    private final List<Runnable> listeners = new CopyOnWriteArrayList<>();
    private final CountDownLatch connected = new CountDownLatch(1);
    private volatile Config cfg;
    volatile boolean remote; // the companion's provider holds the config
    private boolean observing;

    private Store(Context app) {
        this.app = app;
        prefs = app.getSharedPreferences("spoilerblock", 0);
        owner = COMPANION.equals(app.getPackageName());
        cfg = local();
        if (owner) connected.countDown(); else io.execute(this::connect);
    }

    /** The current config. Treat it as read-only: change it with patch(). */
    Config get() { return cfg; }

    void listen(Runnable r) { listeners.add(r); }
    void unlisten(Runnable r) { listeners.remove(r); }

    /** Waits (at most ms) until the first look for the companion is done, so the first frames use the shared list. */
    void awaitConnected(long ms) {
        try { connected.await(ms, TimeUnit.MILLISECONDS); } catch (InterruptedException ignored) { }
    }

    // ---------- the app's own copy (and its 0.1 predecessor) ----------

    private Config local() {
        String json = prefs.getString("config", null);
        if (json != null) return Config.parse(json);
        if (!prefs.contains("seen") && !prefs.contains("mode") && !prefs.contains("enabled") && !prefs.contains("scanImages") && !prefs.contains("catalogMode"))
            return new Config();
        Config c = Config.migrate(prefs.getStringSet("seen", null), prefs.getString("mode", "any"), prefs.getBoolean("enabled", true),
            prefs.getBoolean("scanImages", true), prefs.getString("catalogMode", "off"), System.currentTimeMillis());
        prefs.edit().putString("config", c.json()).remove("seen").remove("mode").remove("enabled").remove("scanImages").remove("catalogMode").apply();
        Log.i(TAG, "settings migrated from 0.1: " + c.works.length() + " seen works");
        return c;
    }

    // ---------- the companion ----------

    private Config fetch() {
        Bundle b = app.getContentResolver().call(URI, "get", null, null);
        if (b == null || b.getString("json") == null) throw new IllegalStateException("no answer");
        return Config.parse(b.getString("json"));
    }

    /** IO thread: switches to the companion when it answers, merging this app's own list into it once. */
    private void connect() {
        try {
            if (app.getPackageManager().resolveContentProvider(AUTHORITY, 0) == null) {
                if (remote) fallBack("companion uninstalled");
                return;
            }
            Config shared = fetch();
            if (!prefs.getBoolean("companionMerged", false)) {
                JSONObject p = shared.absorb(local());
                if (p.length() > 0) {
                    Bundle b = new Bundle();
                    b.putString("json", p.toString());
                    app.getContentResolver().call(URI, "patch", null, b);
                    shared = fetch();
                    Log.i(TAG, "this app's list merged into the companion's: " + p);
                }
                prefs.edit().putBoolean("companionMerged", true).apply();
            }
            if (!observing) {
                observing = true;
                app.getContentResolver().registerContentObserver(URI, false, new ContentObserver(null) {
                    @Override public void onChange(boolean self) { io.execute(Store.this::refresh); }
                });
            }
            boolean was = remote;
            remote = true;
            if (!was) Log.i(TAG, "using the companion's settings");
            publish(shared);
        } catch (RuntimeException e) { // not installed, refused (SecurityException), or died mid-call
            if (remote) fallBack(e.toString());
            else Log.i(TAG, "companion not used: " + e);
        } finally {
            connected.countDown();
        }
    }

    private void refresh() {
        if (!remote) return;
        try { publish(fetch()); } catch (RuntimeException e) { fallBack(e.toString()); }
    }

    /** The companion went away: keep working on the last shared list, as this app's own. */
    private void fallBack(String why) {
        remote = false;
        prefs.edit().putString("config", cfg.json()).putBoolean("companionMerged", false).apply();
        Log.w(TAG, "companion unavailable (" + why + "), using this app's own settings");
    }

    /** On every activity resume: the companion may have been installed or removed since. Cheap when nothing changed. */
    void recheck() {
        if (!owner) io.execute(() -> {
            boolean present = app.getPackageManager().resolveContentProvider(AUTHORITY, 0) != null;
            if (present != remote) connect();
        });
    }

    private void publish(Config c) {
        if (c.json().equals(cfg.json())) return;
        cfg = c;
        if (remote) prefs.edit().putString("config", c.json()).apply(); // mirror: a fallback starts from the shared list
        main.post(() -> { for (Runnable r : listeners) r.run(); });
    }

    // ---------- changes ----------

    /** Applies a merge patch here at once, then where the config lives (the companion or this app's preferences). */
    synchronized void patch(JSONObject p) {
        Config next = cfg.copy().apply(p);
        cfg = next;
        main.post(() -> { for (Runnable r : listeners) r.run(); });
        if (owner || !remote) {
            prefs.edit().putString("config", next.json()).apply();
            if (owner) app.getContentResolver().notifyChange(URI, null);
            return;
        }
        String json = p.toString();
        io.execute(() -> {
            try {
                Bundle b = new Bundle();
                b.putString("json", json);
                app.getContentResolver().call(URI, "patch", null, b);
            } catch (RuntimeException e) {
                fallBack(e.toString()); // the change stays: it is in the copy this app now owns
            }
        });
    }

    /** Replaces the whole config (import "Replace", reset). */
    void replace(Config c) {
        try {
            JSONObject p = c.toJson();
            JSONObject works = new JSONObject(c.works.toString());
            for (java.util.Iterator<String> i = cfg.works.keys(); i.hasNext(); ) { String id = i.next(); if (!works.has(id)) works.put(id, JSONObject.NULL); }
            p.put("works", works);
            patch(p);
        } catch (JSONException e) {
            throw new IllegalStateException(e);
        }
    }

    /** Provider side (companion only): the answer to a host's call. */
    Bundle answer(String method, Bundle extras) {
        Bundle out = new Bundle();
        if ("patch".equals(method)) {
            try {
                patch(new JSONObject(extras.getString("json", "{}")));
            } catch (JSONException e) {
                throw new IllegalArgumentException("bad patch");
            }
        } else if (!"get".equals(method)) {
            throw new IllegalArgumentException("unknown method " + method);
        }
        out.putString("json", cfg.json());
        return out;
    }
}
