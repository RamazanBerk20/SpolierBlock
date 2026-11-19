package dev.spoilerblock.demo;

import android.media.MediaPlayer;
import android.util.Log;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.widget.FrameLayout;
import android.widget.TextView;

import androidx.recyclerview.widget.LinearLayoutManager;
import androidx.recyclerview.widget.PagerSnapHelper;
import androidx.recyclerview.widget.RecyclerView;

/**
 * Full-screen pages that play sound and video (MediaPlayer on a looping file, a TextureView), one page per swipe, like
 * Reels and Shorts: even pages carry a spoiler caption (covered, so they must be silent), odd ones a clean caption.
 */
final class Reels {
    static View build(MainActivity a) {
        RecyclerView rv = new MainActivity.FeedList(a);
        rv.setLayoutManager(new LinearLayoutManager(a));
        new PagerSnapHelper().attachToRecyclerView(rv);
        rv.setAdapter(new RecyclerView.Adapter<RecyclerView.ViewHolder>() {
            @Override public int getItemCount() { return 20; }
            @Override public RecyclerView.ViewHolder onCreateViewHolder(ViewGroup parent, int type) {
                FrameLayout page = new FrameLayout(a) {
                    MediaPlayer mp;
                    @Override protected void onAttachedToWindow() {
                        super.onAttachedToWindow();
                        try {
                            mp = new MediaPlayer();
                            mp.setDataSource(Sound.wav(a).getPath());
                            mp.setLooping(true);
                            mp.prepare();
                            mp.start();
                        } catch (Exception e) { Log.e(MainActivity.TAG, "reel sound", e); }
                    }
                    @Override protected void onDetachedFromWindow() {
                        if (mp != null) { mp.release(); mp = null; }
                        super.onDetachedFromWindow();
                    }
                };
                page.setLayoutParams(new RecyclerView.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
                page.addView(new MainActivity.Video(a, false));
                TextView caption = new TextView(a);
                caption.setTextSize(18);
                caption.setTextColor(0xFFFFFFFF);
                caption.setPadding(a.dp(16), a.dp(16), a.dp(16), a.dp(48));
                page.addView(caption, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.BOTTOM));
                return new RecyclerView.ViewHolder(page) { };
            }
            @Override public void onBindViewHolder(RecyclerView.ViewHolder h, int pos) {
                int post = pos % 2 == 0 ? 0 : 1; // "Breaking Bad season 5 finale was insane" / "Had a lovely walk ..."
                h.itemView.setTag(post);
                ((TextView) ((FrameLayout) h.itemView).getChildAt(1)).setText(MainActivity.body(post));
            }
        });
        rv.getViewTreeObserver().addOnDrawListener(() -> { MainActivity.frames++; a.checkChildren(rv); Sound.check(rv, "reels"); });
        rv.post(() -> tapWrapper(a)); // after the activity resumed, as Instagram's viewer does when it opens
        return rv;
    }

    /**
     * Instagram's Reels viewer wraps the activity window's callback (after SpoilerBlock's gate) with a gesture handler
     * that passes moves on but keeps a plain tap to itself (static reading of 452.1: X.0qQM installs X.0qe2). This one
     * does the same: a tap (no move past the slop) is "pause/play" and never reaches the views or the callbacks within.
     */
    static void tapWrapper(android.app.Activity a) {
        android.view.Window w = a.getWindow();
        android.view.Window.Callback inner = w.getCallback();
        int slop = android.view.ViewConfiguration.get(a).getScaledTouchSlop();
        float[] down = new float[2];
        boolean[] moved = new boolean[1];
        w.setCallback((android.view.Window.Callback) java.lang.reflect.Proxy.newProxyInstance(Reels.class.getClassLoader(),
            new Class<?>[]{android.view.Window.Callback.class}, (proxy, m, args) -> {
                if (m.getName().equals("dispatchTouchEvent")) {
                    android.view.MotionEvent e = (android.view.MotionEvent) args[0];
                    int act = e.getActionMasked();
                    if (act == android.view.MotionEvent.ACTION_DOWN) { down[0] = e.getRawX(); down[1] = e.getRawY(); moved[0] = false; }
                    else if (act == android.view.MotionEvent.ACTION_MOVE && Math.hypot(e.getRawX() - down[0], e.getRawY() - down[1]) > slop) moved[0] = true;
                    if (act == android.view.MotionEvent.ACTION_UP && !moved[0]) { Log.i(MainActivity.TAG, "reels: tap kept by the app's window wrapper"); return true; }
                }
                try { return m.invoke(inner, args); } catch (java.lang.reflect.InvocationTargetException x) { throw x.getCause(); }
            }));
    }
}
