package dev.spoilerblock;

import android.graphics.Matrix;
import android.os.Bundle;
import android.os.LocaleList;
import android.view.ViewStructure;
import android.view.autofill.AutofillId;
import android.view.autofill.AutofillValue;

/**
 * Collects text from View.onProvideVirtualStructure, which for a view with an AccessibilityNodeProvider (Litho,
 * Compose, ExploreByTouchHelper-based custom views) walks the provider's virtual node tree. Public API only.
 */
final class TextCapture extends ViewStructure {
    /** An item's text: each distinct string once (a content description often repeats the visible text). */
    static final class Texts {
        final StringBuilder sb = new StringBuilder();
        private final java.util.Set<String> seen = new java.util.HashSet<>();
        String handle; // rule 11: the first piece that is exactly one "@handle" (X's author), or null

        void add(CharSequence s) {
            if (s == null || s.length() == 0) return;
            String k = s.toString();
            if (handle == null && HANDLE.matcher(k).matches()) handle = k;
            if (seen.add(k)) sb.append(k).append('\n');
        }
    }

    private static final java.util.regex.Pattern HANDLE = java.util.regex.Pattern.compile("@[A-Za-z0-9_]{1,15}");

    private final Texts out;
    private int children;

    TextCapture(Texts out) { this.out = out; }

    private void add(CharSequence s) { out.add(s); }

    @Override public void setText(CharSequence t) { add(t); }
    @Override public void setText(CharSequence t, int a, int b) { add(t); }
    @Override public void setContentDescription(CharSequence c) { add(c); }
    @Override public ViewStructure newChild(int i) { return new TextCapture(out); }
    @Override public ViewStructure asyncNewChild(int i) { return new TextCapture(out); }
    @Override public void setChildCount(int n) { children = n; }
    @Override public int addChildCount(int n) { int r = children; children += n; return r; }
    @Override public int getChildCount() { return children; }

    // Hidden abstract method of ViewStructure, called by View.populateVirtualStructure: implementing it is the only way.
    private final android.graphics.Rect temp = new android.graphics.Rect();
    public android.graphics.Rect getTempRect() { return temp; }

    @Override public void asyncCommit() { }
    @Override public AutofillId getAutofillId() { return null; }
    @Override public Bundle getExtras() { return new Bundle(); }
    @Override public CharSequence getHint() { return null; }
    @Override public CharSequence getText() { return null; }
    @Override public int getTextSelectionEnd() { return -1; }
    @Override public int getTextSelectionStart() { return -1; }
    @Override public boolean hasExtras() { return false; }
    @Override public HtmlInfo.Builder newHtmlInfoBuilder(String t) { return null; }
    @Override public void setAccessibilityFocused(boolean b) { }
    @Override public void setActivated(boolean b) { }
    @Override public void setAlpha(float a) { }
    @Override public void setAutofillHints(String[] h) { }
    @Override public void setAutofillId(AutofillId id) { }
    @Override public void setAutofillId(AutofillId p, int v) { }
    @Override public void setAutofillOptions(CharSequence[] o) { }
    @Override public void setAutofillType(int t) { }
    @Override public void setAutofillValue(AutofillValue v) { }
    @Override public void setCheckable(boolean b) { }
    @Override public void setChecked(boolean b) { }
    @Override public void setClassName(String c) { }
    @Override public void setClickable(boolean b) { }
    @Override public void setContextClickable(boolean b) { }
    @Override public void setDataIsSensitive(boolean b) { }
    @Override public void setDimens(int l, int t, int sx, int sy, int w, int h) { }
    @Override public void setElevation(float e) { }
    @Override public void setEnabled(boolean b) { }
    @Override public void setFocusable(boolean b) { }
    @Override public void setFocused(boolean b) { }
    @Override public void setHint(CharSequence h) { }
    @Override public void setHtmlInfo(HtmlInfo i) { }
    @Override public void setId(int id, String p, String t, String e) { }
    @Override public void setInputType(int t) { }
    @Override public void setLocaleList(LocaleList l) { }
    @Override public void setLongClickable(boolean b) { }
    @Override public void setOpaque(boolean b) { }
    @Override public void setSelected(boolean b) { }
    @Override public void setTextLines(int[] o, int[] b) { }
    @Override public void setTextStyle(float s, int fg, int bg, int st) { }
    @Override public void setTransformation(Matrix m) { }
    @Override public void setVisibility(int v) { }
    @Override public void setWebDomain(String d) { }
}
