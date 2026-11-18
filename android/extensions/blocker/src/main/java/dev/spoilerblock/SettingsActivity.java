package dev.spoilerblock;

import android.app.Activity;
import android.app.AlertDialog;
import android.content.Intent;
import android.graphics.drawable.ColorDrawable;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.text.Editable;
import android.text.InputType;
import android.text.TextUtils;
import android.text.TextWatcher;
import android.util.Log;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.view.WindowInsets;
import android.view.WindowManager;
import android.widget.ArrayAdapter;
import android.widget.BaseAdapter;
import android.widget.CheckBox;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.HorizontalScrollView;
import android.widget.LinearLayout;
import android.widget.ListView;
import android.widget.ScrollView;
import android.widget.Spinner;
import android.widget.Switch;
import android.widget.TextView;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.Iterator;
import java.util.List;
import java.util.Locale;
import java.util.Map;

/**
 * The settings screen: Library, Add by hand, Blocking, Data, About. One implementation for the companion app (its
 * launcher activity) and the patched apps (the patch adds this activity to their manifest; it opens from a cover's
 * settings button, the app shortcut and the app's own settings). Built in code with plain framework views.
 */
public final class SettingsActivity extends Activity {
    static final String VERSION = "0.2.0";
    private static final int EXPORT = 1, IMPORT = 2;
    private static final String[] TABS = {"Library", "Add by hand", "Blocking", "Data", "About"};
    private static final String[] TYPE_LABELS = {"Film", "TV show", "Game", "Book", "Anime", "Manga", "Comic"};

    private Store store;
    private Ui.Palette p;
    private int tab;
    private FrameLayout content;
    private final List<TextView> tabViews = new ArrayList<>();
    private final List<Runnable> binders = new ArrayList<>(); // put the config's values into the open tab's controls
    private boolean binding;
    private final Runnable onConfig = this::configChanged;
    private static volatile Matcher ownTitles; // when no blocker index is loaded in this process (the companion)
    private Library library;
    private TextView notice;
    private final Runnable hideNotice = () -> notice.setVisibility(View.GONE);

    @Override protected void onCreate(Bundle b) {
        p = Ui.palette(this);
        setTheme(p.dark ? android.R.style.Theme_Material_NoActionBar : android.R.style.Theme_Material_Light_NoActionBar);
        super.onCreate(b);
        try {
            build(b);
        } catch (Throwable t) { // inside another app: never take the app down with us
            Log.e(SpoilerBlock.TAG, "settings screen failed", t);
            finish();
        }
    }

    private void build(Bundle b) {
        store = Store.get(this);
        tab = b != null ? b.getInt("tab", 0) : 0;

        FrameLayout frame = new FrameLayout(this);
        LinearLayout root = new LinearLayout(this);
        root.setOrientation(LinearLayout.VERTICAL);
        frame.addView(root);
        frame.setOnApplyWindowInsetsListener((v, in) -> {
            int l, t, r, bo;
            if (Build.VERSION.SDK_INT >= 30) {
                android.graphics.Insets i = in.getInsets(WindowInsets.Type.systemBars() | WindowInsets.Type.ime() | WindowInsets.Type.displayCutout());
                l = i.left; t = i.top; r = i.right; bo = i.bottom;
            } else {
                l = in.getSystemWindowInsetLeft(); t = in.getSystemWindowInsetTop(); r = in.getSystemWindowInsetRight(); bo = in.getSystemWindowInsetBottom();
            }
            v.setPadding(l, t, r, bo);
            return in;
        });

        // top app bar
        LinearLayout bar = new LinearLayout(this);
        bar.setGravity(Gravity.CENTER_VERTICAL);
        bar.setMinimumHeight(dp(64));
        bar.setPadding(dp(4), 0, dp(16), 0);
        if (!isTaskRoot() || SpoilerBlock.I != null) { // inside another app: a way back to it
            View back = Ui.iconButton(this, p, Ui.Icon.BACK, p.text, "Back");
            back.setOnClickListener(v -> finish());
            bar.addView(back);
        } else {
            bar.setPadding(dp(16), 0, dp(16), 0);
        }
        TextView title = Ui.text(this, Ui.TITLE_LARGE, p.text, false);
        title.setText("SpolierBlock");
        title.setPadding(dp(8), 0, 0, 0);
        title.setAccessibilityHeading(true);
        bar.addView(title, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1));
        root.addView(bar);

        // tabs (scrollable: five labels do not fit a small phone at large font sizes)
        HorizontalScrollView tabScroll = new HorizontalScrollView(this);
        tabScroll.setHorizontalScrollBarEnabled(false);
        LinearLayout tabs = new LinearLayout(this);
        tabs.setPadding(dp(8), 0, dp(8), 0);
        for (int i = 0; i < TABS.length; i++) {
            TextView t = Ui.text(this, Ui.LABEL_LARGE, p.muted, true);
            t.setText(TABS[i]);
            t.setGravity(Gravity.CENTER);
            t.setMinHeight(dp(48));
            t.setPadding(dp(16), 0, dp(16), 0);
            int k = i;
            t.setOnClickListener(v -> showTab(k));
            tabs.addView(t);
            tabViews.add(t);
        }
        tabScroll.addView(tabs);
        root.addView(tabScroll);
        root.addView(Ui.divider(this, p));

        content = new FrameLayout(this);
        root.addView(content, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1));

        notice = Ui.text(this, Ui.BODY_MEDIUM, p.dark ? 0xFF1D1B20 : 0xFFF4EFF4, false);
        notice.setBackground(Ui.shape(p.dark ? 0xFFE6E1E5 : 0xFF322F35, 0, 0, dp(4)));
        notice.setPadding(dp(16), dp(14), dp(16), dp(14));
        notice.setVisibility(View.GONE);
        notice.setAccessibilityLiveRegion(View.ACCESSIBILITY_LIVE_REGION_POLITE);
        FrameLayout.LayoutParams nl = new FrameLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT, Gravity.BOTTOM);
        nl.setMargins(dp(12), 0, dp(12), dp(12));
        frame.addView(notice, nl);

        setContentView(frame);
        setupWindow(); // after setContentView: the insets controller needs the decor view
        showTab(tab);
        store.listen(onConfig);
        if (matcher() == null) new Thread(() -> { // titles for the library and its search
            try {
                ownTitles = new Matcher(SpoilerBlock.readAll(getAssets().open("spoilerblock/index.bin")),
                    new String(SpoilerBlock.readAll(getAssets().open("spoilerblock/index.json")), StandardCharsets.UTF_8));
                runOnUiThread(this::configChanged);
            } catch (Exception e) {
                Log.w(SpoilerBlock.TAG, "no title index for the settings screen", e);
            }
        }, "SpoilerBlock-titles").start();
    }

    private void setupWindow() {
        getWindow().setBackgroundDrawable(new ColorDrawable(p.bg));
        getWindow().setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE);
        getWindow().setStatusBarColor(p.bg);
        getWindow().setNavigationBarColor(p.bg);
        if (Build.VERSION.SDK_INT >= 30) {
            int light = android.view.WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS | android.view.WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS;
            getWindow().getInsetsController().setSystemBarsAppearance(p.dark ? 0 : light, light);
        } else if (!p.dark) {
            getWindow().getDecorView().setSystemUiVisibility(View.SYSTEM_UI_FLAG_LIGHT_STATUS_BAR | View.SYSTEM_UI_FLAG_LIGHT_NAVIGATION_BAR);
        }
    }

    @Override protected void onSaveInstanceState(Bundle b) {
        super.onSaveInstanceState(b);
        b.putInt("tab", tab);
    }

    @Override protected void onDestroy() {
        if (store != null) store.unlisten(onConfig);
        if (SpoilerBlock.I != null) SpoilerBlock.I.catalogListener = null;
        super.onDestroy();
    }

    private int dp(float v) { return Ui.dp(this, v); }

    private Matcher matcher() {
        SpoilerBlock sb = SpoilerBlock.I;
        Matcher m = sb != null ? sb.matcher : null;
        return m != null ? m : ownTitles;
    }

    private void configChanged() {
        binding = true;
        try { for (Runnable r : binders) r.run(); } finally { binding = false; }
        if (library != null) library.refresh();
    }

    private void showTab(int k) {
        tab = k;
        for (int i = 0; i < tabViews.size(); i++) {
            TextView t = tabViews.get(i);
            boolean on = i == k;
            t.setSelected(on);
            t.setTextColor(on ? p.accent : p.muted);
            t.setBackground(on ? new Underline(p.accent, dp(3), dp(12)) : null);
        }
        binders.clear();
        library = null;
        content.removeAllViews();
        if (SpoilerBlock.I != null) SpoilerBlock.I.catalogListener = null;
        View v = k == 0 ? libraryTab() : k == 1 ? customTab() : k == 2 ? blockingTab() : k == 3 ? dataTab() : aboutTab();
        content.addView(v);
        configChanged();
    }

    /** The selected tab's indicator: a rounded bar under the label. */
    private static final class Underline extends android.graphics.drawable.Drawable {
        private final android.graphics.Paint paint = new android.graphics.Paint(android.graphics.Paint.ANTI_ALIAS_FLAG);
        private final int h, inset;
        Underline(int color, int h, int inset) { paint.setColor(color); this.h = h; this.inset = inset; }
        @Override public void draw(android.graphics.Canvas c) {
            android.graphics.Rect b = getBounds();
            c.drawRoundRect(b.left + inset, b.bottom - h, b.right - inset, b.bottom + h, h, h, paint);
        }
        @Override public void setAlpha(int a) { }
        @Override public void setColorFilter(android.graphics.ColorFilter f) { }
        @Override public int getOpacity() { return android.graphics.PixelFormat.TRANSLUCENT; }
    }

    private void notice(String s) {
        notice.setText(s);
        notice.setVisibility(View.VISIBLE);
        notice.removeCallbacks(hideNotice);
        notice.postDelayed(hideNotice, 4000);
    }

    // ---------- building blocks ----------

    private LinearLayout page() {
        LinearLayout l = new LinearLayout(this);
        l.setOrientation(LinearLayout.VERTICAL);
        l.setPadding(dp(16), dp(8), dp(16), dp(32));
        return l;
    }

    private View scroll(View page) {
        ScrollView s = new ScrollView(this);
        s.setFillViewport(true);
        s.addView(page);
        return s;
    }

    private void heading(LinearLayout l, String s) {
        TextView t = Ui.text(this, Ui.TITLE_MEDIUM, p.text, true);
        t.setText(s);
        t.setAccessibilityHeading(true);
        t.setPadding(0, dp(24), 0, dp(4));
        l.addView(t);
    }

    private TextView body(LinearLayout l, String s) {
        TextView t = Ui.text(this, Ui.BODY_MEDIUM, p.muted, false);
        t.setText(s);
        t.setPadding(0, 0, 0, dp(8));
        l.addView(t);
        return t;
    }

    private EditText field(String hint) {
        EditText e = new EditText(this);
        e.setHint(hint);
        e.setTextColor(p.text);
        e.setHintTextColor(p.muted);
        e.setTextSize(android.util.TypedValue.COMPLEX_UNIT_SP, Ui.BODY_LARGE);
        e.setSingleLine(true);
        e.setMinHeight(dp(56));
        e.setPadding(dp(16), 0, dp(16), 0);
        e.setBackground(Ui.shape(p.surface, p.outline, dp(1), dp(12)));
        e.setContentDescription(hint);
        return e;
    }

    /** A switch with its label, the explanation under it; bound to a boolean setting. */
    private void toggle(LinearLayout l, String key, String label, String explain) {
        Switch s = new Switch(this);
        s.setText(label);
        s.setTextColor(p.text);
        s.setTextSize(android.util.TypedValue.COMPLEX_UNIT_SP, Ui.BODY_LARGE);
        s.setMinHeight(dp(56));
        android.content.res.ColorStateList thumb = new android.content.res.ColorStateList(
            new int[][]{{android.R.attr.state_checked}, {}}, new int[]{p.accent, p.dark ? 0xFF938F99 : 0xFF79747E});
        android.content.res.ColorStateList track = new android.content.res.ColorStateList(
            new int[][]{{android.R.attr.state_checked}, {}}, new int[]{p.accentContainer, p.surfaceHigh});
        s.setThumbTintList(thumb);
        s.setTrackTintList(track);
        s.setOnCheckedChangeListener((v, on) -> { if (!binding) store.patch(Config.settingPatch(key, on)); });
        binders.add(() -> s.setChecked(store.get().bool(key)));
        l.addView(s, Ui.matchWidth());
        TextView t = body(l, explain);
        t.setPadding(0, 0, dp(64), dp(12));
    }

    private static String typeLabel(String type) {
        int i = Config.TYPES.indexOf(type);
        return i < 0 ? "" : TYPE_LABELS[i];
    }

    // ---------- Library ----------

    private View libraryTab() {
        LinearLayout l = new LinearLayout(this);
        l.setOrientation(LinearLayout.VERTICAL);
        LinearLayout top = new LinearLayout(this);
        top.setOrientation(LinearLayout.VERTICAL);
        top.setPadding(dp(16), dp(12), dp(16), dp(8));
        EditText search = field("Search titles");
        search.setImeOptions(android.view.inputmethod.EditorInfo.IME_ACTION_SEARCH);
        top.addView(search, Ui.matchWidth());
        Ui.Segmented filter = new Ui.Segmented(this, p, new String[]{"All", "Seen", "Blocked"}, new String[]{"all", Config.SEEN, Config.BLOCKED}, "Show");
        LinearLayout.LayoutParams fl = Ui.matchWidth();
        fl.topMargin = dp(12);
        top.addView(filter, fl);
        l.addView(top);
        ListView list = new ListView(this);
        list.setDivider(null);
        list.setSelector(new ColorDrawable(0));
        list.setClipToPadding(false);
        list.setPadding(0, 0, 0, dp(24));
        library = new Library(search, filter);
        list.setAdapter(library);
        l.addView(list, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1));
        filter.select("all");
        search.addTextChangedListener(new TextWatcher() {
            @Override public void beforeTextChanged(CharSequence s, int a, int b, int c) { }
            @Override public void onTextChanged(CharSequence s, int a, int b, int c) { }
            @Override public void afterTextChanged(Editable e) { library.refresh(); }
        });
        return l;
    }

    /** Rows: section labels, the user's works (tap to change), catalog results to add. */
    private final class Library extends BaseAdapter {
        private final EditText search;
        private final Ui.Segmented filter;
        private String filterValue = "all";
        private final List<Object[]> rows = new ArrayList<>(); // {kind, payload}: "section" label | "work" id | "result" index | "empty" text
        private String expanded;
        private Map<String, Integer> index; // work id -> matcher index
        private Matcher indexed;
        private String[] lower;

        Library(EditText search, Ui.Segmented filter) {
            this.search = search;
            this.filter = filter;
            filter.onPick(v -> { filterValue = v; refresh(); });
        }

        void refresh() {
            rows.clear();
            Matcher m = matcher();
            if (m != null && m != indexed) {
                indexed = m;
                index = new HashMap<>();
                lower = new String[m.ids.length];
                for (int i = 0; i < m.ids.length; i++) { index.put(m.ids[i], i); lower[i] = m.titles[i].toLowerCase(Locale.ROOT); }
            }
            Config c = store.get();
            String q = search.getText().toString().trim().toLowerCase(Locale.ROOT);
            List<String> mine = new ArrayList<>();
            int seen = 0, blocked = 0;
            for (Iterator<String> i = c.works.keys(); i.hasNext(); ) {
                String id = i.next();
                String st = c.state(id);
                if (Config.SEEN.equals(st)) seen++; else blocked++;
                if (!"all".equals(filterValue) && !filterValue.equals(st)) continue;
                if (!q.isEmpty() && !title(id).toLowerCase(Locale.ROOT).contains(q)) continue;
                mine.add(id);
            }
            for (int i = 0; i < c.custom.length(); i++) { // hand-added works without a state yet
                String id = c.custom.optJSONObject(i).optString("id");
                if (!c.works.has(id) && "all".equals(filterValue) && (q.isEmpty() || title(id).toLowerCase(Locale.ROOT).contains(q))) mine.add(id);
            }
            Collections.sort(mine, (a, b) -> title(a).compareToIgnoreCase(title(b)));
            String count = c.works.length() == 1 ? "1 work" : c.works.length() + " works";
            if (q.isEmpty()) rows.add(new Object[]{"section", "Your library · " + count + " (" + seen + " seen, " + blocked + " blocked)"});
            else if (!mine.isEmpty()) rows.add(new Object[]{"section", "In your library"});
            for (String id : mine) rows.add(new Object[]{"work", id});
            if (q.isEmpty() && mine.isEmpty()) rows.add(new Object[]{"empty", c.works.length() == 0
                ? "Nothing here yet. Search above to add a work, or tap “I've seen it” on a cover."
                : "No works with this state."});
            if (q.length() >= 2 && m != null) {
                List<Integer> hits = search(m, q, c);
                rows.add(new Object[]{"section", hits.isEmpty() ? "No title in the catalog matches “" + q + "”. Add it by hand." : "Add from the catalog"});
                for (int i : hits) rows.add(new Object[]{"result", i});
            } else if (q.length() >= 2) {
                rows.add(new Object[]{"empty", "Loading the catalog…"});
            }
            notifyDataSetChanged();
        }

        /** Titles starting with the query first, then word starts, then anywhere; catalog order (most popular first). */
        private List<Integer> search(Matcher m, String q, Config c) {
            List<Integer> a = new ArrayList<>(), b = new ArrayList<>(), d = new ArrayList<>();
            for (int i = 0; i < lower.length && a.size() < 30; i++) {
                int at = lower[i].indexOf(q);
                if (at < 0 || c.works.has(m.ids[i]) || m.ids[i].startsWith("custom:")) continue;
                (at == 0 ? a : !Character.isLetterOrDigit(lower[i].charAt(at - 1)) ? b : d).add(i);
            }
            a.addAll(b);
            a.addAll(d);
            return a.subList(0, Math.min(30, a.size()));
        }

        String title(String id) {
            JSONObject e = store.get().work(id);
            if (e != null && !e.isNull("title")) return e.optString("title");
            JSONArray cu = store.get().custom;
            for (int i = 0; i < cu.length(); i++) if (id.equals(cu.optJSONObject(i).optString("id"))) return cu.optJSONObject(i).optString("title");
            Integer i = index == null ? null : index.get(id);
            return i != null ? indexed.titles[i] : id;
        }

        private String meta(String id) {
            JSONObject e = store.get().work(id);
            String type = e != null && !e.isNull("type") ? e.optString("type") : null;
            int year = e != null && !e.isNull("year") ? e.optInt("year") : 0;
            Integer i = index == null ? null : index.get(id);
            if (type == null && i != null) type = indexed.types[i];
            if (year == 0 && i != null) year = indexed.years[i];
            if (type == null && id.startsWith("custom:")) {
                JSONArray cu = store.get().custom;
                for (int k = 0; k < cu.length(); k++) if (id.equals(cu.optJSONObject(k).optString("id"))) type = cu.optJSONObject(k).optString("type");
            }
            String s = typeLabel(type) + (year > 0 ? " · " + year : "");
            return id.startsWith("custom:") ? (s.isEmpty() ? "" : s + " · ") + "added by hand" : s;
        }

        @Override public int getCount() { return rows.size(); }
        @Override public Object getItem(int i) { return rows.get(i); }
        @Override public long getItemId(int i) { return i; }
        @Override public int getViewTypeCount() { return 1; }
        @Override public boolean isEnabled(int i) { return false; } // rows handle their own taps

        @Override public View getView(int pos, View convert, ViewGroup parent) {
            Object[] r = rows.get(pos);
            String kind = (String) r[0];
            if (kind.equals("section") || kind.equals("empty")) {
                TextView t = Ui.text(SettingsActivity.this, kind.equals("section") ? Ui.LABEL_LARGE : Ui.BODY_MEDIUM, kind.equals("section") ? p.accent : p.muted, kind.equals("section"));
                t.setText((String) r[1]);
                t.setPadding(dp(16), dp(kind.equals("section") ? 20 : 8), dp(16), dp(8));
                if (kind.equals("section")) t.setAccessibilityHeading(true);
                return t;
            }
            return kind.equals("work") ? workRow((String) r[1]) : resultRow((Integer) r[1]);
        }

        private View workRow(String id) {
            Config c = store.get();
            String state = c.state(id);
            LinearLayout row = new LinearLayout(SettingsActivity.this);
            row.setOrientation(LinearLayout.VERTICAL);
            row.setPadding(dp(16), dp(10), dp(16), dp(10));
            boolean open = id.equals(expanded);
            row.setBackground(Ui.ripple(p, open ? Ui.shape(p.surface, 0, 0, 0) : null));
            LinearLayout line = new LinearLayout(SettingsActivity.this);
            line.setGravity(Gravity.CENTER_VERTICAL);
            line.setMinimumHeight(dp(48));
            LinearLayout texts = new LinearLayout(SettingsActivity.this);
            texts.setOrientation(LinearLayout.VERTICAL);
            TextView t = Ui.text(SettingsActivity.this, Ui.BODY_LARGE, p.text, false);
            t.setText(title(id));
            texts.addView(t);
            String meta = meta(id);
            if (!meta.isEmpty()) {
                TextView mt = Ui.text(SettingsActivity.this, Ui.BODY_MEDIUM, p.muted, false);
                mt.setText(meta);
                texts.addView(mt);
            }
            line.addView(texts, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1));
            TextView badge = Ui.text(SettingsActivity.this, Ui.LABEL_LARGE, Config.BLOCKED.equals(state) ? p.onAccentContainer : p.muted, true);
            badge.setText(Config.SEEN.equals(state) ? "Seen" : Config.BLOCKED.equals(state) ? "Blocked" : "Unlisted");
            badge.setPadding(dp(12), dp(4), dp(12), dp(4));
            badge.setBackground(Ui.shape(Config.BLOCKED.equals(state) ? p.accentContainer : 0, p.outline, Config.BLOCKED.equals(state) ? 0 : dp(1), dp(8)));
            line.addView(badge);
            row.addView(line);
            row.setContentDescription(title(id) + ", " + badge.getText() + (meta.isEmpty() ? "" : ", " + meta) + (open ? ", expanded" : ", double-tap to change"));
            row.setOnClickListener(v -> { expanded = open ? null : id; refresh(); });
            if (open) {
                Ui.Segmented st = new Ui.Segmented(SettingsActivity.this, p, new String[]{"Seen", "Blocked"}, new String[]{Config.SEEN, Config.BLOCKED}, "State");
                st.select(state == null ? "" : state);
                st.onPick(v -> store.patch(Config.workPatch(id, withField(id, "state", v))));
                addLabeled(row, "State", st);
                String style = c.work(id) == null || c.work(id).isNull("style") ? "default" : c.work(id).optString("style");
                Ui.Segmented sy = new Ui.Segmented(SettingsActivity.this, p, new String[]{"Default", "Everything", "Spoilers only"},
                    new String[]{"default", Config.ALL, Config.SPOILERS}, "What to cover");
                sy.select(style);
                sy.onPick(v -> store.patch(Config.workPatch(id, withField(id, "style", v.equals("default") ? JSONObject.NULL : v))));
                addLabeled(row, "What to cover", sy);
                TextView remove = Ui.button(SettingsActivity.this, p, id.startsWith("custom:") ? "Delete this work" : "Remove from library", Ui.TEXT);
                remove.setOnClickListener(v -> remove(id));
                LinearLayout.LayoutParams rl = Ui.wrap();
                rl.topMargin = dp(8);
                rl.gravity = Gravity.END;
                row.addView(remove, rl);
            }
            return row;
        }

        private void addLabeled(LinearLayout row, String label, View control) {
            TextView t = Ui.text(SettingsActivity.this, Ui.BODY_MEDIUM, p.muted, false);
            t.setText(label);
            t.setPadding(0, dp(12), 0, dp(6));
            t.setImportantForAccessibility(View.IMPORTANT_FOR_ACCESSIBILITY_NO); // the segments carry it
            row.addView(t);
            row.addView(control, Ui.matchWidth());
        }

        private JSONObject withField(String id, String key, Object value) {
            try {
                JSONObject e = store.get().work(id);
                if (e == null) { // a hand-added work without a state yet
                    e = Config.entry(Config.BLOCKED, null, title(id), null, 0, System.currentTimeMillis());
                }
                return new JSONObject(e.toString()).put(key, value).put("ts", System.currentTimeMillis());
            } catch (org.json.JSONException ex) {
                throw new IllegalStateException(ex);
            }
        }

        private void remove(String id) {
            Config c = store.get();
            JSONObject entry = c.work(id);
            String name = title(id);
            expanded = null;
            if (id.startsWith("custom:")) {
                JSONArray keep = new JSONArray();
                for (int i = 0; i < c.custom.length(); i++) if (!id.equals(c.custom.optJSONObject(i).optString("id"))) keep.put(c.custom.optJSONObject(i));
                try { store.patch(Config.workPatch(id, null).put("custom", keep)); } catch (org.json.JSONException e) { throw new IllegalStateException(e); }
                notice("Deleted " + name);
            } else {
                store.patch(Config.workPatch(id, null));
                notice("Removed " + name + (entry != null && Config.SEEN.equals(entry.optString("state")) ? ". Posts about it are covered again." : "."));
            }
        }

        private View resultRow(int i) {
            Matcher m = indexed;
            LinearLayout row = new LinearLayout(SettingsActivity.this);
            row.setGravity(Gravity.CENTER_VERTICAL);
            row.setPadding(dp(16), dp(6), dp(8), dp(6));
            LinearLayout texts = new LinearLayout(SettingsActivity.this);
            texts.setOrientation(LinearLayout.VERTICAL);
            TextView t = Ui.text(SettingsActivity.this, Ui.BODY_LARGE, p.text, false);
            t.setText(m.titles[i]);
            texts.addView(t);
            TextView mt = Ui.text(SettingsActivity.this, Ui.BODY_MEDIUM, p.muted, false);
            mt.setText(typeLabel(m.types[i]) + (m.years[i] > 0 ? " · " + m.years[i] : ""));
            texts.addView(mt);
            row.addView(texts, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1));
            TextView seen = Ui.button(SettingsActivity.this, p, "Seen", Ui.TONAL);
            seen.setPadding(dp(16), 0, dp(16), 0);
            seen.setContentDescription("Add " + m.titles[i] + " as seen");
            seen.setOnClickListener(v -> add(i, Config.SEEN));
            TextView block = Ui.button(SettingsActivity.this, p, "Block", Ui.OUTLINED);
            block.setPadding(dp(16), 0, dp(16), 0);
            block.setContentDescription("Block " + m.titles[i]);
            block.setOnClickListener(v -> add(i, Config.BLOCKED));
            LinearLayout.LayoutParams bl = Ui.wrap();
            bl.leftMargin = dp(8);
            row.addView(seen, bl);
            LinearLayout.LayoutParams bl2 = Ui.wrap();
            bl2.leftMargin = dp(8);
            row.addView(block, bl2);
            return row;
        }

        private void add(int i, String state) {
            Matcher m = indexed;
            store.patch(Config.workPatch(m.ids[i], Config.entry(state, null, m.titles[i], m.types[i], m.years[i], System.currentTimeMillis())));
            notice((Config.SEEN.equals(state) ? "Marked as seen: " : "Blocked: ") + m.titles[i]);
        }
    }

    // ---------- Add by hand ----------

    private View customTab() {
        LinearLayout l = page();
        heading(l, "Add a work by hand");
        body(l, "For a work the catalog does not have. SpolierBlock looks for its title and other names in posts, in every app.");
        EditText title = field("Title");
        title.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_FLAG_CAP_WORDS);
        l.addView(title, Ui.matchWidth());
        EditText aliases = field("Other names, separated by commas");
        LinearLayout.LayoutParams al = Ui.matchWidth();
        al.topMargin = dp(12);
        l.addView(aliases, al);
        TextView typeLabel = Ui.text(this, Ui.BODY_MEDIUM, p.muted, false);
        typeLabel.setText("Kind of work");
        typeLabel.setPadding(0, dp(16), 0, dp(4));
        l.addView(typeLabel);
        Spinner type = new Spinner(this);
        type.setAdapter(new ArrayAdapter<>(this, android.R.layout.simple_spinner_dropdown_item, TYPE_LABELS));
        type.setMinimumHeight(dp(48));
        type.setContentDescription("Kind of work");
        l.addView(type, Ui.matchWidth());
        TextView stateLabel = Ui.text(this, Ui.BODY_MEDIUM, p.muted, false);
        stateLabel.setText("Cover posts about it?");
        stateLabel.setPadding(0, dp(16), 0, dp(6));
        l.addView(stateLabel);
        Ui.Segmented state = new Ui.Segmented(this, p, new String[]{"Yes, block it", "No, I've seen it"}, new String[]{Config.BLOCKED, Config.SEEN}, "Cover posts about it");
        state.select(Config.BLOCKED);
        l.addView(state, Ui.matchWidth());
        TextView error = Ui.text(this, Ui.BODY_MEDIUM, p.error, false);
        error.setVisibility(View.GONE);
        error.setPadding(0, dp(8), 0, 0);
        l.addView(error);
        String[] picked = {Config.BLOCKED};
        state.onPick(v -> picked[0] = v);
        TextView add = Ui.button(this, p, "Add work", Ui.FILLED);
        LinearLayout.LayoutParams addl = Ui.wrap();
        addl.topMargin = dp(16);
        l.addView(add, addl);
        add.setOnClickListener(v -> {
            String t = title.getText().toString().trim();
            if (t.codePointCount(0, t.length()) < 2) {
                error.setText("Enter a title of at least 2 characters.");
                error.setVisibility(View.VISIBLE);
                title.requestFocus();
                return;
            }
            error.setVisibility(View.GONE);
            try {
                Config c = store.get();
                String id = "custom:" + c.nextCustomId();
                JSONArray names = new JSONArray();
                for (String a : aliases.getText().toString().split(",")) if (!a.trim().isEmpty()) names.put(a.trim());
                String kind = Config.TYPES.get(type.getSelectedItemPosition());
                JSONArray custom = new JSONArray(c.custom.toString()).put(new JSONObject().put("id", id).put("title", t).put("aliases", names).put("type", kind));
                store.patch(Config.workPatch(id, Config.entry(picked[0], null, t, kind, 0, System.currentTimeMillis())).put("custom", custom));
            } catch (org.json.JSONException e) {
                throw new IllegalStateException(e);
            }
            title.setText("");
            aliases.setText("");
            notice("Added " + t + ". It is matched in a few seconds, once the title index is rebuilt.");
        });

        heading(l, "Added by hand");
        LinearLayout list = new LinearLayout(this);
        list.setOrientation(LinearLayout.VERTICAL);
        l.addView(list);
        binders.add(() -> {
            list.removeAllViews();
            JSONArray cu = store.get().custom;
            if (cu.length() == 0) { body(list, "None yet."); return; }
            for (int i = 0; i < cu.length(); i++) {
                JSONObject e = cu.optJSONObject(i);
                String id = e.optString("id");
                LinearLayout row = new LinearLayout(this);
                row.setGravity(Gravity.CENTER_VERTICAL);
                row.setMinimumHeight(dp(56));
                LinearLayout texts = new LinearLayout(this);
                texts.setOrientation(LinearLayout.VERTICAL);
                TextView t = Ui.text(this, Ui.BODY_LARGE, p.text, false);
                t.setText(e.optString("title"));
                texts.addView(t);
                JSONArray a = e.optJSONArray("aliases");
                List<String> names = new ArrayList<>();
                for (int k = 0; a != null && k < a.length(); k++) names.add(a.optString(k));
                String state1 = store.get().state(id);
                TextView mt = Ui.text(this, Ui.BODY_MEDIUM, p.muted, false);
                mt.setText(typeLabel(e.optString("type")) + " · " + (Config.SEEN.equals(state1) ? "seen" : Config.BLOCKED.equals(state1) ? "blocked" : "unlisted")
                    + (names.isEmpty() ? "" : " · also " + TextUtils.join(", ", names)));
                texts.addView(mt);
                row.addView(texts, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1));
                View del = Ui.iconButton(this, p, Ui.Icon.CLOSE, p.muted, "Delete " + e.optString("title"));
                del.setOnClickListener(v -> {
                    JSONArray keep = new JSONArray();
                    JSONArray cur = store.get().custom;
                    for (int k = 0; k < cur.length(); k++) if (!id.equals(cur.optJSONObject(k).optString("id"))) keep.put(cur.optJSONObject(k));
                    try { store.patch(Config.workPatch(id, null).put("custom", keep)); } catch (org.json.JSONException ex) { throw new IllegalStateException(ex); }
                    notice("Deleted " + e.optString("title"));
                });
                row.addView(del);
                list.addView(row);
            }
        });
        return scroll(l);
    }

    // ---------- Blocking ----------

    private View blockingTab() {
        LinearLayout l = page();
        heading(l, "Blocking");
        toggle(l, "enabled", "Block spoilers", "Turn off to see everything. Your library is kept.");
        toggle(l, "blockUnlisted", "Cover works you have not listed",
            "On: anything about a film, show, game or book you have not marked as seen is covered. Off: only the works you block.");
        heading(l, "What to cover");
        body(l, "For works without their own choice in the library.");
        Ui.Segmented style = new Ui.Segmented(this, p, new String[]{"Anything about it", "Only spoilers"}, new String[]{Config.ALL, Config.SPOILERS}, "What to cover");
        style.onPick(v -> store.patch(Config.settingPatch("style", v)));
        binders.add(() -> style.select(store.get().style()));
        l.addView(style, Ui.matchWidth());
        body(l, "“Only spoilers” runs a small model on this device. A post stays covered while it is checked.").setPadding(0, dp(8), 0, dp(8));
        heading(l, "Images");
        toggle(l, "scanImages", "Scan images", "Recognises posters, stills and screenshots, and reads the text in them, on this device.");
        toggle(l, "unknownImages", "Cover unrecognised film, show or game images",
            "Covers an image that looks like a film, show or game but could not be named. Off by default: it also covers many harmless images.");
        return scroll(l);
    }

    // ---------- Data ----------

    private View dataTab() {
        LinearLayout l = page();
        heading(l, "Back up or move your settings");
        body(l, "Saves your library, hand-added works and settings as " + Config.FILE_NAME + ". The SpolierBlock browser extension reads the same file.");
        LinearLayout buttons = new LinearLayout(this);
        TextView export = Ui.button(this, p, "Export", Ui.TONAL);
        export.setOnClickListener(v -> startActivityForResult(new Intent(Intent.ACTION_CREATE_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE)
            .setType("application/json").putExtra(Intent.EXTRA_TITLE, Config.FILE_NAME), EXPORT));
        TextView imp = Ui.button(this, p, "Import", Ui.OUTLINED);
        imp.setOnClickListener(v -> startActivityForResult(new Intent(Intent.ACTION_OPEN_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE)
            .setType("*/*").putExtra(Intent.EXTRA_MIME_TYPES, new String[]{"application/json", "text/plain", "application/octet-stream"}), IMPORT));
        buttons.addView(export);
        LinearLayout.LayoutParams il = Ui.wrap();
        il.leftMargin = dp(8);
        buttons.addView(imp, il);
        l.addView(buttons);

        heading(l, "Catalog updates");
        SpoilerBlock sb = SpoilerBlock.I;
        body(l, sb != null ? "Downloads titles released since this version from Wikidata. Nothing about you is sent."
            : "Each app with SpolierBlock downloads new titles from Wikidata on this schedule. Nothing about you is sent.");
        Ui.Segmented mode = new Ui.Segmented(this, p, new String[]{"Off", "Daily", "Weekly", "Monthly"}, Config.CATALOG_MODES.toArray(new String[0]), "Catalog updates");
        mode.onPick(v -> store.patch(Config.settingPatch("catalogUpdate", v)));
        binders.add(() -> mode.select(store.get().catalogUpdate()));
        l.addView(mode, Ui.matchWidth());
        if (sb != null) {
            TextView status = body(l, sb.catalogStatus());
            status.setPadding(0, dp(12), 0, 0);
            status.setAccessibilityLiveRegion(View.ACCESSIBILITY_LIVE_REGION_POLITE);
            sb.catalogListener = () -> status.setText(sb.catalogStatus());
            TextView now = Ui.button(this, p, "Update now", Ui.TEXT);
            now.setOnClickListener(v -> sb.maybeUpdateCatalog(true));
            l.addView(now, Ui.wrap());
        }

        heading(l, "Reset");
        body(l, "Removes your library, hand-added works and settings" + (store.remote || store.owner ? " in every app that uses the SpolierBlock app." : " in this app."));
        TextView reset = Ui.button(this, p, "Reset everything", Ui.DANGER);
        reset.setOnClickListener(v -> new AlertDialog.Builder(this).setTitle("Reset SpolierBlock?")
            .setMessage("Your library, hand-added works and settings are removed. This cannot be undone. Export first to keep a copy.")
            .setNegativeButton("Cancel", null)
            .setPositiveButton("Reset", (d, w) -> { store.replace(new Config()); notice("Everything was reset."); })
            .show());
        l.addView(reset, Ui.wrap());
        return scroll(l);
    }

    @Override protected void onActivityResult(int request, int result, Intent data) {
        super.onActivityResult(request, result, data);
        if (result != RESULT_OK || data == null || data.getData() == null) return;
        Uri uri = data.getData();
        if (request == EXPORT) {
            try (OutputStream out = getContentResolver().openOutputStream(uri, "wt")) {
                out.write(store.get().export(java.time.Instant.now().truncatedTo(java.time.temporal.ChronoUnit.SECONDS).toString()).getBytes(StandardCharsets.UTF_8));
                notice("Exported " + store.get().works.length() + " works.");
            } catch (Exception e) {
                Log.w(SpoilerBlock.TAG, "export failed", e);
                notice("Could not save the file. Try another place.");
            }
        } else if (request == IMPORT) {
            Config in;
            try (InputStream s = getContentResolver().openInputStream(uri)) {
                byte[] b = CatalogUpdate.readAll(s, 8 << 20);
                in = Config.fromExport(new String(b, StandardCharsets.UTF_8));
            } catch (IllegalArgumentException e) {
                new AlertDialog.Builder(this).setTitle("Cannot import this file").setMessage(e.getMessage()).setPositiveButton("OK", null).show();
                return;
            } catch (Exception e) {
                new AlertDialog.Builder(this).setTitle("Cannot import this file").setMessage("The file could not be read.").setPositiveButton("OK", null).show();
                return;
            }
            askImport(in);
        }
    }

    private void askImport(Config in) {
        CheckBox settingsToo = new CheckBox(this);
        settingsToo.setText("Also use the file's settings");
        settingsToo.setMinHeight(dp(48));
        FrameLayout box = new FrameLayout(this);
        box.setPadding(dp(20), dp(8), dp(20), 0);
        box.addView(settingsToo);
        int n = in.works.length(), k = in.custom.length();
        new AlertDialog.Builder(this).setTitle("Import " + n + (n == 1 ? " work" : " works") + (k > 0 ? " and " + k + " added by hand" : "") + "?")
            .setMessage("Merge keeps your library and adds the file's works; the file wins where both have a work. Replace uses the file only.")
            .setView(box)
            .setNeutralButton("Cancel", null)
            .setNegativeButton("Replace", (d, w) -> { store.replace(in); notice("Replaced with the file's settings."); })
            .setPositiveButton("Merge", (d, w) -> {
                Config c = store.get().copy();
                c.mergeImport(in, settingsToo.isChecked());
                store.replace(c);
                notice("Merged " + n + (n == 1 ? " work." : " works."));
            })
            .show();
    }

    // ---------- About ----------

    private View aboutTab() {
        LinearLayout l = page();
        heading(l, "SpolierBlock " + VERSION);
        body(l, "Covers posts about films, shows, games and books you have not seen yet. Everything runs on this device; the only "
            + "network use is the catalog update, and only when you turn it on.");
        heading(l, "Where your settings live");
        TextView where = body(l, "");
        binders.add(() -> where.setText(store.owner ? "Here, in the SpolierBlock app. YouTube, X and Instagram with SpolierBlock use this library, so a work marked as seen in one is seen in all."
            : store.remote ? "In the SpolierBlock app, shared with every app that has SpolierBlock. A change here applies everywhere."
            : "In this app only. Install the SpolierBlock app to share one library between YouTube, X and Instagram."));
        heading(l, "Image checks");
        body(l, SpoilerBlock.I != null ? SpoilerBlock.I.images.accel.status()
            : "Each app with SpolierBlock checks images itself, on its own device processor; its settings show how.");
        heading(l, "On a cover");
        body(l, "Show once: shows the post until the app restarts.\nI've seen it: adds the work to your library as seen, so nothing about it is covered again.\n⋮: opens these settings.");
        heading(l, "Licence");
        body(l, "Free software under the GNU General Public License, version 3.");
        return scroll(l);
    }
}
