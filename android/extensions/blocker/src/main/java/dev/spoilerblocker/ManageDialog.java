package dev.spoilerblocker;

import android.app.Activity;
import android.app.AlertDialog;
import android.util.TypedValue;
import android.view.Gravity;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.Switch;
import android.widget.TextView;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

/** Management screen: master switch, spoiler mode and the list of seen works. Built in code: the extension has no resources. */
final class ManageDialog {
    static void show(Activity a, SpoilerBlocker sb) {
        try {
            int pad = (int) TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, 20, a.getResources().getDisplayMetrics());
            LinearLayout box = new LinearLayout(a);
            box.setOrientation(LinearLayout.VERTICAL);
            box.setPadding(pad, pad / 2, pad, 0);

            Switch on = new Switch(a);
            on.setText("Block spoilers");
            on.setTextSize(16);
            on.setChecked(sb.enabled);
            on.setOnCheckedChangeListener((v, checked) -> sb.setEnabled(checked));
            box.addView(on);

            Switch mode = new Switch(a);
            mode.setText("Only block actual spoilers");
            mode.setTextSize(16);
            mode.setChecked(sb.spoilerMode);
            mode.setOnCheckedChangeListener((v, checked) -> sb.setSpoilerMode(checked));
            box.addView(mode);
            TextView modeNote = new TextView(a);
            modeNote.setText("Off: block anything about unseen titles");
            box.addView(modeNote);

            Switch img = new Switch(a);
            img.setText("Scan images and video");
            img.setTextSize(16);
            img.setChecked(sb.scanImages);
            img.setOnCheckedChangeListener((v, checked) -> sb.setScanImages(checked));
            box.addView(img);

            TextView note = new TextView(a);
            note.setText("Blocks posts that mention a film, show, game or book you have not marked as seen. " +
                "Works on this device only.");
            note.setPadding(0, pad / 2, 0, pad / 2);
            box.addView(note);

            // catalog update (opt-in)
            TextView cat = new TextView(a);
            cat.setText("Update catalog");
            cat.setTextSize(16);
            box.addView(cat);
            android.widget.RadioGroup modes = new android.widget.RadioGroup(a);
            modes.setOrientation(LinearLayout.HORIZONTAL);
            String[] labels = {"Off", "Daily", "Weekly", "Monthly"};
            for (int i = 0; i < labels.length; i++) {
                android.widget.RadioButton rb = new android.widget.RadioButton(a);
                rb.setText(labels[i]);
                rb.setId(1000 + i);
                modes.addView(rb);
                if (SpoilerBlocker.CATALOG_MODES[i].equals(sb.catalogMode())) rb.setChecked(true);
            }
            modes.setOnCheckedChangeListener((g, id) -> sb.setCatalogMode(SpoilerBlocker.CATALOG_MODES[id - 1000]));
            box.addView(modes);
            TextView status = new TextView(a);
            status.setText(sb.catalogStatus());
            box.addView(status);
            Button now = new Button(a);
            now.setText("Update now");
            now.setOnClickListener(v -> sb.maybeUpdateCatalog(true));
            box.addView(now);
            TextView privacy = new TextView(a);
            privacy.setText("Downloads new titles from Wikidata. Nothing about you or your browsing is sent.");
            privacy.setPadding(0, 0, 0, pad / 2);
            box.addView(privacy);
            sb.catalogListener = () -> status.setText(sb.catalogStatus());

            Matcher m = sb.matcher;
            List<String> ids = new ArrayList<>(sb.seenIds());
            Collections.sort(ids);
            TextView head = new TextView(a);
            head.setText("Seen (" + ids.size() + ")");
            head.setTextSize(16);
            box.addView(head);
            for (String id : ids) {
                LinearLayout row = new LinearLayout(a);
                row.setGravity(Gravity.CENTER_VERTICAL);
                TextView t = new TextView(a);
                t.setText(m == null ? id : describe(m, id));
                row.addView(t, new LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1));
                Button rm = new Button(a);
                rm.setText("Remove");
                rm.setOnClickListener(v -> { sb.unmarkSeen(id); box.removeView(row); head.setText("Seen (" + sb.seenIds().size() + ")"); });
                row.addView(rm);
                box.addView(row);
            }
            ScrollView sv = new ScrollView(a);
            sv.addView(box);
            new AlertDialog.Builder(a).setTitle("Spoiler settings").setView(sv).setPositiveButton("Close", null)
                .setOnDismissListener(d -> sb.catalogListener = null).show();
        } catch (Throwable t) {
            SpoilerBlocker.fail("manage dialog", t);
        }
    }

    private static String describe(Matcher m, String id) {
        for (int i = 0; i < m.ids.length; i++) {
            if (m.ids[i].equals(id)) return m.titles[i] + " (" + m.types[i] + (m.years[i] != 0 ? ", " + m.years[i] : "") + ")";
        }
        return id;
    }
}
