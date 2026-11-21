package dev.spoilerblock;

import android.graphics.Rect;
import android.os.Bundle;
import android.view.View;
import android.view.accessibility.AccessibilityEvent;
import android.view.accessibility.AccessibilityNodeInfo;
import android.view.accessibility.AccessibilityNodeProvider;

import java.util.List;

/**
 * What TalkBack sees of a covered item: the cover, not the content. Installed as the item's accessibility delegate,
 * whose node provider replaces the item's real subtree (hidden) with virtual nodes for the cover's message and its
 * buttons, which TalkBack can read, focus and activate. The host's own delegate is put back when the cover goes.
 * A pill (shown once) keeps the item's real children readable and adds its buttons as virtual nodes.
 */
final class CoverA11y extends View.AccessibilityDelegate {
    private final Cover cover;
    View.AccessibilityDelegate original; // the host's, restored with the cover
    boolean paused; // while the scanner reads the item's real text
    private int focused = Integer.MIN_VALUE;

    CoverA11y(Cover cover, View.AccessibilityDelegate original) {
        this.cover = cover;
        this.original = original;
    }

    @Override public AccessibilityNodeProvider getAccessibilityNodeProvider(View host) {
        AccessibilityNodeProvider own = original != null ? original.getAccessibilityNodeProvider(host) : null;
        if (paused || cover.pill && own != null) return own; // a host tree of its own stays readable under a pill (no pill nodes then)
        return cover.pill ? pillNodes : provider;
    }

    final Nodes provider = new Nodes();
    private final Nodes pillNodes = new PillNodes();

    /** Its own class, so a check can tell an item shown once (content readable) from a covered one. */
    final class PillNodes extends Nodes { }

    class Nodes extends AccessibilityNodeProvider {
        @Override public AccessibilityNodeInfo createAccessibilityNodeInfo(int id) {
            View item = cover.item;
            List<View> parts = cover.a11yParts();
            boolean pill = cover.pill;
            if (id == View.NO_ID) { // the item itself, now a container of the cover's parts (a pill's: its content, then the pill's)
                AccessibilityNodeInfo info = AccessibilityNodeInfo.obtain(item);
                item.onInitializeAccessibilityNodeInfo(info); // a ViewGroup with a provider adds no children here
                if (pill && item instanceof android.view.ViewGroup) {
                    java.util.ArrayList<View> kids = new java.util.ArrayList<>();
                    item.addChildrenForAccessibility(kids);
                    for (View k : kids) if (k != item) info.addChild(k);
                } else if (!pill) {
                    info.setContentDescription(null);
                    info.setText(null);
                }
                for (int k = 0; k < parts.size(); k++) info.addChild(item, k);
                return info;
            }
            if (id < 0 || id >= parts.size()) return null;
            View part = parts.get(id);
            AccessibilityNodeInfo n = AccessibilityNodeInfo.obtain(item, id);
            n.setParent(item);
            n.setPackageName(item.getContext().getPackageName());
            boolean button = pill || id > 0; // a cover's part 0 is its message
            n.setClassName(button ? "android.widget.Button" : "android.widget.TextView");
            CharSequence label = part.getContentDescription() != null ? part.getContentDescription() : ((android.widget.TextView) part).getText();
            if (!button) n.setText(label); else n.setContentDescription(label);
            Rect r = cover.boundsOf(part);
            n.setBoundsInParent(r);
            int[] l = new int[2];
            item.getLocationOnScreen(l);
            r.offset(l[0], l[1]);
            n.setBoundsInScreen(r);
            n.setVisibleToUser(item.isShown());
            n.setEnabled(true);
            n.setFocusable(button);
            n.setImportantForAccessibility(true);
            if (button) { n.setClickable(true); n.addAction(AccessibilityNodeInfo.AccessibilityAction.ACTION_CLICK); }
            n.setAccessibilityFocused(focused == id);
            n.addAction(focused == id ? AccessibilityNodeInfo.AccessibilityAction.ACTION_CLEAR_ACCESSIBILITY_FOCUS
                : AccessibilityNodeInfo.AccessibilityAction.ACTION_ACCESSIBILITY_FOCUS);
            return n;
        }

        @Override public boolean performAction(int id, int action, Bundle args) {
            View item = cover.item;
            if (id == View.NO_ID) return item.performAccessibilityAction(action, args);
            switch (action) {
                case AccessibilityNodeInfo.ACTION_ACCESSIBILITY_FOCUS:
                    focused = id;
                    send(id, AccessibilityEvent.TYPE_VIEW_ACCESSIBILITY_FOCUSED);
                    return true;
                case AccessibilityNodeInfo.ACTION_CLEAR_ACCESSIBILITY_FOCUS:
                    if (focused == id) focused = Integer.MIN_VALUE;
                    send(id, AccessibilityEvent.TYPE_VIEW_ACCESSIBILITY_FOCUS_CLEARED);
                    return true;
                case AccessibilityNodeInfo.ACTION_CLICK:
                    List<View> parts = cover.a11yParts();
                    if (id == 0 && !cover.pill || id < 0 || id >= parts.size()) return false;
                    send(id, AccessibilityEvent.TYPE_VIEW_CLICKED);
                    cover.press(parts.get(id));
                    return true;
                default:
                    return false;
            }
        }
    }

    private void send(int id, int type) {
        View item = cover.item;
        if (item.getParent() == null) return;
        AccessibilityEvent e = AccessibilityEvent.obtain(type);
        e.setSource(item, id);
        e.setPackageName(item.getContext().getPackageName());
        item.getParent().requestSendAccessibilityEvent(item, e);
    }
}
