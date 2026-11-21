package dev.spoilerblock.demo;

import android.os.SystemClock;
import android.util.Log;
import android.view.View;
import android.view.ViewGroup;
import android.widget.LinearLayout;
import android.widget.TextView;

import androidx.recyclerview.widget.LinearLayoutManager;
import androidx.recyclerview.widget.RecyclerView;

/**
 * Rule 10, videos with no caption (--es screen captionless --ez listed true|false). The test first sets the blocker's
 * settings.captionlessVideos to ["demo.test"] or [] (by reflection on dev.spoilerblock.Store, present only in the
 * patched build). Rows: a player with only a ticking counter (no words), a player under "Monday mood" (2 words) and a
 * player under a clean 11-word caption. Each player attaches 400 ms after its row does and then comes and goes every
 * 1.2 s, as feed players attach lazily. Checked every frame: listed, a short row whose player has been attached for
 * 700 ms is covered, and once covered it stays covered while the row holds the same post; the captioned row and, when
 * not listed, every row is never covered.
 */
final class Captionless {
    static int coveredBinds, binds;

    static void configure(android.content.Context c, boolean listed) {
        try {
            Class<?> k = Class.forName("dev.spoilerblock.Store");
            java.lang.reflect.Method get = k.getDeclaredMethod("get", android.content.Context.class), patch = k.getDeclaredMethod("patch", org.json.JSONObject.class);
            java.lang.reflect.Method await = k.getDeclaredMethod("awaitConnected", long.class);
            get.setAccessible(true);
            patch.setAccessible(true);
            await.setAccessible(true);
            Object store = get.invoke(null, c);
            await.invoke(store, 3000L); // else the companion's list, fetched a moment later, replaces this app's patch
            org.json.JSONArray sites = new org.json.JSONArray();
            if (listed) sites.put("demo.test");
            patch.invoke(store, new org.json.JSONObject().put("settings", new org.json.JSONObject().put("captionlessVideos", sites)));
            Log.i(MainActivity.TAG, "captionless: demo.test " + (listed ? "listed" : "not listed"));
        } catch (Exception e) {
            Log.e(MainActivity.TAG, "MISMATCH captionless: cannot set the blocker's settings (unpatched build?)", e);
        }
    }

    /** A row whose player attaches late and comes and goes. */
    static final class Row extends LinearLayout implements Runnable {
        final MainActivity.Video video;
        boolean short_, wasCovered, counted;
        long videoSince;

        Row(MainActivity a) {
            super(a);
            setOrientation(VERTICAL);
            setPadding(a.dp(16), a.dp(12), a.dp(16), a.dp(12));
            setBackgroundColor(0xFFFFFFFF);
            setLayoutParams(new RecyclerView.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));
            setMinimumHeight(a.dp(300));
            addView(new TextView(a)); // caption (may be empty)
            addView(new MainActivity.Counter(a));
            video = new MainActivity.Video(a, false);
        }

        @Override public void run() { // the player attaches, later leaves, and comes back
            if (video.getParent() == null) { addView(video, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ((MainActivity) getContext()).dp(200))); videoSince = SystemClock.uptimeMillis(); }
            else { removeView(video); videoSince = 0; }
            postDelayed(this, 1200);
        }
        @Override protected void onAttachedToWindow() { super.onAttachedToWindow(); postDelayed(this, 400); }
        @Override protected void onDetachedFromWindow() { removeCallbacks(this); if (video.getParent() != null) removeView(video); videoSince = 0; super.onDetachedFromWindow(); }
    }

    static View build(MainActivity a, boolean listed) {
        configure(a, listed);
        RecyclerView rv = new MainActivity.FeedList(a);
        rv.setLayoutManager(new LinearLayoutManager(a));
        rv.setAdapter(new RecyclerView.Adapter<RecyclerView.ViewHolder>() {
            @Override public int getItemCount() { return 30; }
            @Override public RecyclerView.ViewHolder onCreateViewHolder(ViewGroup parent, int type) { return new RecyclerView.ViewHolder(new Row(a)) { }; }
            @Override public void onBindViewHolder(RecyclerView.ViewHolder h, int pos) {
                Row r = (Row) h.itemView;
                int kind = pos % 3; // 0: no words, 1: "Monday mood", 2: a clean caption of 4+ words
                ((TextView) r.getChildAt(0)).setText(kind == 0 ? "" : kind == 1 ? "Monday mood" : MainActivity.body(1));
                r.short_ = kind != 2;
                r.wasCovered = r.counted = false;
                binds++;
            }
        });
        rv.getViewTreeObserver().addOnDrawListener(() -> {
            MainActivity.frames++;
            long now = SystemClock.uptimeMillis();
            for (int i = 0; i < rv.getChildCount(); i++) {
                if (!(rv.getChildAt(i) instanceof Row)) continue;
                Row r = (Row) rv.getChildAt(i);
                if (r.getBottom() <= 0 || r.getTop() >= rv.getHeight()) continue;
                boolean covered = MainActivity.covered(r);
                MainActivity.checks++;
                String why = null;
                if (covered && (!listed || !r.short_)) why = "covered";
                else if (!covered && r.wasCovered) why = "uncovered again (flicker)";
                else if (!covered && listed && r.short_ && r.videoSince > 0 && now - r.videoSince > 700 && r.getTop() >= 0 && r.getBottom() <= rv.getHeight()) why = "not covered with its player on";
                if (why != null) { MainActivity.mismatches++; Log.e(MainActivity.TAG, "MISMATCH captionless frame " + MainActivity.frames + " row \"" + ((TextView) r.getChildAt(0)).getText() + "\" " + why); }
                if (covered) { r.wasCovered = true; if (!r.counted) { r.counted = true; coveredBinds++; } }
            }
        });
        return rv;
    }
}
