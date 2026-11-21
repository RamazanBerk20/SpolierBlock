package dev.spoilerblock.demo;

import android.graphics.drawable.GradientDrawable;
import android.util.Log;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.TextView;

import androidx.recyclerview.widget.RecyclerView;

/**
 * --ez bottomBar true: X's bottom bar and compose button, floating over the feed (siblings added after the list, the
 * bar's container not clickable, its buttons clickable). Every tap that reaches them is logged. When the list rests it
 * logs where covered rows lie (demo-bar.sh reads that line): one under the bar, one under the round button, one clear
 * of both, with the screen points to tap.
 */
final class BottomBar {
    static int reports;

    static View build(MainActivity a, RecyclerView list) {
        FrameLayout f = new FrameLayout(a);
        f.addView(list);
        LinearLayout bar = new LinearLayout(a);
        bar.setBackgroundColor(0xFFF2F2F2);
        int[] taps = {0};
        for (int i = 1; i <= 3; i++) {
            TextView b = new TextView(a);
            b.setText("Tab " + i);
            b.setGravity(Gravity.CENTER);
            int n = i;
            b.setOnClickListener(v -> Log.i(MainActivity.TAG, "bar tap " + n + " (" + ++taps[0] + " in all)"));
            bar.addView(b, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.MATCH_PARENT, 1));
        }
        f.addView(bar, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, a.dp(56), Gravity.BOTTOM));
        TextView fab = new TextView(a);
        fab.setText("+");
        fab.setTextSize(24);
        fab.setTextColor(0xFFFFFFFF);
        fab.setGravity(Gravity.CENTER);
        GradientDrawable round = new GradientDrawable();
        round.setShape(GradientDrawable.OVAL);
        round.setColor(0xFF1D9BF0);
        fab.setBackground(round);
        fab.setElevation(a.dp(6));
        fab.setOnClickListener(v -> Log.i(MainActivity.TAG, "fab tap"));
        FrameLayout.LayoutParams lp = new FrameLayout.LayoutParams(a.dp(56), a.dp(56), Gravity.BOTTOM | Gravity.END);
        lp.setMargins(0, 0, a.dp(16), a.dp(72));
        f.addView(fab, lp);
        list.addOnScrollListener(new RecyclerView.OnScrollListener() {
            @Override public void onScrollStateChanged(RecyclerView rv, int state) {
                if (state == RecyclerView.SCROLL_STATE_IDLE) rv.postDelayed(() -> report(a, rv, bar, fab), 500); // covers of new rows first
            }
        });
        f.postDelayed(() -> report(a, list, bar, fab), 3000); // the index loads first
        return f;
    }

    /** One line: bar=x1,x2,x3,y fab=x,y under=post@x,y (a point of that row just above the bar) round=post free=post@x,y (its "Show once"). */
    static void report(MainActivity a, RecyclerView list, View bar, View fab) {
        int[] l = new int[2];
        bar.getLocationOnScreen(l);
        int barTop = l[1], barY = barTop + bar.getHeight() / 2, w = bar.getWidth();
        fab.getLocationOnScreen(l);
        int fabX = l[0] + fab.getWidth() / 2, fabY = l[1] + fab.getHeight() / 2, fabTop = l[1];
        list.getLocationOnScreen(l);
        int listTop = l[1];
        String under = "-1", round = "-1", free = "-1";
        for (int i = 0; i < list.getChildCount(); i++) {
            View v = list.getChildAt(i);
            if (!(v.getTag() instanceof Integer)) continue;
            int post = (Integer) v.getTag();
            if (!Boolean.TRUE.equals(MainActivity.expected(post)) || !MainActivity.covered(v)) continue;
            v.getLocationOnScreen(l);
            int top = l[1], bottom = top + v.getHeight();
            // the test taps the app's buttons only where no cover button lies under them: before the fix such a tap
            // would press it ("I've seen it" would change the device's saved config)
            java.util.List<android.graphics.Rect> buttons = new java.util.ArrayList<>();
            android.graphics.Rect once = coverButtons(v, buttons);
            if (under.equals("-1") && top < barTop - a.dp(24) && bottom > barY + a.dp(8)
                && clear(buttons, w / 6, barY) && clear(buttons, w / 2, barY) && clear(buttons, w * 5 / 6, barY))
                under = post + "@" + (l[0] + a.dp(24)) + "," + (barTop - a.dp(10)); // left edge: the cover's text, not its buttons
            if (round.equals("-1") && top < fabY - a.dp(8) && bottom > fabY + a.dp(8) && clear(buttons, fabX, fabY)) round = String.valueOf(post);
            if (free.equals("-1") && once != null && top >= listTop && bottom < fabTop - a.dp(4))
                free = post + "@" + once.centerX() + "," + once.centerY();
        }
        Log.i(MainActivity.TAG, "bar check " + ++reports + ": bar=" + w / 6 + "," + w / 2 + "," + w * 5 / 6 + "," + barY +
            " fab=" + fabX + "," + fabY + " under=" + under + " round=" + round + " free=" + free);
    }

    /** The cover's buttons on screen, read from the blocker's accessibility nodes (ids 1..: the buttons). Returns "Show once". */
    static android.graphics.Rect coverButtons(View v, java.util.List<android.graphics.Rect> out) {
        android.view.accessibility.AccessibilityNodeProvider p = v.getAccessibilityNodeProvider();
        android.graphics.Rect once = null;
        for (int id = 1; p != null; id++) {
            android.view.accessibility.AccessibilityNodeInfo n = p.createAccessibilityNodeInfo(id);
            if (n == null) break;
            android.graphics.Rect r = new android.graphics.Rect();
            n.getBoundsInScreen(r);
            out.add(r);
            if ("Show once".contentEquals(String.valueOf(n.getContentDescription()))) once = r;
        }
        return once;
    }

    static boolean clear(java.util.List<android.graphics.Rect> buttons, int x, int y) {
        for (android.graphics.Rect r : buttons) if (x >= r.left - 40 && x <= r.right + 40 && y >= r.top - 40 && y <= r.bottom + 40) return false;
        return true;
    }
}
