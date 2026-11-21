package dev.spoilerblock;

import android.graphics.Rect;
import android.graphics.Canvas;
import android.graphics.ColorFilter;
import android.graphics.PixelFormat;
import android.graphics.drawable.Drawable;
import android.os.SystemClock;
import android.util.Log;
import android.view.MotionEvent;
import android.view.View;
import android.view.ViewConfiguration;
import android.view.ViewGroup;
import android.view.ViewTreeObserver;
import android.widget.AbsListView;
import android.widget.EditText;
import android.widget.TextView;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Set;
import java.util.List;
import java.util.Map;
import java.util.WeakHashMap;

/**
 * One per activity window. Before every frame (OnPreDrawListener: after layout, before draw) it judges the children
 * of the window's scrolling containers ("feed items") and the clickable cards outside them ("loose" items, activity
 * windows only) whose content changed, and covers matching ones.
 */
final class Scanner implements ViewTreeObserver.OnPreDrawListener, ViewTreeObserver.OnGlobalLayoutListener {
    // Safety net only: re-read a visible item whose fingerprint did not change (custom-drawn content mutated in place).
    // shortcut: up to 1 s of exposure for such in-place changes, hook the specific view type in its app's patch if one needs it.
    private static final long RECHECK_MS = 1000;
    private static final long REDISCOVER_MS = 500;

    final SpoilerBlock sb;
    final View decor;
    private final List<View> containers = new ArrayList<>();
    private final Map<View, Item> items = new WeakHashMap<>();
    final List<Cover> covers = new ArrayList<>();
    private boolean layoutDirty = true;
    private long lastDiscover;
    private final Map<Class<?>, Boolean> listClass = new HashMap<>();
    private final int[] loc = new int[2];
    private final List<View> media = new ArrayList<>();
    private final List<View> loose = new ArrayList<>(); // cards outside every list (an end screen's, an overlay's): items too
    private final List<View> videos = new ArrayList<>(); // the window's video surfaces now (uncoveredVideo)
    // rule 10: per item view, the text (shownKey) it was covered for as a video with no caption, kept while its player
    // comes and goes and across a detach (a list's cached row comes back without a rebind, before its player)
    private final Map<View, String> noCaption = new WeakHashMap<>();
    // stats for logcat
    private long statFrames, statNs, statMaxNs, statReads, statReadNs, statEvals, statEvalNs, statLast = SystemClock.uptimeMillis();

    private static final class Item implements View.OnAttachStateChangeListener {
        long fp; int gen = -1; long at; String text; int[] groups; boolean stale, pending, ownSeenOnly, ownNames, loose; String own; int ownGen = -1;
        // A recycled view is removed and re-added (RecyclerView pool): treat it as unknown, whatever its fingerprint.
        @Override public void onViewAttachedToWindow(View v) { stale = true; }
        @Override public void onViewDetachedFromWindow(View v) { stale = true; }
    }

    final boolean activityWindow; // false: a dialog, popup or drop-down (no TouchGate: covers there have no buttons)

    Scanner(SpoilerBlock sb, View decor, boolean activityWindow) {
        this.sb = sb;
        this.decor = decor;
        this.activityWindow = activityWindow;
        youtube = decor.getContext().getPackageName().contains("youtube");
        iconMax = Ui.dp(decor.getContext(), 64);
        decor.getViewTreeObserver().addOnPreDrawListener(this);
        decor.getViewTreeObserver().addOnGlobalLayoutListener(this);
    }

    void detach() {
        clear();
        sb.silence(this, false);
        decor.getViewTreeObserver().removeOnPreDrawListener(this);
        decor.getViewTreeObserver().removeOnGlobalLayoutListener(this);
    }

    void clear() {
        for (Cover c : new ArrayList<>(covers)) c.remove();
        covers.clear();
        for (Map.Entry<View, Shade> e : shades.entrySet()) e.getKey().getOverlay().remove(e.getValue());
        shades.clear();
        for (View v : new ArrayList<>(pictureShades.keySet())) unshade(v);
        items.clear();
        noCaption.clear();
    }

    // ---------- pictures still being judged (as the extension dims unjudged media) ----------

    private final Map<View, android.graphics.drawable.ColorDrawable> pictureShades = new WeakHashMap<>();

    /**
     * A picture whose verdict is not in yet (or could not be had: fail closed) is painted over with an opaque shade in
     * its own overlay: no text, no buttons, no size change, and the post's text stays readable. Only a verdict covers
     * the post. The item's pictures that need no shade any more lose theirs.
     */
    private void shadePictures(View item, List<View> now) {
        for (View v : new ArrayList<>(pictureShades.keySet())) if (!now.contains(v) && inside(v, item)) unshade(v);
        for (View v : now) {
            android.graphics.drawable.ColorDrawable d = pictureShades.get(v);
            boolean inParent = v instanceof android.view.TextureView && v.getParent() instanceof ViewGroup;
            if (d == null) {
                pictureShades.put(v, d = new android.graphics.drawable.ColorDrawable(Ui.on(v).shade));
                // a TextureView draws only its layer, never its overlay: its shade goes in the parent's, over it
                (inParent ? ((ViewGroup) v.getParent()).getOverlay() : v.getOverlay()).add(d);
            }
            if (inParent) d.setBounds(v.getLeft(), v.getTop(), v.getRight(), v.getBottom());
            else d.setBounds(0, 0, v.getWidth(), v.getHeight());
        }
    }

    private static boolean inside(View v, View item) {
        for (Object p = v; p instanceof View; p = ((View) p).getParent()) if (p == item) return true;
        return false;
    }

    private void unshade(View v) {
        android.graphics.drawable.ColorDrawable d = pictureShades.remove(v);
        if (d == null) return;
        v.getOverlay().remove(d);
        if (v.getParent() instanceof ViewGroup) ((ViewGroup) v.getParent()).getOverlay().remove(d);
    }

    @Override public void onGlobalLayout() { layoutDirty = true; }

    @Override public boolean onPreDraw() {
        if (SpoilerBlock.dead) return true;
        try {
            long t0 = System.nanoTime();
            scan();
            long dt = System.nanoTime() - t0;
            statFrames++; statNs += dt; statMaxNs = Math.max(statMaxNs, dt);
            long now = SystemClock.uptimeMillis();
            if (now - statLast > 10_000 && statFrames > 0) {
                Log.i(SpoilerBlock.TAG, "scan " + decor.getContext().getClass().getSimpleName() + ": " + statFrames + " frames, avg " +
                    statNs / statFrames / 1000 + " us, max " + statMaxNs / 1000 + " us, " + statReads + " item reads (avg " +
                    (statReads > 0 ? statReadNs / statReads / 1000 : 0) + " us), " + statEvals + " matcher runs (avg " +
                    (statEvals > 0 ? statEvalNs / statEvals / 1000 : 0) + " us), " +
                    containers.size() + " containers, " + covers.size() + " covered" + sb.images.stats());
                statFrames = statNs = statMaxNs = statReads = statReadNs = statEvals = statEvalNs = 0; statLast = now;
            }
        } catch (Throwable t) {
            SpoilerBlock.fail("scan", t);
        }
        return true;
    }

    android.view.Window window; // an activity window's, for its TouchGate

    /** Puts a TouchGate on top of the window's callback when something else (the app) wrapped it since. */
    void gate() {
        if (window != null && !(window.getCallback() instanceof TouchGate)) window.setCallback(new TouchGate(window.getCallback(), this));
    }

    private void scan() {
        // a popup opened by what changed in this frame (typing -> suggestions) is found before its own first traversal
        if (activityWindow) { sb.checkWindows(); gate(); }
        if (!sb.enabled) { if (!covers.isEmpty()) clear(); sb.silence(this, false); return; }
        long now = SystemClock.uptimeMillis();
        if (layoutDirty || now - lastDiscover > REDISCOVER_MS) {
            layoutDirty = false; lastDiscover = now;
            containers.clear(); loose.clear();
            discover(decor, activityWindow);
        }
        Matcher m = sb.matcher;
        sb.images.capturedThisFrame = false;
        videosFresh = false;
        // index of the containers list grows while we read items: nested lists found inside items are judged too
        for (int ci = 0; ci < containers.size(); ci++) {
            View c = containers.get(ci);
            if (!c.isAttachedToWindow() || !c.isShown()) continue;
            ViewGroup g = itemParent((ViewGroup) c);
            for (int i = 0; i < g.getChildCount(); i++) {
                View it = g.getChildAt(i);
                if (it.getVisibility() != View.VISIBLE || it.getWidth() == 0) continue;
                if (m == null && (m = sb.awaitMatcher()) == null) return;
                judge(it, g, m, now, false);
            }
        }
        for (View it : loose) {
            if (!it.isAttachedToWindow() || !it.isShown() || it.getWidth() == 0 || !(it.getParent() instanceof ViewGroup)) continue;
            if (m == null && (m = sb.awaitMatcher()) == null) return;
            judge(it, (ViewGroup) it.getParent(), m, now, true);
        }
        // a dialog or popup without a list (a message preview, a bottom sheet): its whole content is one item
        if (!activityWindow && containers.isEmpty() && decor instanceof ViewGroup && ((ViewGroup) decor).getChildCount() > 0) {
            View it = ((ViewGroup) decor).getChildAt(0);
            if (it.getVisibility() == View.VISIBLE && it.getWidth() > 0 && (m != null || (m = sb.awaitMatcher()) != null)) judge(it, (ViewGroup) decor, m, now, false);
        }
        // covers whose item left its list (removed, recycled into the scrap) or stopped being a loose card go; a re-attached item is judged again
        for (int i = covers.size() - 1; i >= 0; i--) {
            Cover cv = covers.get(i);
            Item st = items.get(cv.item);
            if (!cv.item.isAttachedToWindow() || st != null && st.loose && !loose.contains(cv.item)) { cv.remove(); covers.remove(i); items.remove(cv.item); }
            else cv.sync();
        }
        shadeFloaters();
        sb.silence(this, hidesSound());
        if (activityWindow && coldLog) coldStart(now);
    }

    // ---------- cold start timings, once per process (logcat) ----------

    private static boolean coldLog = true;
    private long firstFrame, firstShade;

    private void coldStart(long now) {
        long start = android.os.Process.getStartUptimeMillis();
        if (firstFrame == 0) firstFrame = now;
        if (!pictureShades.isEmpty()) { if (firstShade == 0) firstShade = now; }
        else if (firstShade > 0) {
            coldLog = false;
            Log.i(SpoilerBlock.TAG, "cold start: first frame " + (firstFrame - start) + " ms after process start, first picture shaded " +
                (firstShade - start) + " ms, every picture on screen judged " + (now - start) + " ms" + sb.images.coldStats(start));
        }
    }

    /**
     * Whether something covered here can be playing: a cover over most of the window (a full-screen pager page:
     * Reels, Shorts, stories) or over a video surface (a feed's inline player, inside the item or floating over it),
     * unless a player no cover hides is on screen too: then that one is what plays (the video the user chose, next to a
     * covered post) and its sound stays on.
     */
    private boolean hidesSound() {
        long window = (long) decor.getWidth() * decor.getHeight();
        boolean hides = false;
        for (Cover c : covers) {
            if (c.pill || !c.item.isShown()) continue; // a pill shows the item: its video is the user's
            if ((long) c.item.getWidth() * c.item.getHeight() * 10 >= window * 6 || hasVideo(c.item)) { hides = true; break; }
        }
        if (!hides) for (Map.Entry<View, Shade> e : shades.entrySet()) if (!e.getValue().pill() && e.getKey().isShown() && hasVideo(e.getKey())) { hides = true; break; }
        return hides && !uncoveredVideo();
    }

    /**
     * A video surface at least half visible on screen that is not inside a covered item or a shaded floater and does
     * not lie (>= 90 %) under the visible part of a cover (a pager's player kept behind its pages).
     * shortcut: a covered and an uncovered player both on screen leave the sound on, track which player plays to do better.
     */
    private boolean uncoveredVideo() {
        Rect r = new Rect();
        // found afresh: a page swiped in is attached during the scroll, with no layout pass to trigger discover (only
        // walked while a cover would mute, so its cost is paid on screens with a covered video or full-screen page)
        videos.clear();
        surfaces(decor);
        for (View v : videos) {
            if (!v.isAttachedToWindow() || !visibleOnScreen(v, r) || (long) r.width() * r.height() * 2 < (long) v.getWidth() * v.getHeight()) continue;
            boolean hidden = false;
            for (Object p = v; p instanceof View && !hidden; p = ((View) p).getParent()) {
                Shade sh = shades.get(p);
                Cover cp = coverOf((View) p);
                hidden = sh != null && !sh.pill() || cp != null && !cp.pill;
            }
            long va = (long) r.width() * r.height();
            for (int k = 0; k < coverRects.size() && !hidden; k++) {
                if (rectCovers.get(k).pill) continue;
                Rect in = new Rect(r);
                hidden = in.intersect(coverRects.get(k)) && (long) in.width() * in.height() * 10 >= va * 9;
            }
            if (!hidden) return true;
        }
        return false;
    }

    private void surfaces(View v) {
        if (v.getVisibility() != View.VISIBLE) return;
        if (v instanceof android.view.TextureView || v instanceof android.view.SurfaceView) videos.add(v);
        else if (v instanceof ViewGroup) for (int i = 0; i < ((ViewGroup) v).getChildCount(); i++) surfaces(((ViewGroup) v).getChildAt(i));
    }

    private static boolean hasVideo(View v) {
        if (v.getVisibility() != View.VISIBLE || v.getWidth() == 0) return false;
        if (v instanceof android.view.TextureView || v instanceof android.view.SurfaceView) return true;
        if (v instanceof ViewGroup) {
            ViewGroup g = (ViewGroup) v;
            for (int i = 0; i < g.getChildCount(); i++) if (hasVideo(g.getChildAt(i))) return true;
        }
        return false;
    }

    // ---------- views floating over covered items (e.g. YouTube's inline player and its controls) ----------

    private final Map<View, Shade> shades = new HashMap<>();
    private final List<Rect> coverRects = new ArrayList<>(); // the visible part of each covered item, on screen
    private final List<int[]> coverOrigins = new ArrayList<>(); // where each covered item starts, on screen
    private final List<Cover> rectCovers = new ArrayList<>();
    private final Set<View> shaded = new HashSet<>();
    private final Set<View> coverChains = new HashSet<>(); // covered items and their ancestors

    /**
     * Where an item is visible on screen: its bounds clipped by its list and every other ancestor (a row scrolled under
     * a pinned player above the list is not visible there). False when no part of it is.
     */
    private boolean visibleOnScreen(View v, Rect out) {
        if (!v.isShown() || !v.getGlobalVisibleRect(out)) return false;
        decor.getLocationOnScreen(loc);
        out.offset(loc[0], loc[1]);
        return true;
    }

    /**
     * A view outside the lists that lies (>= 90 %) over the visible part of a covered item and is about its size (40 to
     * 110 %) is drawn over the cover by the app: the item's own video preview and its controls. It gets an opaque
     * shade too. A view over the part of the item its list does not show (the watch page's player, pinned above the
     * related list while a row scrolls under it) is not the item's and is left alone.
     */
    private void shadeFloaters() {
        coverRects.clear();
        coverOrigins.clear();
        rectCovers.clear();
        for (Cover c : covers) {
            Rect vis = new Rect();
            if (!visibleOnScreen(c.item, vis)) continue;
            c.item.getLocationOnScreen(loc);
            coverRects.add(vis);
            coverOrigins.add(new int[]{loc[0], loc[1]});
            rectCovers.add(c);
        }
        shaded.clear();
        coverChains.clear(); // a loose card and its parents are not floaters over it
        for (Cover c : rectCovers) for (Object p = c.item; p instanceof View; p = ((View) p).getParent()) coverChains.add((View) p);
        if (!coverRects.isEmpty()) floaters(decor);
        for (java.util.Iterator<Map.Entry<View, Shade>> i = shades.entrySet().iterator(); i.hasNext(); ) {
            Map.Entry<View, Shade> e = i.next();
            if (!shaded.contains(e.getKey())) { e.getKey().getOverlay().remove(e.getValue()); i.remove(); }
        }
    }

    private void floaters(View v) {
        if (v.getVisibility() != View.VISIBLE || containers.contains(v) || coverOf(v) != null) return; // items are covered themselves
        long area = (long) v.getWidth() * v.getHeight();
        for (int k = 0; k < coverRects.size() && !coverChains.contains(v); k++) {
            Rect r = coverRects.get(k);
            View item = rectCovers.get(k).item;
            long ra = (long) item.getWidth() * item.getHeight();
            if (area < ra * 4 / 10 || area > ra * 11 / 10) continue;
            Rect in = new Rect();
            if (!visibleOnScreen(v, in)) continue;
            long va = (long) in.width() * in.height();
            v.getLocationOnScreen(loc);
            if (in.intersect(r) && (long) in.width() * in.height() * 10 >= va * 9) {
                Shade d = shades.get(v);
                if (d == null) {
                    shades.put(v, d = new Shade(v));
                    v.getOverlay().add(d);
                    if (Log.isLoggable(SpoilerBlock.TAG, Log.DEBUG)) Log.d(SpoilerBlock.TAG, "shade floating " + v.getClass().getName());
                }
                d.setBounds(0, 0, v.getWidth(), v.getHeight());
                d.update(rectCovers.get(k), loc[0] - coverOrigins.get(k)[0], loc[1] - coverOrigins.get(k)[1]);
                shaded.add(v);
                return;
            }
        }
        if (v instanceof ViewGroup) {
            ViewGroup g = (ViewGroup) v;
            for (int i = 0; i < g.getChildCount(); i++) floaters(g.getChildAt(i));
        }
    }

    private static final Map<Class<?>, Boolean> scrollViews = new HashMap<>();

    /**
     * A ScrollView-like container holds one child whose children are the items. A list or pager showing one page (a
     * full-screen pager at rest: Reels, Shorts) holds one child too, but that child is the item itself.
     */
    private static ViewGroup itemParent(ViewGroup c) {
        Boolean sv = scrollViews.get(c.getClass());
        if (sv == null) {
            sv = false;
            for (Class<?> k = c.getClass(); k != null && k != ViewGroup.class && !sv; k = k.getSuperclass()) sv = k.getName().endsWith("ScrollView");
            scrollViews.put(c.getClass(), sv);
        }
        if (!sv) return c;
        for (int d = 0; d < 3 && c.getChildCount() == 1 && c.getChildAt(0) instanceof ViewGroup; d++) c = (ViewGroup) c.getChildAt(0);
        return c;
    }

    /** Lists and (with outside: not in a list or a loose card yet) loose cards. */
    private void discover(View v, boolean outside) {
        if (v.getVisibility() != View.VISIBLE) return;
        if (outside && looseItem(v)) { loose.add(v); outside = false; }
        if (!(v instanceof ViewGroup)) return;
        ViewGroup g = (ViewGroup) v;
        if (isList(g)) { containers.add(g); outside = false; }
        for (int i = 0; i < g.getChildCount(); i++) discover(g.getChildAt(i), outside);
    }

    /**
     * A card outside every list (a player's end screen, an "up next" card, an overlay): a clickable view that is not an
     * icon button or a TextView, at most half the window, and holds no video surface (so never the player itself) and
     * no list (a panel: its cards are looked for inside).
     * Its text decides like a list item's, if it has at least LOOSE_WORDS words (see judge).
     */
    private boolean looseItem(View v) {
        // a TextView alone is a label, a button or a search box's query (YouTube's results bar), never a card
        if (!v.isClickable() || v.getWidth() == 0 || v instanceof TextView || iconButton(v)) return false;
        return (long) v.getWidth() * v.getHeight() * 2 <= (long) decor.getWidth() * decor.getHeight() && !panel(v);
    }

    private boolean panel(View v) {
        if (v.getVisibility() != View.VISIBLE) return false;
        if (v instanceof android.view.TextureView || v instanceof android.view.SurfaceView) return true;
        if (!(v instanceof ViewGroup)) return false;
        ViewGroup g = (ViewGroup) v;
        if (isList(g)) return true;
        for (int i = 0; i < g.getChildCount(); i++) if (panel(g.getChildAt(i))) return true;
        return false;
    }

    // A loose card's text needs this many words: a bar button's or a tab's label ("Home", "Subscriptions") is never one.
    private static final int LOOSE_WORDS = 3;

    /** Whitespace-separated words that hold a letter: digits, times and punctuation alone are no words. */
    static int words(String s) {
        int n = 0;
        boolean letter = false;
        for (int i = 0; i <= s.length(); i++) {
            char ch = i < s.length() ? s.charAt(i) : ' ';
            if (Character.isWhitespace(ch)) { if (letter) n++; letter = false; }
            else letter |= Character.isLetter(ch);
        }
        return n;
    }

    boolean isList(ViewGroup g) {
        if (g.getChildCount() == 0) return false;
        if (g instanceof AbsListView || g.canScrollVertically(1) || g.canScrollVertically(-1) || g.canScrollHorizontally(1) || g.canScrollHorizontally(-1)) return true;
        // a list that currently fits on screen does not scroll: recognise it by name (not obfuscated in most apps)
        Boolean b = listClass.get(g.getClass());
        if (b == null) {
            b = false;
            for (Class<?> k = g.getClass(); k != null && k != ViewGroup.class && !b; k = k.getSuperclass()) {
                String n = k.getName();
                b = n.endsWith("RecyclerView") || n.endsWith("ViewPager") || n.endsWith("ViewPager2") || n.endsWith("ScrollView");
            }
            listClass.put(g.getClass(), b);
        }
        return b;
    }

    private void judge(View it, ViewGroup parent, Matcher m, long now, boolean loose) {
        Item st = items.get(it);
        if (st == null) { items.put(it, st = new Item()); it.addOnAttachStateChangeListener(st); }
        st.loose = loose;
        long fp = fingerprint(it, 17);
        if (!st.stale && !st.pending && st.gen == sb.generation && st.fp == fp && now - st.at < RECHECK_MS) return;
        long r0 = System.nanoTime();
        TextCapture.Texts texts = new TextCapture.Texts();
        Cover paused = coverOf(it); // the real text, not the cover's accessibility nodes
        if (paused != null) paused.a11yPause(true);
        channel = null;
        try { collect(it, texts, true); } finally { if (paused != null) paused.a11yPause(false); }
        // the app's text cannot pose as text read from pictures or as an uploader
        String text = texts.sb.toString().replace('\u0001', ' ').replace('\u0002', ' ');
        // rule 9: a YouTube video row's channel follows the own text, behind one U+0002 (the uploader names no work)
        String typed = channel == null ? text : text + '\u0002' + channel;
        // rule 11: the item's "Not this" keys: the source is the YouTube channel, or the author's @handle on X (and the demo)
        String[] where = Config.where(sb.site, channel != null ? channel : "x.com".equals(sb.site) || "demo.test".equals(sb.site) ? texts.handle : null);
        if (loose && words(text) < LOOSE_WORDS) { // a button or a label, not a card: never covered, nor its pictures judged
            st.fp = fp; st.gen = sb.generation; st.at = now; st.text = null; st.stale = st.pending = false;
            Cover cv = coverOf(it);
            if (cv != null) { cv.remove(); covers.remove(cv); }
            return;
        }
        // media views: their verdicts (requested here when missing) and the text OCR found in them
        media.clear();
        if (sb.imagesMatter()) sb.images.candidates(it, this, media, true);
        Config.Works v = sb.worksFor(m);
        // rule 7: what the post's own text names decides how much its pictures may say
        if (media.isEmpty()) st.ownSeenOnly = st.ownNames = false;
        else if (st.ownGen != sb.generation || !typed.equals(st.own)) { ownNames(m, text, typed, v, st, where); st.own = typed; st.ownGen = sb.generation; }
        boolean pending = false, unknown = false;
        List<Integer> imgGroups = new ArrayList<>();
        StringBuilder ocr = new StringBuilder(), key = new StringBuilder(typed);
        List<View> toShade = new ArrayList<>();
        for (View mv : media) {
            Images.State s = sb.images.state(mv);
            if (!Images.isVideo(mv)) key.append('\u0000').append(s.key); // a player's key changes with every sampled frame
            if (!s.done) { pending = true; toShade.add(mv); continue; }
            if (s.failed) { toShade.add(mv); continue; } // fail closed: the picture stays shaded
            // rule 7: the image model speaks only for a picture no text identifies
            if (!st.ownNames && !ocrNames(m, s)) for (double[] h : s.hits) { // the first hit not seen, as the extension takes it
                int g = (int) h[0];
                if (g == Clip.UNKNOWN) { unknown = true; break; }
                if (Config.notHere(m.groupWorks(g), v, where)) continue; // rule 11: never matched here
                if (!m.groupSeen(g, v.seen)) {
                    if (Config.group(m.groupWorks(g), v, sb.blockUnlisted) != Config.NOT_COVERED && !imgGroups.contains(g)) imgGroups.add(g);
                    break;
                }
            }
            if (!s.ocr.isEmpty()) ocr.append('\n').append(s.ocr);
        }
        // rule 8: text read from pictures goes after the post's own text, behind one U+0001 (the matcher reads it more strictly)
        String full = ocr.length() == 0 ? typed : typed + '\u0001' + ocr.substring(Math.max(1, ocr.length() - 4000));
        statReads++;
        statReadNs += System.nanoTime() - r0;
        if (st.gen != sb.generation || !full.equals(st.text)) {
            long e0 = System.nanoTime();
            List<int[]> unsure = new ArrayList<>();
            int[] rules = m.evaluate(full, v.seen, unsure);
            // a name the matcher is unsure about counts once the model says yes, after the rules' groups; until its
            // answer is in, the item is not covered for it (the answer re-judges every item)
            List<Integer> yes = sb.contextGroups(m, text, unsure, true);
            st.groups = java.util.Arrays.copyOf(rules, rules.length + yes.size());
            for (int i = 0; i < yes.size(); i++) st.groups[rules.length + i] = yes.get(i);
            statEvals++; statEvalNs += System.nanoTime() - e0;
            if (Log.isLoggable(SpoilerBlock.TAG, Log.VERBOSE)) { // what the matcher was given and what it found (adb shell setprop log.tag.SpoilerBlock VERBOSE)
                StringBuilder gs = new StringBuilder();
                for (int g : st.groups) gs.append(gs.length() > 0 ? ", " : "").append(m.labels[g]);
                Log.v(SpoilerBlock.TAG, "evaluate " + it.getClass().getName() + " groups=[" + gs + "] text=" + full.replace("\n", "\\n").replace("\u0001", "<U+0001>").replace("\u0002", "<U+0002>"));
            }
        }
        // rule 7: own text naming a seen work and no covered one outranks the pictures (their titles and their OCR names)
        int[] groups = st.ownSeenOnly ? new int[0] : st.groups;
        if (v.anyNot) { // rule 11: a group every work of which the user said "Not this" to here was never matched
            int n = 0;
            int[] kept = new int[groups.length];
            for (int g : groups) if (!Config.notHere(m.groupWorks(g), v, where)) kept[n++] = g;
            groups = java.util.Arrays.copyOf(kept, n);
        }
        st.fp = fp; st.gen = sb.generation; st.at = now; st.text = full; st.stale = false; st.pending = pending; // a pending image is asked again next frame

        // the contract's decision rule: which groups cover, and why (its cover wording)
        // rule 7's label order: text groups as the matcher returns them (own text before OCR, longer names first), then image titles
        List<Integer> all = new ArrayList<>(), spoilers = new ArrayList<>(), textGroups = new ArrayList<>();
        for (int g : groups) {
            int k = Config.group(m.groupWorks(g), v, sb.blockUnlisted);
            if (k == Config.STYLE_ALL) all.add(g); else if (k == Config.STYLE_SPOILERS) spoilers.add(g);
            if (k != Config.NOT_COVERED) textGroups.add(g);
        }
        if (st.ownSeenOnly) imgGroups.clear();
        String msg = null;
        List<Integer> named = new ArrayList<>();
        if (!all.isEmpty()) { msg = "Mentions "; named.addAll(textGroups); }
        else if (!imgGroups.isEmpty()) { msg = "Image from "; named.addAll(imgGroups); named.addAll(spoilers); }
        else if (!spoilers.isEmpty()) {
            Boolean spoiler = sb.spoilerVerdict(full.replace('\u0001', '\n').replace('\u0002', '\n'));
            if (spoiler == null) msg = "Checking ";
            else if (spoiler) msg = "Spoiler about ";
            if (msg != null) named.addAll(spoilers);
        }
        if (msg != null) for (int g : imgGroups) if (!named.contains(g)) named.add(g);
        String label = null;
        if (msg != null) {
            label = m.labels[named.get(0)] + (named.size() > 1 ? " and " + (named.size() - 1) + " more" : "");
            msg = msg.equals("Checking ") ? "Checking " + label + " for spoilers…" : msg + label;
        } else if (unknown && Config.coverUnknownImage(sb.unknownImages, st.ownSeenOnly, !all.isEmpty() || !spoilers.isEmpty())) {
            msg = "Possible film, show or game image";
        }
        // rule 10, lowest: on a listed site, a video item whose text has no run of 4+ words and names no work, seen or not
        if (msg == null && sb.captionless && texts.maxWords < 4) {
            String k = shownKey(typed, ""); // counters tick: the post stays the same
            if (hasVideo(it) || floatingVideo(it)) noCaption.put(it, k);
            if (k.equals(noCaption.get(it)) && !(media.isEmpty() ? namesWork(m, text, typed, v, where) : st.ownNames)) msg = "Video with no caption";
        }
        shadePictures(it, msg == null ? toShade : new ArrayList<>()); // pending pictures are shaded, not the whole post
        String reveal = shownKey(text, key); // "Show once" is for this post, whatever its counters, players and pictures do next
        Cover cv = coverOf(it);
        boolean shown = msg != null && sb.revealed.contains(reveal);
        boolean block = msg != null && !shown;
        boolean pill = shown && label != null; // shown once from a cover that names works: the pill stays (contract, cover wording)
        boolean log = Log.isLoggable(SpoilerBlock.TAG, Log.DEBUG);
        if (block || pill) {
            if (cv == null) { covers.add(cv = new Cover(this, it, parent)); if (!activityWindow) catcher(); }
            int[] marks = new int[label != null ? named.size() : 0];
            for (int i = 0; i < marks.length; i++) marks[i] = named.get(i);
            cv.notKey = where.length > 0 ? where[0] : null;
            if (cv.show(msg, marks, reveal, pill) && log) {
                Log.d(SpoilerBlock.TAG, (pill ? "pill \"" : "block \"") + msg + "\" " + (st.loose ? "loose " : "") + it.getClass().getName() + "@" + Integer.toHexString(System.identityHashCode(it)) + " text=" + full.replace('\n', '|'));
            }
        } else if (cv != null) {
            cv.remove();
            covers.remove(cv);
            if (log) Log.d(SpoilerBlock.TAG, "unblock " + it.getClass().getName() + "@" + Integer.toHexString(System.identityHashCode(it)));
        }
    }

    /**
     * The key "Show once" remembers a post by: its own text (never the text read from its pictures) with numbers blanked
     * and spaces collapsed, so ticking counters, a playing video, pictures that finish loading, late verdicts and a rebind
     * to another view leave it shown. A post without words is known by its pictures instead.
     */
    static String shownKey(String own, CharSequence media) {
        String k = own.replaceAll("\\d[\\d.,:]*", "#").replaceAll("\\s+", " ").trim();
        for (int i = 0; i < k.length(); i++) if (Character.isLetter(k.charAt(i))) return k;
        return "\u0000" + media;
    }

    /** Rule 10 when no picture made judge ask ownNames: whether the own text names any work, seen or not. */
    private boolean namesWork(Matcher m, String text, String typed, Config.Works v, String[] where) {
        List<int[]> unsure = new ArrayList<>();
        for (int g : m.evaluate(typed, noneSeen(m), unsure)) if (!Config.notHere(m.groupWorks(g), v, where)) return true;
        for (int g : sb.contextGroups(m, text, unsure, false)) if (!Config.notHere(m.groupWorks(g), v, where)) return true;
        return false;
    }

    private boolean videosFresh; // videos holds this frame's surfaces (floatingVideo)

    /**
     * Rule 10: a video surface outside the item that lies (>= 90 %) over its visible part and is at least 40 % of its
     * size: the app's shared player floating over the row (YouTube's inline preview), as shadeFloaters sees it.
     */
    private boolean floatingVideo(View it) {
        Rect ri = new Rect(), rv = new Rect();
        if (!visibleOnScreen(it, ri)) return false;
        if (!videosFresh) { videos.clear(); surfaces(decor); videosFresh = true; }
        long ia = (long) it.getWidth() * it.getHeight();
        for (View v : videos) {
            if (inside(v, it) || (long) v.getWidth() * v.getHeight() * 10 < ia * 4 || !visibleOnScreen(v, rv)) continue;
            long va = (long) rv.width() * rv.height();
            if (rv.intersect(ri) && (long) rv.width() * rv.height() * 10 >= va * 9) return true;
        }
        return false;
    }

    private boolean[] noneSeen; // for rules 6 and 7's "names a work", seen or not

    private boolean[] noneSeen(Matcher m) {
        if (noneSeen == null || noneSeen.length != m.ids.length) noneSeen = new boolean[m.ids.length];
        return noneSeen;
    }

    /**
     * Rules 6 and 7 on the post's own text: whether it names any work, and whether it names a work the user has seen and
     * no covered one (the matcher drops seen groups, so it is asked without them).
     */
    private void ownNames(Matcher m, String text, String typed, Config.Works v, Item st, String[] where) {
        boolean seen = false, covered = false;
        List<int[]> unsure = new ArrayList<>();
        List<Integer> gs = new ArrayList<>();
        for (int g : m.evaluate(typed, noneSeen(m), unsure)) gs.add(g);
        gs.addAll(sb.contextGroups(m, text, unsure, false)); // a model's yes names a work too (asked by judge, never for a seen group)
        gs.removeIf(g -> Config.notHere(m.groupWorks(g), v, where)); // rule 11
        for (int g : gs) {
            if (m.groupSeen(g, v.seen)) seen = true;
            else if (Config.group(m.groupWorks(g), v, sb.blockUnlisted) != Config.NOT_COVERED) covered = true;
        }
        st.ownNames = !gs.isEmpty();
        st.ownSeenOnly = seen && !covered;
    }

    /** Rule 7: whether a picture's own text (OCR, read as text after the U+0001 marker) names any work. */
    private boolean ocrNames(Matcher m, Images.State s) {
        if (s.ocr.isEmpty()) return false;
        if (s.namesFor != m) { s.ocrNames = m.evaluate('\u0001' + s.ocr, noneSeen(m)).length > 0; s.namesFor = m; }
        return s.ocrNames;
    }

    private Catcher catcher;

    /**
     * Dialogs and popups have no window callback of ours (it is the Dialog's or the PopupWindow's), so their covers'
     * buttons get their taps from a transparent view on top of the window's content, added with the first cover. It
     * takes a touch that starts on a cover (the content under a cover is not for tapping) and lets every other through.
     */
    private void catcher() {
        if (catcher != null || !(decor instanceof ViewGroup)) return;
        catcher = new Catcher(decor.getContext());
        ((ViewGroup) decor).addView(catcher, new ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
    }

    private final class Catcher extends View {
        private Cover down;

        Catcher(android.content.Context c) {
            super(c);
            setImportantForAccessibility(IMPORTANT_FOR_ACCESSIBILITY_NO);
            setWillNotDraw(true);
        }

        @Override public boolean onTouchEvent(MotionEvent ev) {
            if (SpoilerBlock.dead) return false;
            try {
                int a = ev.getActionMasked();
                if (a == MotionEvent.ACTION_DOWN) return (down = coverAt(ev.getRawX(), ev.getRawY())) != null;
                if (down == null) return false;
                if (a == MotionEvent.ACTION_UP) down.tap(ev.getRawX(), ev.getRawY());
                if (a == MotionEvent.ACTION_UP || a == MotionEvent.ACTION_CANCEL) down = null;
                return true;
            } catch (Throwable t) {
                SpoilerBlock.fail("popup touch", t);
                return false;
            }
        }
    }

    private Cover coverOf(View it) {
        for (Cover c : covers) if (c.item == it) return c;
        return null;
    }

    /** Cheap per-frame change detector: identities of the views, their texts and descriptions, and sizes. */
    private long fingerprint(View v, long h) {
        if (v.getVisibility() != View.VISIBLE) return h * 31 + 7;
        h = h * 31 + System.identityHashCode(v);
        h = h * 31 + v.getWidth() * 8191L + v.getHeight();
        h = h * 31 + System.identityHashCode(v.getContentDescription());
        if (v instanceof TextView) h = h * 31 + System.identityHashCode(((TextView) v).getText());
        else if (v instanceof android.widget.ImageView || Images.isVideo(v)) h = h * 31 + Images.key(v); // a new picture is judged before it is drawn
        else h = h * 31 + System.identityHashCode(SpoilerBlock.hookedText.get(v));
        if (v instanceof ViewGroup && !containers.contains(v)) { // nested lists are judged item by item
            ViewGroup g = (ViewGroup) v;
            for (int i = 0; i < g.getChildCount(); i++) h = fingerprint(g.getChildAt(i), h);
        }
        return h;
    }

    private final boolean youtube; // row descriptions carry a metadata tail (YouTubeText)
    private String channel; // the uploader of the item being collected (a YouTube video row's channel), or null
    private final int iconMax;

    /**
     * A small tappable icon's description is its button label ("Go to channel X", "Action menu", "Like"), in any
     * language: never the post's content.
     */
    private boolean iconButton(View v) {
        return v.isClickable() && v instanceof android.widget.ImageView && v.getWidth() <= iconMax && v.getHeight() <= iconMax;
    }

    /** Visible text of an item: TextView text, content descriptions and the accessibility (virtual view) tree. */
    private void collect(View v, TextCapture.Texts out, boolean root) {
        if (v.getVisibility() != View.VISIBLE) return;
        if (!root && v instanceof ViewGroup && isList((ViewGroup) v)) { // a nested list's children are items of their own
            if (!containers.contains(v)) containers.add(v);
            return;
        }
        CharSequence cd = v.getContentDescription();
        if (cd != null && !iconButton(v)) {
            if (!youtube) out.add(cd);
            else { // a video row: "title - channel", and its channel is the uploader (the first one found)
                out.add(YouTubeText.strip(cd.toString()));
                if (channel == null) channel = YouTubeText.channel(cd.toString());
            }
        }
        if (v instanceof TextView && !(v instanceof EditText)) { // the user's own typing is not a spoiler
            CharSequence t = ((TextView) v).getText();
            out.add(t);
        }
        CharSequence hooked = SpoilerBlock.hookedText.get(v);
        out.add(hooked);
        if (v.getAccessibilityNodeProvider() != null) {
            try {
                v.onProvideVirtualStructure(new TextCapture(out));
            } catch (RuntimeException e) { // a host provider that cannot answer outside accessibility: skip that view
                Log.w(SpoilerBlock.TAG, "virtual text of " + v.getClass().getName() + ": " + e);
            }
        }
        if (v instanceof ViewGroup) {
            ViewGroup g = (ViewGroup) v;
            for (int i = 0; i < g.getChildCount(); i++) collect(g.getChildAt(i), out, false);
        }
    }

    // ---------- touches (called by TouchGate before the app sees them) ----------

    private Cover target;
    private float downX, downY;
    private boolean appCancelled;
    private final Runnable preventLongPress = () -> {
        if (target != null && !appCancelled) { cancelApp(); appCancelled = true; }
    };
    private TouchGate gate;

    /**
     * A touch on a cover goes to the app as long as it may become a scroll (so lists still scroll from a covered
     * item); if it ends as a tap the app gets a CANCEL instead and the tap is ours. Returns true to swallow.
     */
    boolean onTouch(TouchGate g, MotionEvent ev) {
        gate = g;
        int a = ev.getActionMasked();
        if (a == MotionEvent.ACTION_DOWN) {
            target = coverAt(ev.getRawX(), ev.getRawY());
            downX = ev.getRawX(); downY = ev.getRawY(); appCancelled = false;
            if (target != null) sb.main.postDelayed(preventLongPress, ViewConfiguration.getLongPressTimeout() / 2);
            return false;
        }
        if (target == null) return false;
        if (appCancelled) { // the app already got its CANCEL: the rest of this gesture is ours
            // shortcut: a press held past half the long-press timeout can no longer turn into a scroll, re-inject a DOWN if that annoys
            if (a == MotionEvent.ACTION_UP) target.tap(ev.getRawX(), ev.getRawY());
            if (a == MotionEvent.ACTION_UP || a == MotionEvent.ACTION_CANCEL) target = null;
            return true;
        }
        int slop = ViewConfiguration.get(decor.getContext()).getScaledTouchSlop();
        if (a == MotionEvent.ACTION_MOVE && Math.hypot(ev.getRawX() - downX, ev.getRawY() - downY) > slop
            || a == MotionEvent.ACTION_POINTER_DOWN || a == MotionEvent.ACTION_CANCEL) {
            sb.main.removeCallbacks(preventLongPress);
            target = null; // a scroll or a pinch: the app's gesture
            return false;
        }
        if (a == MotionEvent.ACTION_UP) {
            sb.main.removeCallbacks(preventLongPress);
            Cover t = target;
            target = null;
            cancelApp();
            t.tap(ev.getRawX(), ev.getRawY());
            return true;
        }
        return false;
    }

    private void cancelApp() {
        long now = SystemClock.uptimeMillis();
        MotionEvent c = MotionEvent.obtain(now, now, MotionEvent.ACTION_CANCEL, downX, downY, 0);
        int[] d = new int[2];
        decor.getLocationOnScreen(d);
        c.setLocation(downX - d[0], downY - d[1]);
        gate.toApp(c);
        c.recycle();
    }

    /** The cover under a touch: only where its item is visible (never over a pinned player or a bar above its list). */
    private Cover coverAt(float x, float y) {
        Rect vis = new Rect();
        for (int i = covers.size() - 1; i >= 0; i--) {
            Cover c = covers.get(i);
            if (!visibleOnScreen(c.item, vis) || !vis.contains((int) x, (int) y)) continue;
            if (c.pill && !c.pillOnScreen().contains((int) x, (int) y)) continue; // a pill takes taps only on itself
            return appOnTop(c.item, (int) x, (int) y) ? null : c;
        }
        return null;
    }

    /**
     * Something clickable the app draws over the item at this point (X's bottom bar and compose button float over the
     * list): the touch is the app's. Our own shaded floaters carry the cover's buttons and do not count.
     */
    private boolean appOnTop(View item, int x, int y) {
        for (View child = item; child.getParent() instanceof ViewGroup; child = (View) child.getParent()) {
            ViewGroup p = (ViewGroup) child.getParent();
            int at = p.indexOfChild(child);
            for (int i = 0; i < p.getChildCount(); i++) {
                View s = p.getChildAt(i);
                // drawn (and touched) above: raised, or at the same Z and added later; a later sibling with a lower Z is under it
                // shortcut: ignores a custom drawing order (getChildDrawingOrder is not public), upgrade if a host uses one over a list
                float sz = s.getZ(), cz = child.getZ();
                if (s != child && (sz > cz || sz == cz && i > at) && clickableAt(s, x, y)) return true;
            }
        }
        return false;
    }

    private boolean clickableAt(View v, int x, int y) {
        Rect r = new Rect();
        if (shades.containsKey(v) || !visibleOnScreen(v, r) || !r.contains(x, y)) return false;
        if (v.isClickable()) return true;
        if (v instanceof ViewGroup) {
            ViewGroup g = (ViewGroup) v;
            for (int i = 0; i < g.getChildCount(); i++) if (clickableAt(g.getChildAt(i), x, y)) return true;
        }
        return false;
    }

    /** Rule 11, "Not this": recorded for the cover's works on this item's key; the cover goes at once. */
    void notThis(Cover c, int[] marks) {
        sb.notThis(marks, c.notKey);
        c.remove();
        covers.remove(c);
    }

    /** "Show once": the post is remembered as shown; a cover that names works becomes its pill, any other goes. */
    void revealOnce(Cover c) {
        sb.revealed.add(c.text);
        if (c.names()) c.pill(true);
        else { c.remove(); covers.remove(c); }
        Log.i(SpoilerBlock.TAG, "shown once");
    }

    /** The pill's "Cover again": the post is no longer shown once; the cover is back at once and the item judged again. */
    void coverAgain(Cover c) {
        sb.revealed.remove(c.text);
        c.pill(false);
        Item st = items.get(c.item);
        if (st != null) st.stale = true;
        Log.i(SpoilerBlock.TAG, "covered again");
    }

    /**
     * Opaque shade over a floating view, repeating the part of the item's cover underneath (so its buttons stay visible);
     * over a pill item's floater, just the pill.
     */
    private static final class Shade extends Drawable {
        private final View host;
        private Cover cover;
        private int dx, dy; // host position relative to the covered item
        private boolean wasPill;

        Shade(View host) { this.host = host; }

        void update(Cover c, int dx, int dy) {
            if (c != cover || dx != this.dx || dy != this.dy || c.pill != wasPill) { cover = c; this.dx = dx; this.dy = dy; wasPill = c.pill; invalidateSelf(); host.invalidate(); }
        }

        /** Over a pill item's floater only the pill is drawn: the floater (its player) stays visible. */
        boolean pill() { return cover != null && cover.pill; }

        @Override public void draw(Canvas canvas) {
            if (cover == null) { canvas.drawColor(0xFF111111); return; }
            if (!cover.pill) canvas.drawColor(cover.palette.cover);
            canvas.save();
            canvas.translate(-dx, -dy);
            cover.drawInto(canvas);
            canvas.restore();
        }
        @Override public void setAlpha(int a) { }
        @Override public void setColorFilter(ColorFilter f) { }
        @Override public int getOpacity() { return pill() ? PixelFormat.TRANSLUCENT : PixelFormat.OPAQUE; }
    }
}
