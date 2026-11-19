package dev.spoilerblock.demo;

import android.util.Log;
import android.view.ViewGroup;
import android.view.ViewGroupOverlay;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.TextView;

import androidx.recyclerview.widget.LinearLayoutManager;
import androidx.recyclerview.widget.RecyclerView;

/**
 * A watch page, like YouTube's: a player pinned at the top (a TextureView with sound, in a container) and a list of
 * related posts scrolling beneath it, every other one covered. The player the user chose is never the covered rows'
 * own preview: it must never be shaded (the blocker never touches its overlay), muted, or lose a tap to a cover of a
 * row that has scrolled under it.
 */
final class Watch {
    static int playerShades, playerTaps;

    /** Only the blocker calls getOverlay() on these views (the framework uses its field): to shade them. */
    private static void shaded(String what) {
        playerShades++;
        MainActivity.mismatches++;
        Log.e(MainActivity.TAG, "MISMATCH frame " + MainActivity.frames + " pinned " + what + " shaded");
    }

    static ViewGroup build(MainActivity a) {
        LinearLayout root = new LinearLayout(a);
        root.setOrientation(LinearLayout.VERTICAL);
        FrameLayout player = new FrameLayout(a) {
            @Override public ViewGroupOverlay getOverlay() { shaded("player"); return super.getOverlay(); }
        };
        player.addView(new MainActivity.Video(a, true) {
            @Override public android.view.ViewOverlay getOverlay() { shaded("player video"); return super.getOverlay(); }
        });
        player.setOnClickListener(v -> { playerTaps++; Log.i(MainActivity.TAG, "CLICK reached player"); });
        root.addView(player, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, a.dp(220)));

        RecyclerView rv = new MainActivity.FeedList(a);
        rv.setLayoutManager(new LinearLayoutManager(a));
        rv.setAdapter(new RecyclerView.Adapter<RecyclerView.ViewHolder>() {
            @Override public int getItemCount() { return 60; }
            @Override public RecyclerView.ViewHolder onCreateViewHolder(ViewGroup parent, int type) {
                LinearLayout l = a.card(parent.getContext());
                l.setMinimumHeight(a.dp(250)); // about the player's size, as a related video's thumbnail and title
                TextView t = new TextView(parent.getContext());
                t.setTextSize(17);
                l.addView(t);
                return new RecyclerView.ViewHolder(l) { };
            }
            @Override public void onBindViewHolder(RecyclerView.ViewHolder h, int pos) {
                int post = pos % 2 == 0 ? 0 : 1; // covered "Breaking Bad season 5 finale was insane" / a clean one
                h.itemView.setTag(post);
                ((TextView) ((LinearLayout) h.itemView).getChildAt(0)).setText(MainActivity.body(post));
            }
        });
        root.addView(rv, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1));
        rv.getViewTreeObserver().addOnDrawListener(() -> { MainActivity.frames++; a.checkChildren(rv); Sound.check(rv, "watch"); });
        return root;
    }
}
