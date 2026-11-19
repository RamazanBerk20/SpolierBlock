package dev.spoilerblock.demo;

import android.app.Activity;
import android.content.Context;
import android.os.Bundle;
import android.util.Log;
import android.util.TypedValue;
import android.view.View;
import android.view.ViewGroup;
import android.view.ViewTreeObserver;
import android.widget.LinearLayout;
import android.widget.TextView;

import androidx.recyclerview.widget.LinearLayoutManager;
import androidx.recyclerview.widget.RecyclerView;

/**
 * Feed of 240 items mixing plain TextViews, canvas-drawn text exposed only through contentDescription, canvas-drawn
 * text exposed only through an AccessibilityNodeProvider (like Litho / Compose), canvas-drawn text exposed nowhere
 * (like X's TextContentView: only the patch's setter hook sees it), clean posts, ambiguous titles with
 * and without context, and a nested horizontal shelf. Knows which posts the blocker must cover and checks it on
 * every drawn frame (OnDrawListener runs after the blocker's OnPreDrawListener, right before the frame is drawn).
 */
public class MainActivity extends Activity {
    static final String TAG = "SBDemo";
    // body, must be covered (expected values from the browser extension's JS matcher on the shipped index)
    static final Object[][] POSTS = {
        {"Breaking Bad season 5 finale was insane", true},
        {"Had a lovely walk in the park with my dog today.", false},
        {"Snape kills Dumbledore at the end of the sixth book.", true},
        {"I lost my keys again", false},                                  // ambiguous "Lost", no context
        {"Lost season 6 was a mess", true},                               // ambiguous "Lost" + context
        {"Coffee and rain, perfect morning", false},
        {"The Last of Us finale was brutal", true},
        {"Pick me up at 5", false},                                       // ambiguous "Up", no context
        {"Darth Vader is Luke's father, what a twist", true},
        {"It was a great movie", false},                                  // ambiguous "It", sentence start
        {"I watched It last night and the movie was terrifying", true},   // ambiguous "It" + context
        {"New phone arrived, battery life is great", false},
        {"Have you seen \"Up\"? Best opening ever", true},                // ambiguous "Up", quoted
        {"Lunch: lentil soup again", false},
        {"Who else is rewatching Stranger Things before season 5?", true},
        {"Morning run done, 10k", false},
        {"Elden Ring boss fights are brutal", true},
        {"Marley and Me went for a walk", false},                         // everyday-word title, no corroboration
        {"Just finished Dune, the ending wow", true},
        {"The Witcher 3 is still the best game", true},
        {"GTA 6 leak shows the ending", true},                            // sequel number + short form -> Grand Theft Auto VI
        {"Zorblax Chronicles finale was wild", null},                     // invented work: covered only after a catalog update
    };
    static final String[] AUTHORS = {"@anna_k", "@deniz", "@moviebuff", "@gamer42", "@reader"};
    static final int N = 240, TEXT = 0, CANVAS_DESC = 1, CANVAS_A11Y = 2, CANVAS_HOOK = 3, SHELF = 4, IMAGE = 5, VIDEO = 6, QUOTE = 7;
    // image posts (test/fixtures/images): file, caption. Expected: titled Night of the Living Dead, shown, Harry Potter
    // (OCR of the caption in the picture), shown, "unrecognised" media. Not frame-checked (pending until verdicts are in).
    static final String[][] IMAGES = {
        {"pos_notld_poster.jpg", "Saw this at the vintage cinema last night"},
        {"clean_dog.jpg", "Look who's home"},
        {"ocr_spoiler_snape.png", "lol this meme"},
        {"ocr_clean_coffee.png", "Monday mood"},
        {"pos_nosferatu.jpg", "Throwback Thursday"},
    };
    static long frames, checks, mismatches, blockerLayouts, blockerDraws;

    /**
     * True when the blocker (dev.spoilerblock.*, not this demo) made this call: the first caller below the overriding
     * method that is not framework code. The blocker must never lay out or draw host views. (It is further down the
     * stack of every touch, since its TouchGate hands touches to the app: that is the app's own work.)
     */
    static boolean fromBlocker(String what, View v) {
        StackTraceElement[] st = new Throwable().getStackTrace();
        for (int i = 2; i < st.length; i++) { // 0: this method, 1: the override
            String c = st[i].getClassName();
            if (c.startsWith("android.") || c.startsWith("java.") || c.startsWith("com.android.") || c.startsWith("dalvik.")) continue;
            if (!c.startsWith("dev.spoilerblock.") || c.startsWith("dev.spoilerblock.demo.")) return false;
            Log.e(TAG, "BLOCKER " + what + " on " + v.getClass().getName() + " via " + c + "." + st[i].getMethodName(), new Throwable());
            return true;
        }
        return false;
    }

    /** A feed row that reports any layout request coming from the blocker (a cover must never change an item's size). */
    static class Row extends LinearLayout {
        Row(Context c) { super(c); }
        @Override public void requestLayout() { if (fromBlocker("requestLayout", this)) blockerLayouts++; super.requestLayout(); }
    }

    /** Media view: the blocker may read its drawable but must never draw the view itself (its RenderNodes are the app's). */
    static class Media extends android.widget.ImageView {
        Media(Context c) { super(c); }
        @Override public void draw(android.graphics.Canvas c) { if (fromBlocker("draw", this)) blockerDraws++; super.draw(c); }
        @Override public void requestLayout() { if (fromBlocker("requestLayout", this)) blockerLayouts++; super.requestLayout(); }
    }

    static class FeedList extends RecyclerView {
        FeedList(Context c) { super(c); }
        @Override public void requestLayout() { if (fromBlocker("requestLayout", this)) blockerLayouts++; super.requestLayout(); }
    }
    static final java.util.Set<Integer> revealed = new java.util.HashSet<>(); // posts the tester revealed / marked seen

    static int type(int pos) { return pos % 25 == 24 ? SHELF : pos % 25 == 12 ? VIDEO : pos % 25 >= 2 && pos % 25 <= 6 ? IMAGE : pos % 25 == 18 ? QUOTE : pos % 4; }
    static String body(int post) { return (String) POSTS[post][0]; }
    static Boolean expected(int post) { return POSTS[post][1] == null ? null : (Boolean) POSTS[post][1] && !revealed.contains(post); }

    RecyclerView list;

    @Override protected void onCreate(Bundle b) {
        super.onCreate(b);
        watchShown = getIntent().getIntExtra("watchShown", -1);
        String reveal = getIntent().getStringExtra("revealed"); // posts the test marked seen / showed: "8,12"
        if (reveal != null) for (String s : reveal.split(",")) if (!s.isEmpty()) revealed.add(Integer.parseInt(s));
        if ("more".equals(getIntent().getStringExtra("screen"))) { // messages, a bottom sheet, suggestions: More.java
            setContentView(More.build(this));
            return;
        }
        if ("reels".equals(getIntent().getStringExtra("screen"))) { setContentView(Reels.build(this)); return; }
        if ("watch".equals(getIntent().getStringExtra("screen"))) { setContentView(Watch.build(this)); return; } // a pinned player over a list
        if ("settings".equals(getIntent().getStringExtra("screen"))) { startActivity(new android.content.Intent(this, DemoSettings.class)); finish(); return; }
        list = new FeedList(this);
        list.setLayoutManager(new LinearLayoutManager(this));
        list.setAdapter(new Feed());
        setContentView(list);
        list.getViewTreeObserver().addOnDrawListener(this::check);
        int at = getIntent().getIntExtra("pos", -1); // the test starts at a given row (players: 12 covered, 37 clean)
        if (at >= 0) ((LinearLayoutManager) list.getLayoutManager()).scrollToPositionWithOffset(at, 300);
        if (getIntent().getBooleanExtra("spoilerEval", false)) SpoilerEval.run(this);
        if (getIntent().getBooleanExtra("imageEval", false)) ImageEval.run(this);
    }

    @Override protected void onPause() {
        super.onPause();
        if (Watch.playerTaps > 0 || Watch.playerShades > 0) Log.i(TAG, "watch: " + Watch.playerTaps + " taps reached the player, " + Watch.playerShades + " shades on it");
        Log.i(TAG, "frame check summary: " + frames + " frames, " + checks + " item checks, " + mismatches + " mismatches, " +
            blockerLayouts + " blocker layouts, " + blockerDraws + " blocker draws; audio: " + Sound.checks + " checks, " + Sound.mismatches + " mismatches");
    }

    /** Every drawn frame: each visible post is covered iff expected (the blocker hides covered items from a11y). */
    void check() {
        frames++;
        if (list != null) checkChildren(list);
        if (list != null) Sound.check(list, "feed");
        if (frames % 600 == 0) Log.i(TAG, "frame check: " + frames + " frames, " + checks + " item checks, " + mismatches + " mismatches");
    }

    void checkChildren(RecyclerView rv) {
        for (int i = 0; i < rv.getChildCount(); i++) {
            View v = rv.getChildAt(i);
            Object tag = v.getTag();
            if (tag instanceof RecyclerView) { checkChildren((RecyclerView) tag); continue; }
            // a clean picture post is never covered, not even while its picture is being judged (only the picture is shaded)
            if (("image clean_dog.jpg".equals(tag) || "image ocr_clean_coffee.png".equals(tag)) && v.getBottom() > 0 && v.getTop() < rv.getHeight()) {
                checks++;
                if (covered(v)) { mismatches++; Log.e(TAG, "MISMATCH frame " + frames + " " + tag + " covered"); }
                continue;
            }
            if (!(tag instanceof Integer) || v.getBottom() <= 0 || v.getTop() >= rv.getHeight()) continue;
            int post = (Integer) tag;
            boolean covered = covered(v);
            checks++;
            if (post == watchShown && v instanceof ViewGroup && ((ViewGroup) v).getChildAt(((ViewGroup) v).getChildCount() - 1) instanceof Counter) {
                // the player row: "Show once" holds through counters, frames, late verdicts and rebinds
                if (!covered && !watchedOpen) { watchedOpen = true; Log.i(TAG, "watched post " + post + " shown at frame " + frames); }
                else if (covered && watchedOpen) { mismatches++; Log.e(TAG, "MISMATCH frame " + frames + " post " + post + " covered again after Show once"); }
                continue;
            }
            if (expected(post) == null) continue; // depends on the catalog update, checked by screenshots instead
            if (covered != expected(post)) {
                mismatches++;
                Log.e(TAG, "MISMATCH frame " + frames + " post " + post + " covered=" + covered + " \"" + body(post) + "\"");
            }
        }
    }

    /**
     * Covered, as accessibility sees it: the blocker gives a covered item its own node provider (the cover's message
     * and buttons instead of the content), or, where it cannot, hides the item's subtree.
     */
    static boolean covered(View v) {
        if (v.getImportantForAccessibility() == View.IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS) return true;
        android.view.accessibility.AccessibilityNodeProvider p = v.getAccessibilityNodeProvider();
        return p != null && p.getClass().getName().startsWith("dev.spoilerblock.") && !p.getClass().getName().startsWith("dev.spoilerblock.demo.");
    }

    /** One post shown outside a list (a dialog's text, a suggestion row): covered iff expected, checked on every frame drawn. */
    static void checkOne(View v, int post, String where) {
        boolean covered = false;
        for (View x = v; x != null; x = x.getParent() instanceof View ? (View) x.getParent() : null)
            covered |= covered(x);
        checks++;
        if (expected(post) != null && covered != expected(post)) {
            mismatches++;
            Log.e(TAG, "MISMATCH " + where + " frame " + frames + " post " + post + " covered=" + covered + " \"" + body(post) + "\"");
        }
    }

    int dp(int v) { return (int) TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, v, getResources().getDisplayMetrics()); }

    LinearLayout card(Context c) {
        LinearLayout l = new Row(c);
        l.setOrientation(LinearLayout.VERTICAL);
        l.setPadding(dp(16), dp(12), dp(16), dp(12));
        l.setBackgroundColor(0xFFFFFFFF);
        l.setLayoutParams(new RecyclerView.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));
        return l;
    }

    class Feed extends RecyclerView.Adapter<RecyclerView.ViewHolder> {
        @Override public int getItemCount() { return N; }
        @Override public int getItemViewType(int pos) { return type(pos); }

        @Override public RecyclerView.ViewHolder onCreateViewHolder(ViewGroup parent, int type) {
            LinearLayout l = card(parent.getContext());
            if (type == SHELF) {
                TextView h = new TextView(parent.getContext());
                h.setText("Recommended for you");
                l.addView(h);
                RecyclerView shelf = new RecyclerView(parent.getContext());
                shelf.setLayoutManager(new LinearLayoutManager(parent.getContext(), RecyclerView.HORIZONTAL, false));
                shelf.setAdapter(new Shelf());
                l.addView(shelf);
                l.setTag(shelf);
            } else if (type == VIDEO) { // an inline player: a TextureView fed every frame, like X's autoplay
                TextView caption = new TextView(parent.getContext());
                caption.setTextSize(17);
                l.addView(caption);
                l.addView(new Video(parent.getContext()), new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(200)));
                l.addView(new Counter(parent.getContext())); // like counts ticking under the post, as on X
            } else if (type == IMAGE) {
                TextView caption = new TextView(parent.getContext());
                caption.setTextSize(17);
                l.addView(caption);
                android.widget.ImageView img = new Media(parent.getContext());
                img.setAdjustViewBounds(true); // the view is the picture, as in most feeds
                // a rounded background, like real feeds' media frames: drawing the view would share its RenderNode
                android.graphics.drawable.GradientDrawable frame = new android.graphics.drawable.GradientDrawable();
                frame.setColor(0xFFCCCCCC);
                frame.setCornerRadius(dp(12));
                img.setBackground(frame);
                img.setMaxHeight(dp(360));
                l.addView(img, new LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT));
            } else if (type == QUOTE) { // a clean post of one's own quoting another (X's QuoteView): only the quote can cover
                TextView author = new TextView(parent.getContext());
                author.setTextColor(0xFF666666);
                l.addView(author);
                TextView own = new TextView(parent.getContext());
                own.setTextSize(17);
                own.setText("Can't believe this one");
                l.addView(own);
                l.addView(new QuoteBox(parent.getContext()));
            } else {
                TextView author = new TextView(parent.getContext());
                author.setTextColor(0xFF666666);
                l.addView(author);
                View text = type == TEXT ? new TextView(parent.getContext()) : new DrawnText(parent.getContext(), type);
                if (text instanceof TextView) ((TextView) text).setTextSize(17);
                l.addView(text);
            }
            l.setOnClickListener(v -> Log.i(TAG, "CLICK reached app: post " + v.getTag()));
            return new RecyclerView.ViewHolder(l) { };
        }

        @Override public void onBindViewHolder(RecyclerView.ViewHolder h, int pos) {
            if (type(pos) == VIDEO) { // every other player has a clean caption: its sound must be heard
                int post = (pos / 25) % 2 == 0 ? VIDEO_POST : 1;
                h.itemView.setTag(post);
                ((TextView) ((LinearLayout) h.itemView).getChildAt(0)).setText(body(post));
                return;
            }
            if (type(pos) == IMAGE) { bindImage((LinearLayout) h.itemView, (pos % 25 - 2) % IMAGES.length); return; }
            if (type(pos) == SHELF) { ((RecyclerView) h.itemView.getTag()).scrollToPosition(0); ((Shelf) ((RecyclerView) h.itemView.getTag()).getAdapter()).at(pos); return; }
            int post = pos % POSTS.length;
            LinearLayout l = (LinearLayout) h.itemView;
            l.setTag(post);
            ((TextView) l.getChildAt(0)).setText(AUTHORS[pos % AUTHORS.length]);
            if (type(pos) == QUOTE) { ((QuoteBox) l.getChildAt(2)).quote(body(post)); return; }
            View t = l.getChildAt(1);
            if (t instanceof TextView) ((TextView) t).setText(body(post)); else ((DrawnText) t).setText(body(post));
        }
    }

    static final int VIDEO_POST = 16; // "Elden Ring boss fights are brutal": covered by its caption

    /** A like counter that ticks every 300 ms: the post's text changes while the post stays the same. */
    static class Counter extends TextView implements Runnable {
        int n = 100;
        Counter(Context c) { super(c); setText("♥ 100"); }
        @Override protected void onAttachedToWindow() { super.onAttachedToWindow(); postDelayed(this, 300); }
        @Override protected void onDetachedFromWindow() { removeCallbacks(this); super.onDetachedFromWindow(); }
        @Override public void run() { setText("♥ " + (++n)); postDelayed(this, 300); }
    }

    // --ei watchShown N: post N's player row is shown once by the test; from the first frame it is seen uncovered it must stay so
    static int watchShown = -1;
    static boolean watchedOpen;

    /**
     * Frames drawn into a TextureView's surface while attached: video content no ImageView capture can reach. With
     * sound (a looping AudioTrack, the API ExoPlayer plays through) when attached to the feed.
     */
    static class Video extends android.view.TextureView implements Runnable {
        int n;
        final boolean sound;
        android.media.AudioTrack track;
        Video(Context c) { this(c, true); }
        Video(Context c, boolean sound) { super(c); this.sound = sound; }
        @Override protected void onAttachedToWindow() {
            super.onAttachedToWindow();
            post(this);
            if (sound) { track = Sound.tone(); track.play(); }
        }
        @Override protected void onDetachedFromWindow() {
            removeCallbacks(this);
            if (track != null) { track.release(); track = null; }
            super.onDetachedFromWindow();
        }
        @Override public void run() {
            android.graphics.Canvas c = isAvailable() ? lockCanvas() : null;
            if (c != null) {
                c.drawColor(android.graphics.Color.HSVToColor(new float[]{(n++ * 3) % 360, 0.6f, 0.7f}));
                unlockCanvasAndPost(c);
            }
            postDelayed(this, 33);
        }
    }

    final java.util.Map<String, android.graphics.Bitmap> bitmaps = new java.util.HashMap<>();

    /** Like a real feed: a placeholder first, the (hardware) bitmap a moment later, as an image loader sets it. */
    void bindImage(LinearLayout l, int k) {
        l.setTag("image " + IMAGES[k][0]);
        ((TextView) l.getChildAt(0)).setText(IMAGES[k][1]);
        android.widget.ImageView img = (android.widget.ImageView) l.getChildAt(1);
        img.setImageDrawable(new android.graphics.drawable.ColorDrawable(0xFFDDDDDD));
        img.setTag(IMAGES[k][0]);
        img.postDelayed(() -> {
            if (!IMAGES[k][0].equals(img.getTag())) return; // rebound meanwhile
            android.graphics.Bitmap b = bitmaps.get(IMAGES[k][0]);
            if (b == null) {
                try (java.io.InputStream in = getAssets().open("images/" + IMAGES[k][0])) {
                    android.graphics.BitmapFactory.Options o = new android.graphics.BitmapFactory.Options();
                    o.inPreferredConfig = android.graphics.Bitmap.Config.HARDWARE;
                    b = android.graphics.BitmapFactory.decodeStream(in, null, o);
                    bitmaps.put(IMAGES[k][0], b);
                } catch (java.io.IOException e) { throw new RuntimeException(e); }
            }
            img.setImageBitmap(b);
        }, 300);
    }

    class Shelf extends RecyclerView.Adapter<RecyclerView.ViewHolder> {
        int base;
        void at(int pos) { base = pos; notifyDataSetChanged(); }
        @Override public int getItemCount() { return 6; }
        @Override public RecyclerView.ViewHolder onCreateViewHolder(ViewGroup parent, int type) {
            LinearLayout l = card(parent.getContext());
            l.setLayoutParams(new RecyclerView.LayoutParams(dp(220), dp(110)));
            l.setBackgroundColor(0xFFEFEFEF);
            l.addView(new TextView(parent.getContext()));
            l.setOnClickListener(v -> Log.i(TAG, "CLICK reached app: shelf post " + v.getTag()));
            return new RecyclerView.ViewHolder(l) { };
        }
        @Override public void onBindViewHolder(RecyclerView.ViewHolder h, int i) {
            int post = (base + i * 7) % POSTS.length;
            h.itemView.setTag(post);
            ((TextView) ((LinearLayout) h.itemView).getChildAt(0)).setText(body(post));
        }
    }

}
