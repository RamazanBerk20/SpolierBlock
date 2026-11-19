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
 * per-frame positioning. Overlay views get no touches: Scanner.onTouch (activity windows) and Scanner.Catcher (dialogs,
 * popups) hit-test the buttons, and CoverA11y gives them to TalkBack. Nothing here touches
 * the item's layout: the overlay is outside the host's measure/layout pass, so the item keeps its size and the list
 * never re-lays out because of a cover.
 */
final class Cover {
    final Scanner scanner;
    final View item;
    private final ViewGroup host; // item itself, or its list when the item is a plain View (no ViewGroupOverlay)
    private final LinearLayout root, row;
    private final TextView msg, once, seen, manage;
    private String message;
    private int[] marks = new int[0]; // the name groups "I've seen it" marks; none for an unidentified image
    final Ui.Palette palette;
    String text;
    private final int savedA11y;

    Cover(Scanner scanner, View item, ViewGroup parent) {
        this.scanner = scanner;
        this.item = item;
        host = item instanceof ViewGroup ? (ViewGroup) item : parent;
        Context ctx = item.getContext();
        Ui.Palette p = palette = Ui.on(item);
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
        row = new LinearLayout(ctx);
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
        root.addView(row, Ui.wrap());
        host.getOverlay().add(root);
        // TalkBack reads the cover (its message and buttons), never what it hides
        savedA11y = item.getImportantForAccessibility();
        if (android.os.Build.VERSION.SDK_INT >= 29) { // the host's own delegate can be read (and restored) from API 29
            a11y = new CoverA11y(this, item.getAccessibilityDelegate());
            item.setAccessibilityDelegate(a11y);
            if (item.getAccessibilityNodeProvider() == a11y.provider) item.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_YES);
            else { item.setAccessibilityDelegate(a11y.original); a11y = null; } // the view supplies its own tree (Litho, Compose)
        }
        if (a11y == null) item.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS); // hidden at least
    }

    private CoverA11y a11y;

    /** The scanner reads the item's real text through accessibility: the cover's nodes step aside meanwhile. */
    void a11yPause(boolean on) { if (a11y != null) a11y.paused = on; }

    /** For TalkBack: the message, then the buttons on show. */
    java.util.List<View> a11yParts() {
        java.util.List<View> l = new java.util.ArrayList<>();
        l.add(msg);
        for (View b : new View[]{once, seen, manage}) if (b.getVisibility() == View.VISIBLE && b.getWidth() > 0) l.add(b);
        return l;
    }

    /** A part's bounds relative to the item. */
    android.graphics.Rect boundsOf(View part) {
        int x = 0, y = 0;
        for (View v = part; v != root; v = (View) v.getParent()) { x += v.getLeft(); y += v.getTop(); }
        return new android.graphics.Rect(x, y, x + part.getWidth(), y + part.getHeight());
    }

    /** A button was activated (a tap, or TalkBack). */
    void press(View b) {
        if (b == once) scanner.revealOnce(this);
        else if (b == seen && marks.length > 0) seen();
        else if (b == manage) {
            Activity a = activity(item.getContext());
            if (a == null) a = scanner.sb.resumedActivity(); // a dialog's or popup's context may not be the activity
            if (a != null) SpoilerBlock.I.openSettings(a);
        }
    }

    /**
     * "I've seen it": the works of the cover's names, marked at once when there is one, else picked in a dialog
     * (contract: a franchise name or a remake must not mark works the user has not seen).
     */
    private void seen() {
        Matcher m = scanner.sb.matcher;
        if (m == null) return;
        java.util.LinkedHashSet<Integer> all = new java.util.LinkedHashSet<>();
        for (int g : marks) for (int w : m.groupWorks(g)) all.add(w);
        if (all.size() <= 1) { SpoilerBlock.I.markWorks(all); return; }
        Config.Works v = scanner.sb.worksFor(m);
        java.util.List<Integer> open = new java.util.ArrayList<>();
        for (int w : all) if (!v.seen[w]) open.add(w);
        Activity a = activity(item.getContext());
        if (a == null) a = scanner.sb.resumedActivity();
        if (a == null || a.isFinishing()) return;
        SeenPicker.show(a, palette.dark, m, open, SeenPicker.moreFromSeries(m, marks, all, v.seen), marks.length, m.labels[marks[0]]); // one unseen row still opens it: the user sees what is marked
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
        bg.setColor(Ui.mix(p.cover, p.dark ? 0xFFFFFFFF : 0xFF000000, 0.06f));
        bg.setStroke(dp(1), p.outline);
        bg.setCornerRadius(dp(22));
        b.setBackground(bg);
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        lp.setMargins(dp(4), 0, dp(4), 0);
        b.setLayoutParams(lp);
        return b;
    }

    /** Returns true when what the cover says changed. marks: the name groups "I've seen it" marks. */
    boolean show(String message, int[] marks, String text) {
        this.text = text;
        if (message.equals(this.message) && java.util.Arrays.equals(marks, this.marks)) return false;
        this.message = message;
        this.marks = marks;
        msg.setText(message);
        seen.setVisibility(marks.length > 0 ? View.VISIBLE : View.GONE);
        layout(true);
        return true;
    }

    private Boolean compact;

    /**
     * A short item (one line of a message, a list row) has no room for the message above the buttons: then they sit
     * side by side, the buttons as tall as the item allows, so the buttons are never cut off.
     */
    private void compact(boolean on) {
        int h = item.getHeight();
        for (TextView b : new TextView[]{once, seen, manage}) b.setMinHeight(on ? Math.max(dp(24), Math.min(dp(44), h - dp(4))) : dp(44));
        if (compact != null && compact == on) return;
        compact = on;
        root.setOrientation(on ? LinearLayout.HORIZONTAL : LinearLayout.VERTICAL);
        root.setPadding(dp(12), on ? 0 : dp(12), on ? dp(4) : dp(12), on ? 0 : dp(12));
        msg.setGravity(on ? Gravity.START | Gravity.CENTER_VERTICAL : Gravity.CENTER);
        msg.setMaxLines(on ? 2 : 3);
        msg.setLayoutParams(on ? new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1) : Ui.wrap());
        row.setPadding(0, on ? 0 : dp(8), 0, 0);
    }

    /** Keeps the cover the size (and, for a plain-View item, the position) of its item. */
    void sync() {
        layout(false);
        // a host that sets its item's delegate again (on rebind) must not make the hidden content readable
        if (a11y != null && item.getAccessibilityDelegate() != a11y) { a11y.original = item.getAccessibilityDelegate(); item.setAccessibilityDelegate(a11y); }
    }

    private void layout(boolean force) {
        int w = item.getWidth(), h = item.getHeight();
        int x = host == item ? 0 : item.getLeft(), y = host == item ? 0 : item.getTop();
        if (!force && root.getWidth() == w && root.getHeight() == h && root.getLeft() == x && root.getTop() == y) {
            if (host != item) { root.setTranslationX(item.getTranslationX()); root.setTranslationY(item.getTranslationY()); }
            return;
        }
        compact(h < dp(120));
        root.measure(View.MeasureSpec.makeMeasureSpec(w, View.MeasureSpec.EXACTLY), View.MeasureSpec.makeMeasureSpec(h, View.MeasureSpec.EXACTLY));
        root.layout(x, y, x + w, y + h);
        if (host != item) { root.setTranslationX(item.getTranslationX()); root.setTranslationY(item.getTranslationY()); }
    }

    void drawInto(android.graphics.Canvas c) { root.draw(c); }

    void remove() {
        host.getOverlay().remove(root);
        if (a11y != null && item.getAccessibilityDelegate() == a11y) item.setAccessibilityDelegate(a11y.original);
        item.setImportantForAccessibility(savedA11y);
    }

    /** x, y in screen coordinates; the gesture was already taken away from the app. */
    void tap(float x, float y) {
        for (View b : new View[]{once, seen, manage}) if (hit(b, x, y)) { press(b); return; }
    }

    private boolean hit(View b, float x, float y) {
        if (b.getWidth() == 0 || b.getVisibility() != View.VISIBLE) return false;
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
