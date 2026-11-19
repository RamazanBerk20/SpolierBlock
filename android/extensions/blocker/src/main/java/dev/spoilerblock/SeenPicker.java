package dev.spoilerblock;

import android.app.Activity;
import android.app.Dialog;
import android.content.res.ColorStateList;
import android.text.SpannableStringBuilder;
import android.text.Spanned;
import android.text.style.ForegroundColorSpan;
import android.text.style.RelativeSizeSpan;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.view.Window;
import android.widget.CheckBox;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;

import java.util.ArrayList;
import java.util.List;

/**
 * "I've seen it" on a cover whose name stands for several works (a franchise, an original and its remake): the user
 * ticks the ones they have seen (contract, cover wording). A plain framework dialog in the settings screen's look, in
 * the dark or light of the surface the cover sat on; our scanner never reads it (it lists titles).
 */
final class SeenPicker {
    /** The picker's note (contract, cover wording): the group's own label, or a general note when the cover names several. */
    static String note(int groups, String label) {
        return groups > 1 ? "This post names several works. It stays covered until each one is marked."
            : "Posts that only say \"" + label + "\" stay covered until every one is marked.";
    }

    /** works: the unseen works of every group the cover names; groups, label: how many groups, and the first one's label. */
    static void show(Activity a, boolean dark, Matcher m, List<Integer> works, int groups, String label) {
        Ui.Palette p = new Ui.Palette(dark);
        Dialog d = new Dialog(a, android.R.style.Theme_Material_Dialog_NoActionBar);
        LinearLayout l = new LinearLayout(a);
        l.setOrientation(LinearLayout.VERTICAL);
        int pad = Ui.dp(a, 24);
        l.setPadding(pad, pad, pad, Ui.dp(a, 16));

        TextView title = Ui.text(a, Ui.TITLE_LARGE, p.text, false);
        title.setText("Which have you seen?");
        if (android.os.Build.VERSION.SDK_INT >= 28) title.setAccessibilityHeading(true);
        title.setPadding(0, 0, 0, Ui.dp(a, 12));
        l.addView(title, Ui.matchWidth());

        LinearLayout rows = new LinearLayout(a);
        rows.setOrientation(LinearLayout.VERTICAL);
        List<CheckBox> boxes = new ArrayList<>();
        for (int w : works) {
            CheckBox c = new CheckBox(a);
            SpannableStringBuilder s = new SpannableStringBuilder(m.titles[w]);
            String sub = SettingsActivity.typeLabel(m.types[w]) + (m.years[w] > 0 ? " · " + m.years[w] : "");
            if (sub.startsWith(" · ")) sub = sub.substring(3);
            if (!sub.isEmpty()) {
                int at = s.length();
                s.append('\n').append(sub);
                s.setSpan(new RelativeSizeSpan(Ui.BODY_MEDIUM / (float) Ui.BODY_LARGE), at, s.length(), Spanned.SPAN_EXCLUSIVE_EXCLUSIVE);
                s.setSpan(new ForegroundColorSpan(p.muted), at, s.length(), Spanned.SPAN_EXCLUSIVE_EXCLUSIVE);
            }
            c.setText(s);
            c.setTextSize(android.util.TypedValue.COMPLEX_UNIT_SP, Ui.BODY_LARGE);
            c.setTextColor(p.text);
            c.setButtonTintList(ColorStateList.valueOf(p.accent));
            c.setMinHeight(Ui.dp(a, 56));
            c.setGravity(Gravity.CENTER_VERTICAL);
            c.setPadding(Ui.dp(a, 12), Ui.dp(a, 6), 0, Ui.dp(a, 6));
            rows.addView(c, Ui.matchWidth());
            boxes.add(c);
        }
        ScrollView scroll = new ScrollView(a);
        scroll.addView(rows);
        // wraps its rows, and gives way (scrolls) when they do not fit on screen
        l.addView(scroll, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT, 1));

        TextView note = Ui.text(a, Ui.BODY_SMALL, p.muted, false);
        note.setText(note(groups, label));
        note.setPadding(0, Ui.dp(a, 12), 0, Ui.dp(a, 8));
        l.addView(note, Ui.matchWidth());

        LinearLayout buttons = new LinearLayout(a);
        buttons.setGravity(Gravity.CENTER_VERTICAL);
        TextView all = Ui.button(a, p, "All", Ui.TEXT), cancel = Ui.button(a, p, "Cancel", Ui.TEXT), ok = Ui.button(a, p, "Mark seen", Ui.FILLED);
        buttons.addView(all, Ui.wrap());
        buttons.addView(new View(a), new LinearLayout.LayoutParams(0, 1, 1));
        buttons.addView(cancel, Ui.wrap());
        LinearLayout.LayoutParams okp = Ui.wrap();
        okp.setMarginStart(Ui.dp(a, 8));
        buttons.addView(ok, okp);
        l.addView(buttons, Ui.matchWidth());

        Runnable sync = () -> {
            boolean any = false;
            for (CheckBox c : boxes) any |= c.isChecked();
            ok.setEnabled(any);
            ok.setAlpha(any ? 1f : 0.38f);
        };
        for (CheckBox c : boxes) c.setOnCheckedChangeListener((v, on) -> sync.run());
        sync.run();
        all.setOnClickListener(v -> { for (CheckBox c : boxes) c.setChecked(true); });
        cancel.setOnClickListener(v -> d.dismiss());
        ok.setOnClickListener(v -> {
            List<Integer> picked = new ArrayList<>();
            for (int i = 0; i < boxes.size(); i++) if (boxes.get(i).isChecked()) picked.add(works.get(i));
            d.dismiss();
            try { SpoilerBlock.I.markWorks(picked); } catch (Throwable t) { SpoilerBlock.fail("mark seen", t); }
        });

        d.setContentView(l);
        d.setTitle("Which have you seen?"); // the window's name for TalkBack
        Window win = d.getWindow();
        win.setBackgroundDrawable(Ui.shape(p.surface, 0, 0, Ui.dp(a, 28)));
        View decor = win.getDecorView();
        SpoilerBlock.ownWindows.put(decor, true);
        int width = Math.min(a.getResources().getDisplayMetrics().widthPixels - Ui.dp(a, 32), Ui.dp(a, 420));
        d.show();
        win.setLayout(width, ViewGroup.LayoutParams.WRAP_CONTENT);
        if (!boxes.isEmpty()) boxes.get(0).requestFocus();
    }
}
