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
        if (paused) return original != null ? original.getAccessibilityNodeProvider(host) : null;
        return provider;
    }

    final AccessibilityNodeProvider provider = new AccessibilityNodeProvider() {
        @Override public AccessibilityNodeInfo createAccessibilityNodeInfo(int id) {
            View item = cover.item;
            List<View> parts = cover.a11yParts();
            if (id == View.NO_ID) { // the item itself, now a container of the cover's parts
                AccessibilityNodeInfo info = AccessibilityNodeInfo.obtain(item);
                item.onInitializeAccessibilityNodeInfo(info);
                info.setContentDescription(null);
                info.setText(null);
                for (int k = 0; k < parts.size(); k++) info.addChild(item, k);
                return info;
            }
            if (id < 0 || id >= parts.size()) return null;
            View part = parts.get(id);
            AccessibilityNodeInfo n = AccessibilityNodeInfo.obtain(item, id);
            n.setParent(item);
            n.setPackageName(item.getContext().getPackageName());
            n.setClassName(id == 0 ? "android.widget.TextView" : "android.widget.Button");
            CharSequence label = part.getContentDescription() != null ? part.getContentDescription() : ((android.widget.TextView) part).getText();
            if (id == 0) n.setText(label); else n.setContentDescription(label);
            Rect r = cover.boundsOf(part);
            n.setBoundsInParent(r);
            int[] l = new int[2];
            item.getLocationOnScreen(l);
            r.offset(l[0], l[1]);
            n.setBoundsInScreen(r);
            n.setVisibleToUser(item.isShown());
            n.setEnabled(true);
            n.setFocusable(id > 0);
            n.setImportantForAccessibility(true);
            if (id > 0) { n.setClickable(true); n.addAction(AccessibilityNodeInfo.AccessibilityAction.ACTION_CLICK); }
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
                    if (id == 0) return false;
                    send(id, AccessibilityEvent.TYPE_VIEW_CLICKED);
                    cover.press(cover.a11yParts().get(id));
                    return true;
                default:
                    return false;
            }
        }
    };

    private void send(int id, int type) {
        View item = cover.item;
        if (item.getParent() == null) return;
        AccessibilityEvent e = AccessibilityEvent.obtain(type);
        e.setSource(item, id);
        e.setPackageName(item.getContext().getPackageName());
        item.getParent().requestSendAccessibilityEvent(item, e);
    }
}
