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
 * of the window's scrolling containers ("feed items") whose content changed, and covers matching ones.
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
    // stats for logcat
    private long statFrames, statNs, statMaxNs, statReads, statReadNs, statEvals, statEvalNs, statLast = SystemClock.uptimeMillis();

    private static final class Item implements View.OnAttachStateChangeListener {
        long fp; int gen = -1; long at; String text; int[] groups; boolean stale, pending, ownSeenOnly, ownNames; String own; int ownGen = -1;
        // A recycled view is removed and re-added (RecyclerView pool): treat it as unknown, whatever its fingerprint.
        @Override public void onViewAttachedToWindow(View v) { stale = true; }
        @Override public void onViewDetachedFromWindow(View v) { stale = true; }
    }

    final boolean activityWindow; // false: a dialog, popup or drop-down (no TouchGate: covers there have no buttons)

    Scanner(SpoilerBlock sb, View decor, boolean activityWindow) {
        this.sb = sb;
        this.decor = decor;
        this.activityWindow = activityWindow;
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
            containers.clear();
            discover(decor);
        }
        Matcher m = sb.matcher;
        sb.images.capturedThisFrame = false;
        // index of the containers list grows while we read items: nested lists found inside items are judged too
        for (int ci = 0; ci < containers.size(); ci++) {
            View c = containers.get(ci);
            if (!c.isAttachedToWindow() || !c.isShown()) continue;
            ViewGroup g = itemParent((ViewGroup) c);
            for (int i = 0; i < g.getChildCount(); i++) {
                View it = g.getChildAt(i);
                if (it.getVisibility() != View.VISIBLE || it.getWidth() == 0) continue;
                if (m == null && (m = sb.awaitMatcher()) == null) return;
                judge(it, g, m, now);
            }
        }
        // a dialog or popup without a list (a message preview, a bottom sheet): its whole content is one item
        if (!activityWindow && containers.isEmpty() && decor instanceof ViewGroup && ((ViewGroup) decor).getChildCount() > 0) {
            View it = ((ViewGroup) decor).getChildAt(0);
            if (it.getVisibility() == View.VISIBLE && it.getWidth() > 0 && (m != null || (m = sb.awaitMatcher()) != null)) judge(it, (ViewGroup) decor, m, now);
        }
        // covers whose item left its list (removed, recycled into the scrap) go; a re-attached item is judged again
        for (int i = covers.size() - 1; i >= 0; i--) {
            Cover cv = covers.get(i);
            if (!cv.item.isAttachedToWindow()) { cv.remove(); covers.remove(i); items.remove(cv.item); }
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
     * Reels, Shorts, stories) or over a video surface (a feed's inline player, inside the item or floating over it).
     */
    private boolean hidesSound() {
        long window = (long) decor.getWidth() * decor.getHeight();
        for (Cover c : covers) {
            if (!c.item.isShown()) continue;
            if ((long) c.item.getWidth() * c.item.getHeight() * 10 >= window * 6) return true;
            if (hasVideo(c.item)) return true;
        }
        for (View v : shades.keySet()) if (v.isShown() && hasVideo(v)) return true;
        return false;
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
    private final List<Rect> coverRects = new ArrayList<>();
    private final List<Cover> rectCovers = new ArrayList<>();
    private final Set<View> shaded = new HashSet<>();

    /**
     * A view outside the lists that lies (>= 90 %) over a covered item and is a big part of it (>= 40 %) is drawn
     * over the cover by the app: a player, its controls, a video preview. It gets an opaque shade too.
     */
    private void shadeFloaters() {
        coverRects.clear();
        rectCovers.clear();
        for (Cover c : covers) {
            if (!c.item.isShown()) continue;
            c.item.getLocationOnScreen(loc);
            coverRects.add(new Rect(loc[0], loc[1], loc[0] + c.item.getWidth(), loc[1] + c.item.getHeight()));
            rectCovers.add(c);
        }
        shaded.clear();
        if (!coverRects.isEmpty()) floaters(decor);
        for (java.util.Iterator<Map.Entry<View, Shade>> i = shades.entrySet().iterator(); i.hasNext(); ) {
            Map.Entry<View, Shade> e = i.next();
            if (!shaded.contains(e.getKey())) { e.getKey().getOverlay().remove(e.getValue()); i.remove(); }
        }
    }

    private void floaters(View v) {
        if (v.getVisibility() != View.VISIBLE || containers.contains(v)) return; // list items are covered themselves
        long area = (long) v.getWidth() * v.getHeight();
        for (int k = 0; k < coverRects.size(); k++) {
            Rect r = coverRects.get(k);
            long ra = (long) r.width() * r.height();
            if (area < ra * 4 / 10 || area > ra * 11 / 10) continue;
            v.getLocationOnScreen(loc);
            Rect in = new Rect(loc[0], loc[1], loc[0] + v.getWidth(), loc[1] + v.getHeight());
            if (in.intersect(r) && (long) in.width() * in.height() * 10 >= area * 9) {
                Shade d = shades.get(v);
                if (d == null) {
                    shades.put(v, d = new Shade(v));
                    v.getOverlay().add(d);
                    if (Log.isLoggable(SpoilerBlock.TAG, Log.DEBUG)) Log.d(SpoilerBlock.TAG, "shade floating " + v.getClass().getName());
                }
                d.setBounds(0, 0, v.getWidth(), v.getHeight());
                d.update(rectCovers.get(k), loc[0] - r.left, loc[1] - r.top);
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

    private void discover(View v) {
        if (!(v instanceof ViewGroup) || v.getVisibility() != View.VISIBLE) return;
        ViewGroup g = (ViewGroup) v;
        if (isList(g)) containers.add(g);
        for (int i = 0; i < g.getChildCount(); i++) discover(g.getChildAt(i));
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

    private void judge(View it, ViewGroup parent, Matcher m, long now) {
        Item st = items.get(it);
        if (st == null) { items.put(it, st = new Item()); it.addOnAttachStateChangeListener(st); }
        long fp = fingerprint(it, 17);
        if (!st.stale && !st.pending && st.gen == sb.generation && st.fp == fp && now - st.at < RECHECK_MS) return;
        long r0 = System.nanoTime();
        TextCapture.Texts texts = new TextCapture.Texts();
        Cover paused = coverOf(it); // the real text, not the cover's accessibility nodes
        if (paused != null) paused.a11yPause(true);
        try { collect(it, texts, true); } finally { if (paused != null) paused.a11yPause(false); }
        String text = texts.sb.toString().replace('\u0001', ' '); // the app's text cannot pose as text read from pictures
        // media views: their verdicts (requested here when missing) and the text OCR found in them
        media.clear();
        if (sb.imagesMatter()) sb.images.candidates(it, this, media, true);
        Config.Works v = sb.worksFor(m);
        // rule 7: what the post's own text names decides how much its pictures may say
        if (media.isEmpty()) st.ownSeenOnly = st.ownNames = false;
        else if (st.ownGen != sb.generation || !text.equals(st.own)) { ownNames(m, text, v, st); st.own = text; st.ownGen = sb.generation; }
        boolean pending = false, unknown = false;
        List<Integer> imgGroups = new ArrayList<>();
        StringBuilder ocr = new StringBuilder(), key = new StringBuilder(text);
        List<View> toShade = new ArrayList<>();
        for (View mv : media) {
            Images.State s = sb.images.state(mv);
            key.append('\u0000').append(s.key);
            if (!s.done) { pending = true; toShade.add(mv); continue; }
            if (s.failed) { toShade.add(mv); continue; } // fail closed: the picture stays shaded
            // rule 7: the image model speaks only for a picture no text identifies
            if (!st.ownNames && !ocrNames(m, s)) for (double[] h : s.hits) { // the first hit not seen, as the extension takes it
                int g = (int) h[0];
                if (g == Clip.UNKNOWN) { unknown = true; break; }
                if (!m.groupSeen(g, v.seen)) {
                    if (Config.group(m.groupWorks(g), v, sb.blockUnlisted) != Config.NOT_COVERED && !imgGroups.contains(g)) imgGroups.add(g);
                    break;
                }
            }
            if (!s.ocr.isEmpty()) ocr.append('\n').append(s.ocr);
        }
        // rule 8: text read from pictures goes after the post's own text, behind one U+0001 (the matcher reads it more strictly)
        String full = ocr.length() == 0 ? text : text + '\u0001' + ocr.substring(Math.max(1, ocr.length() - 4000));
        statReads++;
        statReadNs += System.nanoTime() - r0;
        if (st.gen != sb.generation || !full.equals(st.text)) {
            long e0 = System.nanoTime();
            st.groups = m.evaluate(full, v.seen);
            statEvals++; statEvalNs += System.nanoTime() - e0;
            if (Log.isLoggable(SpoilerBlock.TAG, Log.VERBOSE)) { // what the matcher was given and what it found (adb shell setprop log.tag.SpoilerBlock VERBOSE)
                StringBuilder gs = new StringBuilder();
                for (int g : st.groups) gs.append(gs.length() > 0 ? ", " : "").append(m.labels[g]);
                Log.v(SpoilerBlock.TAG, "evaluate " + it.getClass().getName() + " groups=[" + gs + "] text=" + full.replace("\n", "\\n").replace("\u0001", "<U+0001>"));
            }
        }
        // rule 7: own text naming a seen work and no covered one outranks the pictures (their titles and their OCR names)
        int[] groups = st.ownSeenOnly ? new int[0] : st.groups;
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
            Boolean spoiler = sb.spoilerVerdict(full.replace('\u0001', '\n'));
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
        shadePictures(it, msg == null ? toShade : new ArrayList<>()); // pending pictures are shaded, not the whole post
        String reveal = key.toString(); // "Show once" is for this text with these images
        Cover cv = coverOf(it);
        boolean block = msg != null && !sb.revealed.contains(reveal);
        boolean log = Log.isLoggable(SpoilerBlock.TAG, Log.DEBUG);
        if (block) {
            if (cv == null) { covers.add(cv = new Cover(this, it, parent)); if (!activityWindow) catcher(); }
            int[] marks = new int[label != null ? named.size() : 0];
            for (int i = 0; i < marks.length; i++) marks[i] = named.get(i);
            if (cv.show(msg, marks, reveal) && log) {
                Log.d(SpoilerBlock.TAG, "block \"" + msg + "\" " + it.getClass().getName() + "@" + Integer.toHexString(System.identityHashCode(it)) + " text=" + full.replace('\n', '|'));
            }
        } else if (cv != null) {
            cv.remove();
            covers.remove(cv);
            if (log) Log.d(SpoilerBlock.TAG, "unblock " + it.getClass().getName() + "@" + Integer.toHexString(System.identityHashCode(it)));
        }
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
    private void ownNames(Matcher m, String text, Config.Works v, Item st) {
        boolean seen = false, covered = false;
        int[] gs = m.evaluate(text, noneSeen(m));
        for (int g : gs) {
            if (m.groupSeen(g, v.seen)) seen = true;
            else if (Config.group(m.groupWorks(g), v, sb.blockUnlisted) != Config.NOT_COVERED) covered = true;
        }
        st.ownNames = gs.length > 0;
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

    /** Visible text of an item: TextView text, content descriptions and the accessibility (virtual view) tree. */
    private void collect(View v, TextCapture.Texts out, boolean root) {
        if (v.getVisibility() != View.VISIBLE) return;
        if (!root && v instanceof ViewGroup && isList((ViewGroup) v)) { // a nested list's children are items of their own
            if (!containers.contains(v)) containers.add(v);
            return;
        }
        CharSequence cd = v.getContentDescription();
        out.add(cd);
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

    private Cover coverAt(float x, float y) {
        for (int i = covers.size() - 1; i >= 0; i--) {
            Cover c = covers.get(i);
            if (!c.item.isShown()) continue;
            c.item.getLocationOnScreen(loc);
            if (x >= loc[0] && y >= loc[1] && x < loc[0] + c.item.getWidth() * c.item.getScaleX() && y < loc[1] + c.item.getHeight() * c.item.getScaleY()) return c;
        }
        return null;
    }

    void revealOnce(Cover c) {
        sb.revealed.add(c.text);
        c.remove();
        covers.remove(c);
        Log.i(SpoilerBlock.TAG, "shown once");
    }

    /** Opaque shade over a floating view, repeating the part of the item's cover underneath (so its buttons stay visible). */
    private static final class Shade extends Drawable {
        private final View host;
        private Cover cover;
        private int dx, dy; // host position relative to the covered item

        Shade(View host) { this.host = host; }

        void update(Cover c, int dx, int dy) {
            if (c != cover || dx != this.dx || dy != this.dy) { cover = c; this.dx = dx; this.dy = dy; invalidateSelf(); host.invalidate(); }
        }

        @Override public void draw(Canvas canvas) {
            if (cover == null) { canvas.drawColor(0xFF111111); return; }
            canvas.drawColor(cover.palette.cover);
            canvas.save();
            canvas.translate(-dx, -dy);
            cover.drawInto(canvas);
            canvas.restore();
        }
        @Override public void setAlpha(int a) { }
        @Override public void setColorFilter(ColorFilter f) { }
        @Override public int getOpacity() { return PixelFormat.OPAQUE; }
    }
}
