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
 * row that has scrolled under it. Each row has a silent preview of its own (a TextureView): a covered row's preview on
 * screen must not mute the pinned player. When "the video ends" (after 1.5 s) two end-screen cards appear over the
 * player, outside any list, as YouTube's do: the one with a spoiler title must be covered, the clean one must not.
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
        LinearLayout[] cards = new LinearLayout[2];
        player.postDelayed(() -> {
            LinearLayout end = new LinearLayout(a);
            for (int k = 0; k < 2; k++) {
                LinearLayout c = cards[k] = new LinearLayout(a);
                c.setOrientation(LinearLayout.VERTICAL);
                c.setBackgroundColor(0xCC000000);
                c.setPadding(a.dp(8), a.dp(8), a.dp(8), a.dp(8));
                TextView title = new TextView(a), channel = new TextView(a);
                title.setTextColor(0xFFFFFFFF);
                title.setText(MainActivity.body(k)); // "Breaking Bad season 5 finale was insane" / a clean one
                channel.setTextColor(0xFFBBBBBB);
                channel.setText("Some Channel");
                c.addView(title);
                c.addView(channel);
                int n = k;
                c.setOnClickListener(v -> Log.i(MainActivity.TAG, "CLICK reached end card " + n));
                LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(0, a.dp(96), 1);
                lp.setMargins(a.dp(8), 0, a.dp(8), 0);
                end.addView(c, lp);
            }
            player.addView(end, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT, android.view.Gravity.BOTTOM));
            Log.i(MainActivity.TAG, "watch: end cards shown");
        }, 1500);

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
                l.addView(new MainActivity.Video(a, false), new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, a.dp(120))); // a silent preview
                return new RecyclerView.ViewHolder(l) { };
            }
            @Override public void onBindViewHolder(RecyclerView.ViewHolder h, int pos) {
                int post = pos % 2 == 0 ? 0 : 1; // covered "Breaking Bad season 5 finale was insane" / a clean one
                h.itemView.setTag(post);
                ((TextView) ((LinearLayout) h.itemView).getChildAt(0)).setText(MainActivity.body(post));
            }
        });
        root.addView(rv, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1));
        rv.getViewTreeObserver().addOnDrawListener(() -> { MainActivity.frames++; a.checkChildren(rv); Sound.check(rv, "watch", player);
            for (int k = 0; k < 2; k++) if (cards[k] != null && cards[k].getWidth() > 0) MainActivity.checkOne(cards[k], k, "end card " + k);
        });
        return root;
    }
}
