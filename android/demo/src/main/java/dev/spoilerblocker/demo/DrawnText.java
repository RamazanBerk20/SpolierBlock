package dev.spoilerblocker.demo;

import android.content.Context;
import android.graphics.Canvas;
import android.graphics.Rect;
import android.text.Layout;
import android.text.StaticLayout;
import android.text.TextPaint;
import android.util.TypedValue;
import android.view.View;
import android.view.accessibility.AccessibilityNodeInfo;
import android.view.accessibility.AccessibilityNodeProvider;

/**
 * Text drawn on a canvas, no TextView. Exposed via contentDescription (CANVAS_DESC), only via a virtual accessibility
 * node (CANVAS_A11Y, like Litho / Compose / Instagram's IgTextLayoutView), or nowhere (CANVAS_HOOK, like X's
 * TextContentView: the demo patch hooks setText, kept by name in proguard-rules.pro as layout XML keeps X's).
 */
public class DrawnText extends View {
    final int mode;
    final TextPaint paint = new TextPaint(TextPaint.ANTI_ALIAS_FLAG);
    CharSequence text = "";
    StaticLayout layout;

    DrawnText(Context c, int mode) {
        super(c);
        this.mode = mode;
        paint.setTextSize(TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_SP, 17, c.getResources().getDisplayMetrics()));
        paint.setColor(mode == MainActivity.CANVAS_A11Y ? 0xFF1A237E : mode == MainActivity.CANVAS_HOOK ? 0xFF6A1B9A : 0xFF1B5E20);
    }

    public void setText(CharSequence t) {
        text = t;
        if (mode == MainActivity.CANVAS_DESC) setContentDescription(t);
        layout = null;
        requestLayout();
        invalidate();
    }

    @Override protected void onMeasure(int w, int h) {
        int width = MeasureSpec.getSize(w);
        layout = StaticLayout.Builder.obtain(text, 0, text.length(), paint, Math.max(1, width)).setAlignment(Layout.Alignment.ALIGN_NORMAL).build();
        setMeasuredDimension(width, layout.getHeight());
    }

    @Override protected void onDraw(Canvas c) { if (layout != null) layout.draw(c); }

    @Override public AccessibilityNodeProvider getAccessibilityNodeProvider() {
        if (mode != MainActivity.CANVAS_A11Y) return null;
        return new AccessibilityNodeProvider() {
            @Override public AccessibilityNodeInfo createAccessibilityNodeInfo(int id) {
                if (id == View.NO_ID) {
                    AccessibilityNodeInfo host = AccessibilityNodeInfo.obtain(DrawnText.this);
                    onInitializeAccessibilityNodeInfo(host);
                    host.addChild(DrawnText.this, 0);
                    return host;
                }
                if (id != 0) return null;
                AccessibilityNodeInfo n = AccessibilityNodeInfo.obtain(DrawnText.this, 0);
                n.setParent(DrawnText.this);
                n.setText(text);
                n.setVisibleToUser(true);
                n.setBoundsInParent(new Rect(0, 0, getWidth(), getHeight()));
                int[] l = new int[2];
                getLocationOnScreen(l);
                n.setBoundsInScreen(new Rect(l[0], l[1], l[0] + getWidth(), l[1] + getHeight()));
                return n;
            }
        };
    }
}
