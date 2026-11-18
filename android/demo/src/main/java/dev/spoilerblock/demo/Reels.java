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
        return rv;
    }
}
