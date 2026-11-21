package dev.spoilerblock.demo;

import android.graphics.Rect;
import android.os.SystemClock;
import android.util.Log;
import android.view.View;
import android.view.ViewGroup;
import android.widget.LinearLayout;
import android.widget.TextView;

import androidx.recyclerview.widget.LinearLayoutManager;
import androidx.recyclerview.widget.RecyclerView;

import org.json.JSONArray;
import org.json.JSONObject;

/**
 * Rule 11, "Not this" (--es screen notthis; tools/demo-notthis.sh). Rows by kind: 0 "@alpha_fan" about Breaking Bad,
 * 1 "@beta_fan" about Breaking Bad, 2 "@alpha_fan" about The Last of Us; all covered at first. The demo clears
 * learned.not, then logs where to tap ("NOTTHIS tap <what> x y"): a covered kind-0 row's "Show once", then the "Not this"
 * of the pill it keeps (a cover has no "Not this"); the script taps in order. Checked every frame: once
 * demo.test/@alpha_fan is in learned.not, kind 0 is uncovered and kinds 1 and 2 stay covered; 6 s later the demo removes
 * the key (as the settings' remove control does) and every row is covered again, but the one shown once.
 * The blocker's state is read by reflection (present only in the patched build).
 */
final class NotThis {
    static final String KEY = "demo.test/@alpha_fan";
    private static int phase, uncoveredChecks, coveredAgainChecks;
    private static long since;
    private static String target; // the body of the row shown once

    static Object store(android.content.Context c) throws Exception {
        Class<?> k = Class.forName("dev.spoilerblock.Store");
        java.lang.reflect.Method get = k.getDeclaredMethod("get", android.content.Context.class);
        get.setAccessible(true);
        return get.invoke(null, c);
    }

    private static JSONObject not(Object store) throws Exception {
        java.lang.reflect.Method get = store.getClass().getDeclaredMethod("get");
        get.setAccessible(true);
        Object cfg = get.invoke(store);
        java.lang.reflect.Field f = cfg.getClass().getDeclaredField("learned");
        f.setAccessible(true);
        return ((JSONObject) f.get(cfg)).getJSONObject("not");
    }

    private static void patch(Object store, JSONObject p) throws Exception {
        java.lang.reflect.Method m = store.getClass().getDeclaredMethod("patch", JSONObject.class);
        m.setAccessible(true);
        m.invoke(store, p);
    }

    /** Every learned.not entry with the key removed (keep = false), as the settings' remove control writes it. */
    static void dropKey(Object store) throws Exception { dropKey(store, KEY); }

    static void dropKey(Object store, String key) throws Exception {
        JSONObject not = not(store), out = new JSONObject();
        for (java.util.Iterator<String> i = not.keys(); i.hasNext(); ) {
            String id = i.next();
            JSONArray a = not.getJSONArray(id), rest = new JSONArray();
            for (int k = 0; k < a.length(); k++) if (!key.equals(a.getString(k))) rest.put(a.getString(k));
            if (rest.length() != a.length()) out.put(id, rest.length() == 0 ? JSONObject.NULL : rest);
        }
        if (out.length() > 0) patch(store, new JSONObject().put("learned", new JSONObject().put("not", out)));
    }

    static boolean hasKey(Object store) throws Exception { return hasKey(store, KEY); }

    static boolean hasKey(Object store, String key) throws Exception {
        JSONObject not = not(store);
        for (java.util.Iterator<String> i = not.keys(); i.hasNext(); ) {
            JSONArray a = not.getJSONArray(i.next());
            for (int k = 0; k < a.length(); k++) if (key.equals(a.getString(k))) return true;
        }
        return false;
    }

    /** The screen centre of a visible button (a Cover field: "once", "not") of the cover on item, or null. */
    private static int[] button(View item, String field) throws Exception {
        Class<?> sbk = Class.forName("dev.spoilerblock.SpoilerBlock");
        java.lang.reflect.Field fi = sbk.getDeclaredField("I"), fs = sbk.getDeclaredField("scanners");
        fi.setAccessible(true);
        fs.setAccessible(true);
        Object sb = fi.get(null);
        for (Object scanner : ((java.util.Map<?, ?>) fs.get(sb)).values()) {
            java.lang.reflect.Field fc = scanner.getClass().getDeclaredField("covers");
            fc.setAccessible(true);
            for (Object cover : (java.util.List<?>) fc.get(scanner)) {
                java.lang.reflect.Field it = cover.getClass().getDeclaredField("item"), nt = cover.getClass().getDeclaredField(field);
                it.setAccessible(true);
                nt.setAccessible(true);
                if (it.get(cover) != item) continue;
                View b = (View) nt.get(cover);
                if (b.getVisibility() != View.VISIBLE || b.getWidth() == 0) return null;
                java.lang.reflect.Method bo = cover.getClass().getDeclaredMethod("boundsOf", View.class);
                bo.setAccessible(true);
                Rect r = (Rect) bo.invoke(cover, b);
                int[] l = new int[2];
                item.getLocationOnScreen(l);
                return new int[]{l[0] + r.centerX(), l[1] + r.centerY()};
            }
        }
        return null;
    }

    static final class Row extends LinearLayout {
        int kind;
        long boundAt;

        Row(MainActivity a) {
            super(a);
            setOrientation(VERTICAL);
            setPadding(a.dp(16), a.dp(12), a.dp(16), a.dp(12));
            setBackgroundColor(0xFFFFFFFF);
            setLayoutParams(new RecyclerView.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));
            setMinimumHeight(a.dp(170));
            addView(new TextView(a)); // the author's handle, alone in its view (as X shows it)
            TextView body = new TextView(a);
            body.setTextSize(18);
            addView(body);
        }
    }

    static View build(MainActivity a) {
        Object st;
        try {
            st = store(a);
            java.lang.reflect.Method await = st.getClass().getDeclaredMethod("awaitConnected", long.class);
            await.setAccessible(true);
            await.invoke(st, 3000L); // else the companion's list, fetched a moment later, replaces this patch
            dropKey(st);
        } catch (Exception e) {
            Log.e(MainActivity.TAG, "MISMATCH notthis: cannot reach the blocker's config (unpatched build?)", e);
            return new View(a);
        }
        Object store = st;
        phase = 0;
        target = null;
        since = SystemClock.uptimeMillis();
        RecyclerView rv = new MainActivity.FeedList(a);
        rv.setLayoutManager(new LinearLayoutManager(a));
        rv.setAdapter(new RecyclerView.Adapter<RecyclerView.ViewHolder>() {
            @Override public int getItemCount() { return 30; }
            @Override public RecyclerView.ViewHolder onCreateViewHolder(ViewGroup parent, int type) { return new RecyclerView.ViewHolder(new Row(a)) { }; }
            @Override public void onBindViewHolder(RecyclerView.ViewHolder h, int pos) {
                Row r = (Row) h.itemView;
                r.kind = pos % 3;
                ((TextView) r.getChildAt(0)).setText(r.kind == 1 ? "@beta_fan" : "@alpha_fan");
                ((TextView) r.getChildAt(1)).setText(r.kind == 2 ? "The Last of Us episode three wrecked me, post " + pos
                    : "Breaking Bad finale still hurts, what a show, post " + pos);
                r.boundAt = SystemClock.uptimeMillis();
            }
        });
        Runnable tick = new Runnable() { // a still list draws no frames: keep the per-frame check running until the summary
            @Override public void run() { rv.invalidate(); if (phase < 5) rv.postDelayed(this, 100); }
        };
        rv.post(tick);
        rv.getViewTreeObserver().addOnDrawListener(() -> {
            long now = SystemClock.uptimeMillis();
            try {
                if (phase == 2 && hasKey(store)) { phase = 3; since = now; Log.i(MainActivity.TAG, "notthis: key " + KEY + " written"); }
                if (phase == 3 && now - since > 6000) { dropKey(store); phase = 4; since = now; Log.i(MainActivity.TAG, "notthis: key removed"); }
                if (phase == 4 && now - since > 4500) {
                    phase = 5;
                    Log.i(MainActivity.TAG, "notthis summary: uncovered checks " + uncoveredChecks + ", covered-again checks " + coveredAgainChecks + ", mismatches " + MainActivity.mismatches);
                }
                if (phase <= 2 && now - since > 20000) { Log.e(MainActivity.TAG, "MISMATCH notthis: phase " + phase + " timed out"); MainActivity.mismatches++; phase = 5; }
                for (int i = 0; i < rv.getChildCount(); i++) {
                    if (!(rv.getChildAt(i) instanceof Row)) continue;
                    Row r = (Row) rv.getChildAt(i);
                    if (r.getTop() < 0 || r.getBottom() > rv.getHeight() || now - r.boundAt < 800) continue; // settled, fully shown rows
                    boolean covered = MainActivity.covered(r);
                    String body = String.valueOf(((TextView) r.getChildAt(1)).getText()), why = null;
                    // not the top row: edge to edge, its pill lies under the status bar, which takes the tap
                    if (phase == 0 && covered && r.kind == 0 && r.getTop() > rv.getHeight() / 5) {
                        int[] b = button(r, "once");
                        if (b != null) { Log.i(MainActivity.TAG, "NOTTHIS tap once " + b[0] + " " + b[1]); target = body; phase = 1; since = now; }
                    } else if (phase == 1 && body.equals(target) && now - since > 600) {
                        int[] b = button(r, "not"); // visible only on the pill
                        if (b != null) { Log.i(MainActivity.TAG, "NOTTHIS tap not " + b[0] + " " + b[1]); phase = 2; since = now; }
                    }
                    if (phase == 3 && now - since > 1000) {
                        if (covered != (r.kind != 0)) why = r.kind == 0 ? "still covered after Not this" : "uncovered by another source's or work's Not this";
                        else uncoveredChecks++;
                    }
                    if (phase == 4 && now - since > 1500 && !body.equals(target)) { // the row shown once keeps its pill
                        if (!covered) why = "not covered again after the key was removed";
                        else coveredAgainChecks++;
                    }
                    if (why != null) { MainActivity.mismatches++; Log.e(MainActivity.TAG, "MISMATCH notthis row kind " + r.kind + " \"" + ((TextView) r.getChildAt(1)).getText() + "\" " + why); }
                }
            } catch (Exception e) {
                Log.e(MainActivity.TAG, "MISMATCH notthis: reflection failed", e);
                MainActivity.mismatches++;
                phase = 5;
            }
        });
        return rv;
    }
}
