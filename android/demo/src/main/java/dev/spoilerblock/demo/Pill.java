package dev.spoilerblock.demo;

import android.graphics.Rect;
import android.os.SystemClock;
import android.util.Log;
import android.view.View;
import android.view.ViewGroup;
import android.view.accessibility.AccessibilityNodeInfo;
import android.view.accessibility.AccessibilityNodeProvider;
import android.widget.TextView;

import androidx.recyclerview.widget.LinearLayoutManager;
import androidx.recyclerview.widget.RecyclerView;

import java.util.LinkedHashMap;
import java.util.Map;

/**
 * The pill after "Show once" (--es screen pill; tools/demo-pill.sh). Rows by "@pill_fan" about Breaking Bad, all covered,
 * each clickable. The demo walks the steps and logs where to tap ("PILL tap <what> x y", read from the blocker's
 * accessibility nodes); the script taps. Steps: Show once -> the row is shown with a pill whose nodes are "Not this" and
 * "Cover again" -> a tap on the row outside the pill reaches the row -> Cover again -> covered -> Show once -> the pill's
 * Not this -> demo.test/@pill_fan is in learned.not and the row has no cover and no pill. A tap on a cover or a pill that
 * reaches the row is a mismatch. The key is removed at the start and at the end.
 */
final class Pill {
    static final String KEY = "demo.test/@pill_fan";
    private static int phase, uncovered;
    private static long since;
    private static String target;
    private static boolean clicked;

    /** The blocker's Cover object on item, or null. */
    private static Object cover(View item) throws Exception {
        Class<?> sbk = Class.forName("dev.spoilerblock.SpoilerBlock");
        java.lang.reflect.Field fi = sbk.getDeclaredField("I"), fs = sbk.getDeclaredField("scanners");
        fi.setAccessible(true);
        fs.setAccessible(true);
        for (Object scanner : ((Map<?, ?>) fs.get(fi.get(null))).values()) {
            java.lang.reflect.Field fc = scanner.getClass().getDeclaredField("covers");
            fc.setAccessible(true);
            for (Object c : (java.util.List<?>) fc.get(scanner)) {
                java.lang.reflect.Field it = c.getClass().getDeclaredField("item");
                it.setAccessible(true);
                if (it.get(c) == item) return c;
            }
        }
        return null;
    }

    private static boolean isPill(Object cover) throws Exception {
        java.lang.reflect.Field f = cover.getClass().getDeclaredField("pill");
        f.setAccessible(true);
        return f.getBoolean(cover);
    }

    /** The blocker's accessibility nodes on v: label -> bounds on screen (what TalkBack can activate). */
    private static Map<String, Rect> nodes(View v) {
        Map<String, Rect> out = new LinkedHashMap<>();
        AccessibilityNodeProvider p = v.getAccessibilityNodeProvider();
        for (int id = 0; p != null && id < 16; id++) {
            AccessibilityNodeInfo n = p.createAccessibilityNodeInfo(id);
            if (n == null) break;
            Rect r = new Rect();
            n.getBoundsInScreen(r);
            if (n.getContentDescription() != null) out.put(n.getContentDescription().toString(), r);
        }
        return out;
    }

    private static boolean pillNodes(View v) {
        AccessibilityNodeProvider p = v.getAccessibilityNodeProvider();
        return p != null && p.getClass().getSimpleName().equals("PillNodes");
    }

    private static void tap(String what, Rect r) {
        Log.i(MainActivity.TAG, "PILL tap " + what + " " + r.centerX() + " " + r.centerY());
    }

    private static void step(int p, long now, String log) {
        phase = p;
        since = now;
        if (log != null) Log.i(MainActivity.TAG, "pill: " + log);
    }

    static View build(MainActivity a) {
        Object st;
        try {
            st = NotThis.store(a);
            java.lang.reflect.Method await = st.getClass().getDeclaredMethod("awaitConnected", long.class);
            await.setAccessible(true);
            await.invoke(st, 3000L); // else the companion's list, fetched a moment later, replaces this patch
            NotThis.dropKey(st, KEY);
        } catch (Exception e) {
            Log.e(MainActivity.TAG, "MISMATCH pill: cannot reach the blocker's config (unpatched build?)", e);
            return new View(a);
        }
        Object store = st;
        phase = 0;
        since = SystemClock.uptimeMillis();
        RecyclerView rv = new MainActivity.FeedList(a);
        rv.setLayoutManager(new LinearLayoutManager(a));
        rv.setAdapter(new RecyclerView.Adapter<RecyclerView.ViewHolder>() {
            @Override public int getItemCount() { return 20; }
            @Override public RecyclerView.ViewHolder onCreateViewHolder(ViewGroup parent, int type) {
                NotThis.Row r = new NotThis.Row(a);
                r.setOnClickListener(v -> {
                    String body = String.valueOf(((TextView) r.getChildAt(1)).getText());
                    if (!body.equals(target)) return;
                    if (phase == 2) { clicked = true; return; }
                    MainActivity.mismatches++;
                    Log.e(MainActivity.TAG, "MISMATCH pill: a tap meant for the cover or the pill reached the row (phase " + phase + ")");
                });
                return new RecyclerView.ViewHolder(r) { };
            }
            @Override public void onBindViewHolder(RecyclerView.ViewHolder h, int pos) {
                NotThis.Row r = (NotThis.Row) h.itemView;
                ((TextView) r.getChildAt(0)).setText("@pill_fan");
                ((TextView) r.getChildAt(1)).setText("Breaking Bad finale still hurts, what a show, post " + pos);
                r.boundAt = SystemClock.uptimeMillis();
            }
        });
        Runnable tick = new Runnable() { // a still list draws no frames: keep the per-frame check running until the summary
            @Override public void run() { rv.invalidate(); if (phase < 6) rv.postDelayed(this, 100); }
        };
        rv.post(tick);
        rv.getViewTreeObserver().addOnDrawListener(() -> {
            if (phase >= 6) return;
            long now = SystemClock.uptimeMillis();
            try {
                if (now - since > (phase == 0 ? 25000 : 15000)) { // the first step waits for the index too
                    MainActivity.mismatches++;
                    Log.e(MainActivity.TAG, "MISMATCH pill: step " + phase + " timed out");
                    NotThis.dropKey(store, KEY);
                    step(6, now, "summary: failed at step " + phase + ", mismatches " + MainActivity.mismatches);
                    return;
                }
                NotThis.Row row = null;
                for (int i = 0; i < rv.getChildCount(); i++) {
                    if (!(rv.getChildAt(i) instanceof NotThis.Row)) continue;
                    NotThis.Row r = (NotThis.Row) rv.getChildAt(i);
                    if (r.getTop() < 0 || r.getBottom() > rv.getHeight() || now - r.boundAt < 800) continue; // settled, fully shown rows
                    String body = String.valueOf(((TextView) r.getChildAt(1)).getText());
                    // not the top row: edge to edge, its pill lies under the status bar, which takes the tap
                    if (phase == 0 && target == null && r.getTop() > rv.getHeight() / 5 && MainActivity.covered(r) && nodes(r).containsKey("Show once")) target = body;
                    if (body.equals(target)) row = r;
                }
                if (row == null) return;
                boolean covered = MainActivity.covered(row);
                Object cv = cover(row);
                Map<String, Rect> n = nodes(row);
                if (now - since < 600) return; // the last tap's effect settles
                switch (phase) {
                    case 0: // a covered row: Show once
                        tap("once", n.get("Show once"));
                        step(1, now, null);
                        break;
                    case 1: // shown, with a pill of two buttons, the content readable
                        if (cv != null && isPill(cv) && !covered && pillNodes(row) && n.containsKey("Not this") && n.containsKey("Cover again")) {
                            Log.i(MainActivity.TAG, "pill: buttons " + n.keySet() + " at " + n.values());
                            clicked = false;
                            int[] l = new int[2];
                            row.getLocationOnScreen(l); // left quarter, lower quarter: far from the pill in the top end corner
                            Log.i(MainActivity.TAG, "PILL tap row " + (l[0] + row.getWidth() / 4) + " " + (l[1] + row.getHeight() * 3 / 4));
                            step(2, now, null);
                        }
                        break;
                    case 2: // the row got the tap outside the pill, and the pill is still there
                        if (clicked) {
                            if (cv == null || !isPill(cv)) { MainActivity.mismatches++; Log.e(MainActivity.TAG, "MISMATCH pill: the pill went after a tap on the row"); }
                            Log.i(MainActivity.TAG, "pill: row tap outside the pill reached the demo");
                            tap("again", n.get("Cover again"));
                            step(3, now, null);
                        }
                        break;
                    case 3: // Cover again: covered, not a pill
                        if (covered && cv != null && !isPill(cv) && n.containsKey("Show once")) {
                            Log.i(MainActivity.TAG, "pill: covered again");
                            tap("once", n.get("Show once"));
                            step(4, now, null);
                        }
                        break;
                    case 4: // the pill again: Not this
                        if (cv != null && isPill(cv) && n.containsKey("Not this")) {
                            tap("not", n.get("Not this"));
                            step(5, now, null);
                        }
                        break;
                    case 5: // the key written, the row uncovered with no pill, and it stays so
                        boolean ok = NotThis.hasKey(store, KEY) && cv == null && !covered;
                        if (now - since > 1500) {
                            if (!ok) { MainActivity.mismatches++; Log.e(MainActivity.TAG, "MISMATCH pill: after Not this key=" + NotThis.hasKey(store, KEY) + " cover=" + (cv != null) + " covered=" + covered); }
                            else uncovered++;
                        }
                        if (now - since > 3500) {
                            NotThis.dropKey(store, KEY);
                            step(6, now, "summary: done, key " + KEY + " written, uncovered checks " + uncovered + ", mismatches " + MainActivity.mismatches);
                        }
                        break;
                    default:
                }
            } catch (Exception e) {
                Log.e(MainActivity.TAG, "MISMATCH pill: reflection failed", e);
                MainActivity.mismatches++;
                phase = 6;
            }
        });
        return rv;
    }
}
