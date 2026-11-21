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
 * After "Show once" on a cover that names works the same object turns into a pill (contract, cover wording): a small
 * translucent box in the item's top corner at the end of the line with "Not this" and "Cover again", drawn over the
 * shown content; the scanner gives it only the taps inside it.
 */
final class Cover {
    final Scanner scanner;
    final View item;
    private final ViewGroup host; // item itself, or its list when the item is a plain View (no ViewGroupOverlay)
    private final LinearLayout root, row;
    private final TextView msg, once, seen, not, manage, again, more;
    boolean pill; // shown once: only the pill is drawn
    private boolean expanded; // a narrow item's pill after its "⋯" was tapped
    private int lw = -1, lh, lx, ly; // the item's size and position at the last layout
    String notKey; // rule 11: the item's most specific "Not this" key ("{site}/{source}" or "{site}"), or null
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
        // the pill's buttons (contract: a cover has no "Not this", the post cannot be judged unseen)
        not = button(ctx, p, "Not this");
        again = button(ctx, p, "Cover again");
        more = button(ctx, p, "⋯"); // a pill too wide for its item: tapped, it shows the two buttons
        more.setContentDescription("SpolierBlock: Not this or Cover again");
        row.addView(not);
        row.addView(again);
        row.addView(more);
        again.setVisibility(View.GONE);
        more.setVisibility(View.GONE);
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

    /** The cover or the pill: which parts show, how they look, and whether TalkBack may read the item's content. */
    private void mode(boolean on) {
        boolean was = pill;
        pill = on;
        msg.setVisibility(on ? View.GONE : View.VISIBLE);
        once.setVisibility(on ? View.GONE : View.VISIBLE);
        manage.setVisibility(on ? View.GONE : View.VISIBLE);
        seen.setVisibility(!on && marks.length > 0 ? View.VISIBLE : View.GONE);
        not.setVisibility(on && marks.length > 0 && notKey != null ? View.VISIBLE : View.GONE);
        again.setVisibility(on ? View.VISIBLE : View.GONE);
        more.setVisibility(View.GONE);
        if (on) {
            GradientDrawable bg = new GradientDrawable();
            bg.setColor(palette.cover & 0x00FFFFFF | 0xD8000000); // slightly translucent, the surface's own tone
            bg.setStroke(dp(1), palette.outline);
            bg.setCornerRadius(dp(18));
            root.setBackground(bg);
            root.setOrientation(LinearLayout.HORIZONTAL);
            root.setPadding(dp(3), dp(3), dp(3), dp(3));
            row.setPadding(0, 0, 0, 0);
            row.setLayoutParams(Ui.wrap());
            for (TextView b : new TextView[]{not, again, more}) {
                b.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12);
                b.setMinHeight(dp(28));
                b.setPadding(dp(10), 0, dp(10), 0);
                LinearLayout.LayoutParams lp = Ui.wrap();
                lp.setMargins(dp(2), 0, dp(2), 0);
                b.setLayoutParams(lp);
            }
        } else if (was) {
            root.setBackgroundColor(palette.cover);
            row.setOrientation(LinearLayout.HORIZONTAL);
            compact = null; // compact() and fit() set the cover's sizes again
            expanded = false;
        }
        if (was != on) { // TalkBack: the content while shown once, only the cover's nodes while covered
            item.setImportantForAccessibility(on ? savedA11y : a11y != null ? View.IMPORTANT_FOR_ACCESSIBILITY_YES : View.IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS);
            if (item.getParent() != null) {
                try { item.getParent().notifySubtreeAccessibilityStateChanged(item, item, android.view.accessibility.AccessibilityEvent.CONTENT_CHANGE_TYPE_SUBTREE); }
                catch (RuntimeException ignored) { } // a parent that cannot take it: TalkBack catches up on the next change
            }
        }
    }

    private CoverA11y a11y;

    /** The scanner reads the item's real text through accessibility: the cover's nodes step aside meanwhile. */
    void a11yPause(boolean on) { if (a11y != null) a11y.paused = on; }

    /** For TalkBack: the message, then the buttons on show (a pill: its buttons only). */
    java.util.List<View> a11yParts() {
        java.util.List<View> l = new java.util.ArrayList<>();
        if (!pill) l.add(msg);
        for (View b : new View[]{once, seen, manage, not, again, more}) if (b.getVisibility() == View.VISIBLE && b.getWidth() > 0) l.add(b);
        return l;
    }

    /** A part's bounds relative to the item. */
    android.graphics.Rect boundsOf(View part) {
        int x = root.getLeft() - lx, y = root.getTop() - ly; // 0 for a cover, the corner for a pill
        for (View v = part; v != root; v = (View) v.getParent()) { x += v.getLeft(); y += v.getTop(); }
        return new android.graphics.Rect(x, y, x + part.getWidth(), y + part.getHeight());
    }

    /** A button was activated (a tap, or TalkBack). */
    void press(View b) {
        if (b == once) scanner.revealOnce(this);
        else if (b == seen && marks.length > 0) seen();
        else if (b == not && pill && marks.length > 0 && notKey != null) scanner.notThis(this, marks);
        else if (b == again && pill) scanner.coverAgain(this);
        else if (b == more && pill) { expanded = true; layout(true); }
        else if (b == manage) {
            Activity a = activity(item.getContext());
            if (a == null) a = scanner.sb.resumedActivity(); // a dialog's or popup's context may not be the activity
            if (a != null) SpoilerBlock.I.openSettings(a);
        }
    }

    /**
     * "I've seen it": the works of the cover's names, marked at once when there is one and no more of its series, else picked in a dialog
     * (contract: a franchise name or a remake must not mark works the user has not seen).
     */
    private void seen() {
        Matcher m = scanner.sb.matcher;
        if (m == null) return;
        java.util.LinkedHashSet<Integer> all = new java.util.LinkedHashSet<>();
        for (int g : marks) for (int w : m.groupWorks(g)) all.add(w);
        Config.Works v = scanner.sb.worksFor(m);
        java.util.List<Integer> more = SeenPicker.moreFromSeries(m, marks, all, v.seen);
        // one work: marked at once, unless its series has more unseen works to offer (contract, cover wording)
        if (all.size() <= 1 && more.isEmpty()) { SpoilerBlock.I.markWorks(all); return; }
        java.util.List<Integer> open = new java.util.ArrayList<>();
        for (int w : all) if (!v.seen[w]) open.add(w);
        Activity a = activity(item.getContext());
        if (a == null) a = scanner.sb.resumedActivity();
        if (a == null || a.isFinishing()) return;
        SeenPicker.show(a, palette.dark, m, open, more, marks.length, m.labels[marks[0]], all.size() == 1 ? m.titles[all.iterator().next()] : null); // one unseen row still opens it: the user sees what is marked
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

    /**
     * Returns true when what the cover says, or whether it is a pill, changed. marks: the name groups "I've seen it" and
     * the pill's "Not this" act on; pill: the item is shown once and only the pill is drawn.
     */
    boolean show(String message, int[] marks, String text, boolean pill) {
        this.text = text;
        if (message.equals(this.message) && java.util.Arrays.equals(marks, this.marks) && pill == this.pill && this.message != null) return false;
        this.message = message;
        this.marks = marks;
        msg.setText(message);
        mode(pill);
        layout(true);
        return true;
    }

    /** "Show once" (on) or "Cover again" (off) on this cover, before the scanner judges the item again. */
    void pill(boolean on) { show(message, marks, text, on); }

    /** Whether the cover names works (only those leave a pill after "Show once"). */
    boolean names() { return marks.length > 0; }

    /** The pill's rectangle on screen. */
    android.graphics.Rect pillOnScreen() {
        android.graphics.Rect r = boundsOf(root);
        int[] l = new int[2];
        item.getLocationOnScreen(l);
        r.offset(l[0], l[1]);
        return r;
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
        if (force || w != lw || h != lh || x != lx || y != ly) {
            lw = w; lh = h; lx = x; ly = y;
            if (pill) placePill(w, h, x, y);
            else {
                compact(h < dp(120));
                fit(w);
                root.measure(View.MeasureSpec.makeMeasureSpec(w, View.MeasureSpec.EXACTLY), View.MeasureSpec.makeMeasureSpec(h, View.MeasureSpec.EXACTLY));
                root.layout(x, y, x + w, y + h);
            }
        }
        if (host != item) { root.setTranslationX(item.getTranslationX()); root.setTranslationY(item.getTranslationY()); }
    }

    /**
     * The pill, its own size, in the item's top corner at the end of the line. On an item narrower than the pill only
     * the "⋯" button shows; tapped, the two buttons show one above the other.
     */
    private void placePill(int w, int h, int x, int y) {
        int m = dp(4), unspec = View.MeasureSpec.makeMeasureSpec(0, View.MeasureSpec.UNSPECIFIED);
        not.setVisibility(marks.length > 0 && notKey != null ? View.VISIBLE : View.GONE);
        again.setVisibility(View.VISIBLE);
        more.setVisibility(View.GONE);
        row.setOrientation(LinearLayout.HORIZONTAL);
        root.measure(unspec, unspec);
        if (root.getMeasuredWidth() > w - 2 * m) {
            if (expanded) row.setOrientation(LinearLayout.VERTICAL);
            else { not.setVisibility(View.GONE); again.setVisibility(View.GONE); more.setVisibility(View.VISIBLE); }
        }
        root.measure(View.MeasureSpec.makeMeasureSpec(Math.max(0, w - 2 * m), View.MeasureSpec.AT_MOST),
            View.MeasureSpec.makeMeasureSpec(Math.max(0, h - 2 * m), View.MeasureSpec.AT_MOST));
        int pw = root.getMeasuredWidth(), ph = root.getMeasuredHeight();
        int px = x + (item.getLayoutDirection() == View.LAYOUT_DIRECTION_RTL ? m : w - m - pw);
        root.layout(px, y + m, px + pw, y + m + ph);
    }

    /**
     * Three buttons can be wider than a narrow item: their side padding shrinks first, then the text buttons share
     * what is left after the settings button (ellipsized), so the settings button is never pushed out.
     */
    private void fit(int w) {
        int avail = Math.max(0, w - root.getPaddingLeft() - root.getPaddingRight() - (compact ? dp(96) : 0)); // compact: room for the message
        boolean squeeze = false;
        for (int pad : new int[]{16, 8, 4}) {
            for (TextView b : new TextView[]{once, seen}) b.setPadding(dp(pad), 0, dp(pad), 0);
            manage.setPadding(dp(Math.min(pad, 12)), 0, dp(Math.min(pad, 12)), 0);
            int need = 0;
            for (TextView b : new TextView[]{once, seen, manage}) {
                if (b.getVisibility() != View.VISIBLE) continue;
                b.measure(View.MeasureSpec.UNSPECIFIED, View.MeasureSpec.UNSPECIFIED);
                need += b.getMeasuredWidth() + dp(8);
            }
            if (need <= avail) break;
            squeeze = pad == 4;
        }
        for (TextView b : new TextView[]{once, seen}) {
            LinearLayout.LayoutParams lp = squeeze ? new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1)
                : new LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT);
            lp.setMargins(dp(4), 0, dp(4), 0);
            b.setLayoutParams(lp);
        }
        row.setLayoutParams(squeeze ? new LinearLayout.LayoutParams(avail, ViewGroup.LayoutParams.WRAP_CONTENT) : Ui.wrap());
    }

    /** Draws the cover (or the pill, at its corner) with the item's top left at the canvas origin. */
    void drawInto(android.graphics.Canvas c) {
        c.save();
        c.translate(root.getLeft() - lx, root.getTop() - ly);
        root.draw(c);
        c.restore();
    }

    void remove() {
        host.getOverlay().remove(root);
        if (a11y != null && item.getAccessibilityDelegate() == a11y) item.setAccessibilityDelegate(a11y.original);
        item.setImportantForAccessibility(savedA11y);
    }

    /** x, y in screen coordinates; the gesture was already taken away from the app. */
    void tap(float x, float y) {
        for (View b : new View[]{once, seen, manage, not, again, more}) if (hit(b, x, y)) { press(b); return; }
    }

    private boolean hit(View b, float x, float y) {
        if (b.getWidth() == 0 || b.getVisibility() != View.VISIBLE) return false;
        int[] l = new int[2];
        item.getLocationOnScreen(l);
        android.graphics.Rect r = boundsOf(b);
        r.offset(l[0], l[1]);
        int slack = dp(4);
        return x >= r.left - slack && x < r.right + slack && y >= r.top - slack && y < r.bottom + slack;
    }

    private static Activity activity(Context c) {
        while (c instanceof ContextWrapper) {
            if (c instanceof Activity) return (Activity) c;
            c = ((ContextWrapper) c).getBaseContext();
        }
        return null;
    }
}
