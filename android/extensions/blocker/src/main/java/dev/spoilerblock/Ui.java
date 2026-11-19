package dev.spoilerblock;

import android.content.Context;
import android.content.res.ColorStateList;
import android.content.res.Configuration;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.ColorFilter;
import android.graphics.Paint;
import android.graphics.Path;
import android.graphics.PixelFormat;
import android.graphics.Typeface;
import android.graphics.drawable.ColorDrawable;
import android.graphics.drawable.Drawable;
import android.graphics.drawable.LayerDrawable;
import android.graphics.drawable.GradientDrawable;
import android.graphics.drawable.RippleDrawable;
import android.text.TextUtils;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.widget.LinearLayout;
import android.widget.TextView;

/**
 * The look of the cover and the settings screen, in code: the extension is merged into other apps' APKs, so it has no
 * resources of its own and no AndroidX. One quiet palette per system theme, a warm amber accent (the companion's icon),
 * Material roles and sizes: 48 dp touch targets, sp text that follows the font-size setting.
 */
final class Ui {
    static final class Palette {
        final int bg, surface, surfaceHigh, text, muted, outline, accent, onAccent, accentContainer, onAccentContainer, error;
        int cover, shade; // a cover, and a picture still being judged (a placeholder tone)
        final boolean dark;

        Palette(boolean dark) {
            this.dark = dark;
            if (dark) {
                bg = 0xFF141317; surface = 0xFF1D1C21; surfaceHigh = 0xFF29282E; text = 0xFFECE9E3; muted = 0xFFABA7B0; outline = 0xFF4A4850;
                accent = 0xFFF0B856; onAccent = 0xFF2A1C00; accentContainer = 0xFF4A3814; onAccentContainer = 0xFFFFE0A8; cover = 0xFF1C1B20; error = 0xFFFFB4AB;
            } else {
                bg = 0xFFFBF8F2; surface = 0xFFF4F0E8; surfaceHigh = 0xFFEAE5DB; text = 0xFF1D1B20; muted = 0xFF57545E; outline = 0xFFC9C3B8;
                accent = 0xFF7A5200; onAccent = 0xFFFFFFFF; accentContainer = 0xFFFFDEA6; onAccentContainer = 0xFF271900; cover = 0xFFE9E4DA; error = 0xFFBA1A1A;
            }
            shade = cover;
        }
    }

    /**
     * Colours for a cover or shade on v: from the surface it sits on (contract: dark on a dark surface, light on a light
     * one, whatever the system setting says), dark when no surface colour can be read.
     */
    static Palette on(View v) {
        Integer s = surface(v);
        boolean dark = s == null || 0.2126 * Color.red(s) + 0.7152 * Color.green(s) + 0.0722 * Color.blue(s) < 128;
        Palette p = new Palette(dark);
        if (s != null) {
            int ink = dark ? 0xFFFFFFFF : 0xFF000000;
            p.cover = mix(s, ink, 0.06f);
            p.shade = mix(s, ink, 0.10f); // close to the grey hosts paint a picture's place with while it loads
        } else p.shade = mix(p.cover, 0xFFFFFFFF, 0.04f);
        return p;
    }

    static int mix(int a, int b, float t) {
        return Color.rgb(Math.round(Color.red(a) + (Color.red(b) - Color.red(a)) * t), Math.round(Color.green(a) + (Color.green(b) - Color.green(a)) * t),
            Math.round(Color.blue(a) + (Color.blue(b) - Color.blue(a)) * t));
    }

    /** The first opaque background of v or a parent (up to the window's), else the theme's background colour. */
    static Integer surface(View v) {
        for (Object o = v; o instanceof View; o = ((View) o).getParent()) {
            Integer c = colorOf(((View) o).getBackground(), 0);
            if (c != null) return c;
        }
        TypedValue tv = new TypedValue();
        if (v.getContext().getTheme().resolveAttribute(android.R.attr.colorBackground, tv, true)
            && tv.type >= TypedValue.TYPE_FIRST_COLOR_INT && tv.type <= TypedValue.TYPE_LAST_COLOR_INT && Color.alpha(tv.data) >= 0xE0) return tv.data;
        return null;
    }

    private static Integer colorOf(Drawable d, int depth) {
        if (d == null || depth > 4 || d.getAlpha() < 0xE0) return null;
        Integer c = null;
        if (d instanceof ColorDrawable) c = ((ColorDrawable) d).getColor();
        else if (d instanceof GradientDrawable && android.os.Build.VERSION.SDK_INT >= 24) {
            ColorStateList l = ((GradientDrawable) d).getColor();
            if (l != null) c = l.getColorForState(d.getState(), l.getDefaultColor());
        } else if (d instanceof LayerDrawable) { // the top opaque layer (a ripple over a fill, a border over a fill)
            LayerDrawable l = (LayerDrawable) d;
            for (int i = l.getNumberOfLayers() - 1; i >= 0 && c == null; i--) c = colorOf(l.getDrawable(i), depth + 1);
        } else if (android.os.Build.VERSION.SDK_INT >= 23 && d instanceof android.graphics.drawable.DrawableWrapper) {
            c = colorOf(((android.graphics.drawable.DrawableWrapper) d).getDrawable(), depth + 1);
        } else if (d.getCurrent() != d) c = colorOf(d.getCurrent(), depth + 1); // a state list: its current state
        return c != null && Color.alpha(c) >= 0xE0 ? c : null;
    }

    static boolean dark(Context c) {
        return (c.getResources().getConfiguration().uiMode & Configuration.UI_MODE_NIGHT_MASK) == Configuration.UI_MODE_NIGHT_YES;
    }

    static Palette palette(Context c) { return new Palette(dark(c)); }

    static int dp(Context c, float v) { return Math.round(TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, v, c.getResources().getDisplayMetrics())); }

    // ---------- type: Material roles, in sp ----------

    static final int TITLE_LARGE = 22, TITLE_MEDIUM = 16, BODY_LARGE = 16, BODY_MEDIUM = 14, LABEL_LARGE = 14, BODY_SMALL = 12;

    static TextView text(Context c, int sp, int color, boolean medium) {
        TextView t = new TextView(c);
        t.setTextSize(TypedValue.COMPLEX_UNIT_SP, sp);
        t.setTextColor(color);
        if (medium) t.setTypeface(Typeface.create("sans-serif-medium", Typeface.NORMAL));
        t.setLineSpacing(0, 1.15f);
        return t;
    }

    static GradientDrawable shape(int fill, int stroke, int strokePx, float radiusPx) {
        GradientDrawable g = new GradientDrawable();
        g.setColor(fill);
        if (strokePx > 0) g.setStroke(strokePx, stroke);
        g.setCornerRadius(radiusPx);
        return g;
    }

    /** A pressed-state ripple over a background (or over nothing, bounded by the view). */
    static Drawable ripple(Palette p, Drawable content) {
        int ink = (p.dark ? 0x33FFFFFF : 0x22000000);
        return new RippleDrawable(ColorStateList.valueOf(ink), content, content == null ? shape(0xFFFFFFFF, 0, 0, 0) : null);
    }

    /** Material button: filled (primary action), tonal, outlined or text. At least 48 dp tall. */
    static TextView button(Context c, Palette p, String label, int kind) {
        TextView b = text(c, LABEL_LARGE, kind == FILLED ? p.onAccent : kind == TONAL ? p.onAccentContainer : kind == DANGER ? p.error : kind == TEXT ? p.accent : p.text, true);
        b.setText(label);
        b.setGravity(Gravity.CENTER);
        b.setMinHeight(dp(c, 48));
        b.setMinWidth(dp(c, 64));
        b.setMaxLines(2);
        b.setEllipsize(TextUtils.TruncateAt.END);
        b.setPadding(dp(c, kind == TEXT ? 12 : 24), 0, dp(c, kind == TEXT ? 12 : 24), 0);
        float r = dp(c, 24);
        Drawable bg = kind == FILLED ? shape(p.accent, 0, 0, r) : kind == TONAL ? shape(p.accentContainer, 0, 0, r)
            : kind == OUTLINED || kind == DANGER ? shape(0, kind == DANGER ? p.error : p.outline, dp(c, 1), r) : null;
        b.setBackground(ripple(p, bg));
        b.setClickable(true);
        b.setFocusable(true);
        return b;
    }

    static final int FILLED = 0, TONAL = 1, OUTLINED = 2, TEXT = 3, DANGER = 4;

    static LinearLayout.LayoutParams wrap() { return new LinearLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT); }
    static LinearLayout.LayoutParams matchWidth() { return new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT); }

    /** Single-choice segmented buttons (Material): one outlined pill, the chosen segment filled with the accent container. */
    static final class Segmented extends LinearLayout {
        interface Listener { void picked(String value); }
        private final String[] values;
        private final TextView[] segs;
        private final Palette p;
        private Listener listener;
        private String value;

        Segmented(Context c, Palette p, String[] labels, String[] values, String description) {
            super(c);
            this.p = p;
            this.values = values;
            segs = new TextView[labels.length];
            setOrientation(HORIZONTAL);
            setBaselineAligned(false); // a label that wraps to two lines must not push its segment down
            float r = dp(c, 20);
            setBackground(shape(0, p.outline, dp(c, 1), r));
            setContentDescription(null);
            for (int i = 0; i < labels.length; i++) {
                TextView s = text(c, LABEL_LARGE, p.text, true);
                s.setText(labels[i]);
                s.setGravity(Gravity.CENTER);
                s.setMinHeight(dp(c, 48));
                s.setMaxLines(2);
                s.setPadding(dp(c, 6), dp(c, 4), dp(c, 6), dp(c, 4));
                s.setContentDescription(description + ": " + labels[i]);
                String v = values[i];
                s.setOnClickListener(x -> { if (!v.equals(value)) { select(v); if (listener != null) listener.picked(v); } });
                addView(s, new LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1));
                segs[i] = s;
            }
        }

        Segmented onPick(Listener l) { listener = l; return this; }

        /** Shows a value without telling the listener. */
        void select(String v) {
            value = v;
            float r = dp(getContext(), 20);
            for (int i = 0; i < segs.length; i++) {
                boolean on = values[i].equals(v);
                segs[i].setSelected(on); // TalkBack says "selected"
                segs[i].setTextColor(on ? p.onAccentContainer : p.text);
                float[] radii = {i == 0 ? r : 0, i == 0 ? r : 0, i == segs.length - 1 ? r : 0, i == segs.length - 1 ? r : 0,
                    i == segs.length - 1 ? r : 0, i == segs.length - 1 ? r : 0, i == 0 ? r : 0, i == 0 ? r : 0};
                GradientDrawable g = new GradientDrawable();
                g.setColor(on ? p.accentContainer : 0);
                g.setCornerRadii(radii);
                segs[i].setBackground(ripple(p, g));
            }
        }
    }

    /** Drawn icons (no icon font, no resources): back arrow, close, check. 24 dp, 2 dp stroke. */
    static final class Icon extends Drawable {
        static final int BACK = 0, CLOSE = 1;
        private final Paint paint = new Paint(Paint.ANTI_ALIAS_FLAG);
        private final int kind, size;

        Icon(Context c, int kind, int color) {
            this.kind = kind;
            size = dp(c, 24);
            paint.setColor(color);
            paint.setStyle(Paint.Style.STROKE);
            paint.setStrokeWidth(dp(c, 2));
            paint.setStrokeCap(Paint.Cap.ROUND);
            paint.setStrokeJoin(Paint.Join.ROUND);
        }

        @Override public void draw(Canvas c) {
            float s = size / 24f, x = getBounds().exactCenterX() - size / 2f, y = getBounds().exactCenterY() - size / 2f;
            Path path = new Path();
            if (kind == BACK) {
                path.moveTo(x + 20 * s, y + 12 * s); path.lineTo(x + 4 * s, y + 12 * s);
                path.moveTo(x + 11 * s, y + 5 * s); path.lineTo(x + 4 * s, y + 12 * s); path.lineTo(x + 11 * s, y + 19 * s);
            } else {
                path.moveTo(x + 6 * s, y + 6 * s); path.lineTo(x + 18 * s, y + 18 * s);
                path.moveTo(x + 18 * s, y + 6 * s); path.lineTo(x + 6 * s, y + 18 * s);
            }
            c.drawPath(path, paint);
        }

        @Override public int getIntrinsicWidth() { return size; }
        @Override public int getIntrinsicHeight() { return size; }
        @Override public void setAlpha(int a) { paint.setAlpha(a); }
        @Override public void setColorFilter(ColorFilter f) { paint.setColorFilter(f); }
        @Override public int getOpacity() { return PixelFormat.TRANSLUCENT; }
    }

    /** A 48 dp icon button with a round ripple. */
    static View iconButton(Context c, Palette p, int icon, int color, String description) {
        TextView b = new TextView(c);
        Drawable d = new Icon(c, icon, color);
        b.setCompoundDrawablesRelativeWithIntrinsicBounds(d, null, null, null);
        b.setGravity(Gravity.CENTER);
        b.setPadding(dp(c, 12), dp(c, 12), dp(c, 12), dp(c, 12));
        b.setMinWidth(dp(c, 48));
        b.setMinHeight(dp(c, 48));
        b.setContentDescription(description);
        GradientDrawable mask = new GradientDrawable();
        mask.setShape(GradientDrawable.OVAL);
        mask.setColor(0xFFFFFFFF);
        b.setBackground(new RippleDrawable(ColorStateList.valueOf(p.dark ? 0x33FFFFFF : 0x22000000), null, mask));
        b.setClickable(true);
        b.setFocusable(true);
        return b;
    }

    static View divider(Context c, Palette p) {
        View v = new View(c);
        v.setBackgroundColor(p.outline);
        v.setLayoutParams(new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, Math.max(1, dp(c, 1) / 2 + 1)));
        return v;
    }
}
