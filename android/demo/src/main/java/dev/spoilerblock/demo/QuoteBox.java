package dev.spoilerblock.demo;

import android.content.Context;
import android.graphics.Canvas;
import android.graphics.Paint;
import android.text.Layout;
import android.text.StaticLayout;
import android.text.TextPaint;
import android.util.TypedValue;
import android.view.View;

/**
 * A quoted post drawn by its frame, like X's QuoteView: the text is kept in a field and laid out in onMeasure, with no
 * setter, no content description and no accessibility node. Only the patch's field hook (QuoteView-style: SpoilerBlock
 * .text(this, quoted) at the start of onMeasure) can read it. Kept by name in proguard-rules.pro.
 */
public class QuoteBox extends View {
    public CharSequence quoted = "";
    private final TextPaint paint = new TextPaint(TextPaint.ANTI_ALIAS_FLAG);
    private final Paint border = new Paint(Paint.ANTI_ALIAS_FLAG);
    private StaticLayout layout;
    private final int pad;

    QuoteBox(Context c) {
        super(c);
        paint.setTextSize(TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_SP, 15, c.getResources().getDisplayMetrics()));
        paint.setColor(0xFF37474F);
        border.setStyle(Paint.Style.STROKE);
        border.setColor(0xFFB0BEC5);
        border.setStrokeWidth(2);
        pad = (int) TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, 12, c.getResources().getDisplayMetrics());
    }

    void quote(CharSequence t) { // not hooked: the text is only read where the view lays it out
        quoted = t;
        requestLayout();
        invalidate();
    }

    @Override protected void onMeasure(int w, int h) {
        int width = MeasureSpec.getSize(w);
        layout = StaticLayout.Builder.obtain(quoted, 0, quoted.length(), paint, Math.max(1, width - 2 * pad)).setAlignment(Layout.Alignment.ALIGN_NORMAL).build();
        setMeasuredDimension(width, layout.getHeight() + 2 * pad);
    }

    @Override protected void onDraw(Canvas c) {
        c.drawRoundRect(1, 1, getWidth() - 1, getHeight() - 1, pad, pad, border);
        if (layout == null) return;
        c.save();
        c.translate(pad, pad);
        layout.draw(c);
        c.restore();
    }
}
