package dev.spoilerblock;

import android.app.Activity;
import android.content.Context;
import android.content.ContextWrapper;
import android.graphics.drawable.GradientDrawable;
import android.text.TextUtils;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.widget.LinearLayout;
import android.widget.TextView;

/**
 * Opaque cover drawn in the item's own ViewGroupOverlay, so it moves, scrolls and animates with the item with no
 * per-frame positioning. Overlay views get no touches: Scanner.onTouch hit-tests the buttons. Nothing here touches
 * the item's layout: the overlay is outside the host's measure/layout pass, so the item keeps its size and the list
 * never re-lays out because of a cover.
 */
final class Cover {
    final Scanner scanner;
    final View item;
    private final ViewGroup host; // item itself, or its list when the item is a plain View (no ViewGroupOverlay)
    private final LinearLayout root;
    private final TextView msg, once, seen, manage;
    private String message;
    private int group = -1; // the work group "I've seen it" marks; -1: none (unidentified or pending image)
    String text;
    private final int savedA11y;

    Cover(Scanner scanner, View item, ViewGroup parent) {
        this.scanner = scanner;
        this.item = item;
        host = item instanceof ViewGroup ? (ViewGroup) item : parent;
        Context ctx = item.getContext();
        Ui.Palette p = Ui.palette(ctx);
        root = new LinearLayout(ctx);
        root.setOrientation(LinearLayout.VERTICAL);
        root.setGravity(Gravity.CENTER);
        root.setBackgroundColor(p.cover);
        int pad = dp(12);
        root.setPadding(pad, pad, pad, pad);
        msg = new TextView(ctx);
        msg.setTextColor(p.text);
        msg.setTextSize(TypedValue.COMPLEX_UNIT_SP, 15);
        msg.setGravity(Gravity.CENTER);
        msg.setMaxLines(3);
        msg.setEllipsize(TextUtils.TruncateAt.END);
        root.addView(msg);
        LinearLayout row = new LinearLayout(ctx);
        row.setGravity(Gravity.CENTER);
        row.setPadding(0, dp(8), 0, 0);
        once = button(ctx, p, "Show once");
        seen = button(ctx, p, "I've seen it");
        manage = button(ctx, p, "⋮"); // vertical ellipsis
        manage.setContentDescription("SpolierBlock settings");
        manage.setPadding(dp(12), 0, dp(12), 0);
        row.addView(once);
        row.addView(seen);
        row.addView(manage);
        // dialogs and popups have no touch gate of ours: no buttons that would not work
        if (scanner.activityWindow) root.addView(row);
        host.getOverlay().add(root);
        // TalkBack must not read what the cover hides
        savedA11y = item.getImportantForAccessibility();
        item.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS);
    }

    private int dp(int v) { return Ui.dp(item.getContext(), v); }

    private TextView button(Context ctx, Ui.Palette p, String s) {
        TextView b = new TextView(ctx);
        b.setTextColor(p.text);
        b.setTextSize(TypedValue.COMPLEX_UNIT_SP, 14);
        b.setText(s);
        b.setMaxLines(1);
        b.setEllipsize(TextUtils.TruncateAt.END);
        b.setMinHeight(dp(44));
        b.setGravity(Gravity.CENTER);
        b.setPadding(dp(16), 0, dp(16), 0);
        GradientDrawable bg = new GradientDrawable();
        bg.setColor(p.surface);
        bg.setStroke(dp(1), p.outline);
        bg.setCornerRadius(dp(22));
        b.setBackground(bg);
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        lp.setMargins(dp(4), 0, dp(4), 0);
        b.setLayoutParams(lp);
        return b;
    }

    /** Returns true when what the cover says changed. group: the work group "I've seen it" marks, or -1. */
    boolean show(String message, int group, String text) {
        this.text = text;
        if (message.equals(this.message) && group == this.group) return false;
        this.message = message;
        this.group = group;
        msg.setText(message);
        seen.setVisibility(group >= 0 ? View.VISIBLE : View.GONE);
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
        else if (group >= 0 && hit(seen, x, y)) SpoilerBlock.I.markSeen(group);
        else if (hit(manage, x, y)) {
            Activity a = activity(item.getContext());
            if (a != null) SpoilerBlock.I.openSettings(a);
        }
    }

    private boolean hit(View b, float x, float y) {
        if (!scanner.activityWindow || b.getWidth() == 0 || b.getVisibility() != View.VISIBLE) return false;
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
