package dev.spoilerblock;

import android.app.Activity;
import android.content.Context;
import android.content.ContextWrapper;
import android.graphics.drawable.GradientDrawable;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.widget.LinearLayout;
import android.widget.TextView;

/**
 * Opaque black cover drawn in the item's own ViewGroupOverlay, so it moves, scrolls and animates with the item
 * with no per-frame positioning. Overlay views get no touches: Scanner.onTouch hit-tests the buttons.
 */
final class Cover {
    final Scanner scanner;
    final View item;
    private final ViewGroup host; // item itself, or its list when the item is a plain View (no ViewGroupOverlay)
    private final LinearLayout root;
    private final TextView msg, once, seen, manage;
    private int[] groups;
    String text;
    private int savedA11y;

    Cover(Scanner scanner, View item, ViewGroup parent) {
        this.scanner = scanner;
        this.item = item;
        host = item instanceof ViewGroup ? (ViewGroup) item : parent;
        Context ctx = item.getContext();
        root = new LinearLayout(ctx);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setGravity(Gravity.CENTER);
        root.setBackgroundColor(0xFF111111);
        int p = dp(8);
        root.setPadding(p, p, p, p);
        msg = label(ctx, 15);
        msg.setGravity(Gravity.CENTER);
        root.addView(msg);
        LinearLayout row = new LinearLayout(ctx);
        row.setGravity(Gravity.CENTER);
        row.setPadding(0, dp(6), 0, 0);
        once = button(ctx, "Show once");
        seen = button(ctx, "");
        seen.setEllipsize(android.text.TextUtils.TruncateAt.END);
        manage = button(ctx, "\u22EE"); // vertical ellipsis: spoiler settings
        manage.setContentDescription("Spoiler settings");
        row.addView(once);
        row.addView(seen);
        row.addView(manage);
        root.addView(row);
        host.getOverlay().add(root);
        // TalkBack must not read what the cover hides
        savedA11y = item.getImportantForAccessibility();
        item.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS);
    }

    private int dp(int v) { return (int) TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, v, item.getResources().getDisplayMetrics()); }

    private TextView label(Context ctx, int sp) {
        TextView t = new TextView(ctx);
        t.setTextColor(0xFFF2F2F2);
        t.setTextSize(TypedValue.COMPLEX_UNIT_SP, sp);
        return t;
    }

    private TextView button(Context ctx, String s) {
        TextView b = label(ctx, 14);
        b.setText(s);
        b.setMaxLines(1);
        b.setMinHeight(dp(40));
        b.setGravity(Gravity.CENTER);
        b.setPadding(dp(14), 0, dp(14), 0);
        GradientDrawable bg = new GradientDrawable();
        bg.setColor(0xFF262626);
        bg.setStroke(dp(1), 0xFF555555);
        bg.setCornerRadius(dp(20));
        b.setBackground(bg);
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        lp.setMargins(dp(4), 0, dp(4), 0);
        b.setLayoutParams(lp);
        return b;
    }

    /** Returns true when what the cover says changed. */
    boolean show(Matcher m, int[] groups, String text) {
        if (java.util.Arrays.equals(groups, this.groups)) { this.text = text; return false; }
        this.groups = groups;
        this.text = text;
        boolean known = groups.length > 0 && groups[0] != Clip.UNKNOWN;
        if (groups.length == 0) msg.setText("Checking image\u2026"); // pending: covered until its verdicts are in
        else if (!known) msg.setText("May contain a spoiler (unrecognised film, show or game image)");
        else msg.setText("Contains spoiler about " + m.labels[groups[0]] + (groups.length > 1 ? " (+" + (groups.length - 1) + " more)" : ""));
        seen.setText(known ? "I've seen " + m.labels[groups[0]] : "");
        seen.setVisibility(known ? View.VISIBLE : View.GONE); // nothing to mark as seen when the work is not known
        layout(true);
        return true;
    }

    /** Keeps the cover the size (and, for a plain-View item, the position) of its item. */
    void sync() { layout(false); }

    private void layout(boolean force) {
        int w = item.getWidth(), h = item.getHeight();
        int x = host == item ? 0 : item.getLeft(), y = host == item ? 0 : item.getTop();
        if (!force && root.getWidth() == w && root.getHeight() == h && root.getLeft() == x && root.getTop() == y) {
            if (host != item) { root.setTranslationX(item.getTranslationX()); root.setTranslationY(item.getTranslationY()); }
            return;
        }
        seen.setMaxWidth(w / 2); // long titles must not push the other buttons out
        root.measure(View.MeasureSpec.makeMeasureSpec(w, View.MeasureSpec.EXACTLY), View.MeasureSpec.makeMeasureSpec(h, View.MeasureSpec.EXACTLY));
        root.layout(x, y, x + w, y + h);
        if (host != item) { root.setTranslationX(item.getTranslationX()); root.setTranslationY(item.getTranslationY()); }
    }

    void drawInto(android.graphics.Canvas c) { root.draw(c); }

    void remove() {
        host.getOverlay().remove(root);
        item.setImportantForAccessibility(savedA11y);
    }

    /** x, y in screen coordinates; the gesture was already taken away from the app. */
    void tap(float x, float y) {
        if (hit(once, x, y)) scanner.revealOnce(this);
        else if (hit(seen, x, y) && groups.length > 0 && groups[0] != Clip.UNKNOWN) SpoilerBlock.I.markSeen(groups[0]);
        else if (hit(manage, x, y)) {
            Activity a = activity(item.getContext());
            if (a != null) ManageDialog.show(a, SpoilerBlock.I);
        }
    }

    private boolean hit(View b, float x, float y) {
        if (b.getWidth() == 0) return false;
        int[] l = new int[2];
        item.getLocationOnScreen(l);
        float bx = l[0], by = l[1]; // the cover sits exactly on the item
        for (View v = b; v != root; v = (View) v.getParent()) { bx += v.getLeft(); by += v.getTop(); }
        int slack = dp(4);
        return x >= bx - slack && x < bx + b.getWidth() + slack && y >= by - slack && y < by + b.getHeight() + slack;
    }

    private static Activity activity(Context c) {
        while (c instanceof ContextWrapper) {
            if (c instanceof Activity) return (Activity) c;
            c = ((ContextWrapper) c).getBaseContext();
        }
        return null;
    }
}
