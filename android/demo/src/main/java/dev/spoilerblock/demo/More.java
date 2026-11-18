package dev.spoilerblock.demo;

import android.app.Dialog;
import android.graphics.drawable.GradientDrawable;
import android.text.Editable;
import android.text.TextWatcher;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.widget.ArrayAdapter;
import android.widget.Button;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.ListPopupWindow;
import android.widget.TextView;

import androidx.recyclerview.widget.LinearLayoutManager;
import androidx.recyclerview.widget.RecyclerView;

import java.util.ArrayList;
import java.util.List;

/**
 * The places a spoiler reaches outside a feed: a direct-message conversation (bubbles in a list), a bottom sheet (a
 * dialog window: not the activity's window) and search suggestions (a popup window over the activity). Every frame
 * any of them draws is checked like the feed: each post covered iff expected.
 */
final class More {
    // a conversation: post indices of MainActivity.POSTS, alternating sides
    static final int[] DM = {5, 0, 7, 2, 11, 18, 1, 16, 13, 6, 15, 8};
    static final int SHEET_POST = 2; // "Snape kills Dumbledore ..."

    static View build(MainActivity a) {
        LinearLayout l = new LinearLayout(a);
        l.setOrientation(LinearLayout.VERTICAL);
        l.setBackgroundColor(0xFFFFFFFF);
        LinearLayout bar = new LinearLayout(a);
        bar.setPadding(a.dp(8), a.dp(8), a.dp(8), a.dp(8));
        EditText search = new EditText(a);
        search.setHint("Search");
        search.setSingleLine(true);
        bar.addView(search, new LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1));
        Button sheet = new Button(a);
        sheet.setText("Open sheet");
        sheet.setOnClickListener(v -> openSheet(a));
        bar.addView(sheet);
        l.addView(bar);

        RecyclerView dm = new MainActivity.FeedList(a);
        dm.setLayoutManager(new LinearLayoutManager(a));
        dm.setAdapter(new RecyclerView.Adapter<RecyclerView.ViewHolder>() {
            @Override public int getItemCount() { return DM.length * 3; }
            @Override public RecyclerView.ViewHolder onCreateViewHolder(ViewGroup parent, int type) {
                FrameLayout row = new FrameLayout(a);
                row.setLayoutParams(new RecyclerView.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));
                row.setPadding(a.dp(12), a.dp(6), a.dp(12), a.dp(6));
                TextView bubble = new TextView(a);
                bubble.setTextSize(16);
                bubble.setPadding(a.dp(14), a.dp(10), a.dp(14), a.dp(10));
                row.addView(bubble, new FrameLayout.LayoutParams(ViewGroup.LayoutParams.WRAP_CONTENT, ViewGroup.LayoutParams.WRAP_CONTENT));
                return new RecyclerView.ViewHolder(row) { };
            }
            @Override public void onBindViewHolder(RecyclerView.ViewHolder h, int pos) {
                int post = DM[pos % DM.length];
                boolean mine = pos % 2 == 1;
                FrameLayout row = (FrameLayout) h.itemView;
                row.setTag(post);
                TextView bubble = (TextView) row.getChildAt(0);
                bubble.setText(MainActivity.body(post));
                GradientDrawable bg = new GradientDrawable();
                bg.setColor(mine ? 0xFF1D9BF0 : 0xFFEFF3F4);
                bg.setCornerRadius(a.dp(18));
                bubble.setBackground(bg);
                bubble.setTextColor(mine ? 0xFFFFFFFF : 0xFF0F1419);
                ((FrameLayout.LayoutParams) bubble.getLayoutParams()).gravity = mine ? Gravity.END : Gravity.START;
                bubble.setMaxWidth(a.dp(280));
            }
        });
        l.addView(dm, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1));
        dm.getViewTreeObserver().addOnDrawListener(() -> { MainActivity.frames++; a.checkChildren(dm); });

        // suggestions: a ListPopupWindow under the field, as AutoCompleteTextView and search boxes show them
        ListPopupWindow popup = new ListPopupWindow(a);
        List<Integer> shown = new ArrayList<>();
        ArrayAdapter<Integer> adapter = new ArrayAdapter<Integer>(a, android.R.layout.simple_list_item_1, shown) {
            @Override public View getView(int i, View convert, ViewGroup parent) {
                TextView t = (TextView) super.getView(i, convert, parent);
                t.setText(MainActivity.body(shown.get(i)));
                t.setTag(shown.get(i));
                return t;
            }
        };
        popup.setAdapter(adapter);
        popup.setAnchorView(search);
        popup.setModal(false);
        popup.setInputMethodMode(ListPopupWindow.INPUT_METHOD_NEEDED);
        search.addTextChangedListener(new TextWatcher() {
            @Override public void beforeTextChanged(CharSequence s, int x, int y, int z) { }
            @Override public void onTextChanged(CharSequence s, int x, int y, int z) { }
            @Override public void afterTextChanged(Editable e) {
                String q = e.toString().toLowerCase(java.util.Locale.ROOT).trim();
                shown.clear();
                if (!q.isEmpty()) for (int i = 0; i < MainActivity.POSTS.length; i++)
                    if (MainActivity.POSTS[i][1] != null && MainActivity.body(i).toLowerCase(java.util.Locale.ROOT).contains(q)) shown.add(i);
                adapter.notifyDataSetChanged();
                if (shown.isEmpty()) { popup.dismiss(); return; }
                if (!popup.isShowing()) {
                    popup.show();
                    popup.getListView().getViewTreeObserver().addOnDrawListener(() -> {
                        android.widget.ListView lv = popup.getListView();
                        if (lv == null) return;
                        for (int i = 0; i < lv.getChildCount(); i++) {
                            Object tag = lv.getChildAt(i).getTag();
                            if (tag instanceof Integer) MainActivity.checkOne(lv.getChildAt(i), (Integer) tag, "suggestion");
                        }
                    });
                }
            }
        });
        return l;
    }

    /** A bottom sheet: a dialog window of its own holding one message, no list. */
    static void openSheet(MainActivity a) {
        Dialog d = new Dialog(a);
        LinearLayout box = new LinearLayout(a);
        box.setOrientation(LinearLayout.VERTICAL);
        box.setPadding(a.dp(24), a.dp(20), a.dp(24), a.dp(28));
        box.setBackgroundColor(0xFFFFFFFF);
        TextView from = new TextView(a);
        from.setText("Message from @deniz");
        from.setTextColor(0xFF666666);
        box.addView(from);
        TextView body = new TextView(a);
        body.setTextSize(18);
        body.setText(MainActivity.body(SHEET_POST));
        box.addView(body);
        d.setContentView(box);
        d.getWindow().setGravity(Gravity.BOTTOM);
        d.getWindow().setLayout(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT);
        box.getViewTreeObserver().addOnDrawListener(() -> { MainActivity.frames++; MainActivity.checkOne(body, SHEET_POST, "sheet"); });
        d.show();
    }
}
