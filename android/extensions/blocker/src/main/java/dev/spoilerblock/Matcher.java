package dev.spoilerblock;

import org.json.JSONArray;
import org.json.JSONObject;

import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.text.Normalizer;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.HashSet;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;
import java.util.regex.Pattern;

/**
 * Line-by-line port of src/content/matcher.js (the browser extension's matcher). It reads the same
 * index.bin / index.json that tools/build-index.mjs writes; any behaviour change must be made there first.
 * Equality with the JS implementation is checked by MatcherTest against vectors produced by tools/vectors.mjs.
 */
public final class Matcher {
    static final int MAX_N = 8;
    static final int TITLE = 0, ALIAS = 1, CHAR = 2, TAG = 3, CHAR1 = 4, SERIES = 5, PART = 6;
    private static final Set<String> CONTEXT = new HashSet<>(Arrays.asList(("season seasons episode episodes ep eps movie movies film films trailer teaser ending endings " +
        "finale spoiler spoilers series show sequel prequel remake reboot cast character characters scene scenes plot " +
        "director chapter chapters volume book books novel manga anime game games dlc boss playthrough watched watching " +
        "rewatch rewatching binge premiere cinema theater theatre netflix hbo disney pixar imdb streaming tv adaptation " +
        "franchise saga trilogy episodic showrunner gameplay nintendo playstation xbox steam read reading").split(" ")));
    private static final Pattern SXEX = Pattern.compile("^s\\d{1,2}e\\d{1,3}$");
    // shortcut: CJK/Thai text has no spaces (same limit as the JS matcher), add per-script segmentation when the JS side does.
    private static final Pattern WORD = Pattern.compile("&|[\\p{L}\\p{N}]+(?:['’][\\p{L}\\p{N}]+)*");
    private static final Pattern MARKS = Pattern.compile("\\p{M}");
    static final int MAGIC = 0x53424959;
    static final int SEED_A = 0x9e3779b9, SEED_B = 0x7f4a7c15;

    // index.json columns
    public final String[] ids, titles, types, labels;
    final int[] years;
    final int[][] groups; // group -> work indices (the JSON's [label, w...] without the label)
    private final int[] u;
    private final int mask;

    public Matcher(byte[] bin, String json) throws Exception {
        ByteBuffer bb = ByteBuffer.wrap(bin).order(ByteOrder.LITTLE_ENDIAN);
        u = new int[bin.length / 4];
        bb.asIntBuffer().get(u);
        if (u[0] != MAGIC) throw new IllegalArgumentException("bad index");
        mask = (1 << u[1]) - 1;
        JSONObject m = new JSONObject(json);
        ids = strings(m.getJSONArray("ids"));
        titles = strings(m.getJSONArray("titles"));
        types = strings(m.getJSONArray("types"));
        JSONArray y = m.getJSONArray("years");
        years = new int[y.length()];
        for (int i = 0; i < years.length; i++) years[i] = y.getInt(i);
        JSONArray g = m.getJSONArray("groups");
        labels = new String[g.length()];
        groups = new int[g.length()][];
        for (int i = 0; i < labels.length; i++) {
            JSONArray a = g.getJSONArray(i);
            labels[i] = a.getString(0);
            groups[i] = new int[a.length() - 1];
            for (int j = 1; j < a.length(); j++) groups[i][j - 1] = a.getInt(j);
        }
    }

    private static String[] strings(JSONArray a) throws Exception {
        String[] r = new String[a.length()];
        for (int i = 0; i < r.length; i++) r[i] = a.getString(i);
        return r;
    }

    public int[] groupWorks(int g) { return groups[g]; }

    // ---------- tokenizer and hashes (identical to the JS) ----------

    static String normTok(String s) {
        if (s.equals("&")) return "and";
        s = s.replace("'", "").replace("’", "").toLowerCase(java.util.Locale.ROOT);
        for (int i = 0; i < s.length(); i++) {
            if (s.charAt(i) > 0x7f) return MARKS.matcher(Normalizer.normalize(s, Normalizer.Form.NFKD)).replaceAll("");
        }
        return s;
    }

    static final class Tokens {
        final List<String> toks = new ArrayList<>();
        final List<Integer> starts = new ArrayList<>(), ends = new ArrayList<>();
        int size() { return toks.size(); }
    }

    static Tokens tokenize(String text) {
        Tokens t = new Tokens();
        java.util.regex.Matcher m = WORD.matcher(text);
        while (m.find()) { t.toks.add(normTok(m.group())); t.starts.add(m.start()); t.ends.add(m.end()); }
        return t;
    }

    static int[] tokHash(String s) {
        int a = 0x811c9dc5, b = 0x01234567;
        for (int i = 0; i < s.length(); i++) {
            int c = s.charAt(i);
            a = (a ^ c) * 16777619;
            b = (b ^ c) * 0x5bd1e995; b ^= b >>> 13;
        }
        return new int[]{a, b};
    }
    static int mixA(int h, int t) { h = (h ^ t) * 0x85ebca6b; return h ^ (h >>> 13); }
    static int mixB(int h, int t) { h = (h ^ t) * 0xc2b2ae35; return h ^ (h >>> 16); }

    private int lookup(int a, int b) {
        int s = a & mask;
        for (;;) {
            int o = 3 + s * 3, ref = u[o + 2];
            if (ref == 0) return -1;
            if (u[o] == a && u[o + 1] == b) return ref - 1;
            s = (s + 1) & mask;
        }
    }

    // ---------- evaluate ----------

    private static final class Cand {
        int g, i, n, s, e; boolean common, seen, weak, part, hashed; String key;
    }

    /** Group indices (most popular first) the text is about. seenWork[w] marks works the user has seen. */
    public int[] evaluate(String text, boolean[] seenWork) {
        Tokens tk = tokenize(text);
        int len = tk.size();
        if (len == 0) return new int[0];
        int[] ha = new int[len], hb = new int[len];
        for (int i = 0; i < len; i++) { int[] h = tokHash(tk.toks.get(i)); ha[i] = h[0]; hb[i] = h[1]; }
        List<Cand> cands = new ArrayList<>();
        for (int i = 0; i < len; i++) {
            int A = SEED_A, B = SEED_B;
            for (int n = 1; n <= MAX_N && i + n <= len; n++) {
                A = mixA(A, ha[i + n - 1]); B = mixB(B, hb[i + n - 1]);
                int v = lookup(A, B);
                if (v < 0) continue;
                int g = v >>> 7, kind = v & 15;
                boolean cap = ((v >>> 6) & 1) != 0, common = ((v >>> 5) & 1) != 0, amb = ((v >>> 4) & 1) != 0;
                int s = tk.starts.get(i), e = tk.ends.get(i + n - 1);
                boolean hashed = s > 0 && text.charAt(s - 1) == '#';
                if (kind == TAG && !hashed) continue;
                String firstTok = text.substring(s, tk.ends.get(i));
                if ((kind == CHAR1 || kind == PART) && !upperAt(firstTok, 0)) continue; // bare names must be capitalized
                if (cap && !hashed && !isQuoted(text, s, e)) { // "cap" names must appear in Title Case
                    boolean bad = false;
                    for (int j = 0; j < n && !bad; j++) {
                        int st = tk.starts.get(i + j);
                        bad = (j == 0 || tk.toks.get(i + j).length() > 3) && !upperOrDigitAt(text, st);
                    }
                    if (bad) continue;
                }
                boolean titleLike = kind == TITLE || kind == ALIAS || kind == SERIES;
                Cand c = new Cand();
                c.g = g; c.i = i; c.n = n; c.s = s; c.e = e; c.common = common; c.hashed = hashed;
                c.seen = groupSeen(g, seenWork);
                c.weak = common || kind == CHAR1 || kind == PART || (titleLike && ((amb && n <= 2) || (n == 1 && firstTok.length() <= 3)));
                c.part = kind == PART;
                c.key = String.join(" ", tk.toks.subList(i, i + n));
                cands.add(c);
            }
        }
        if (cands.isEmpty()) return new int[0];
        // Longest match wins: "Us" and "Last" inside "The Last of Us".
        boolean[] drop = new boolean[cands.size()];
        for (int k = 0; k < cands.size(); k++) {
            Cand c = cands.get(k);
            drop[k] = c.seen;
            for (Cand o : cands) if (!drop[k] && o != c && o.i <= c.i && o.i + o.n >= c.i + c.n && o.n > c.n) drop[k] = true;
        }
        List<Cand> kept = new ArrayList<>();
        for (int k = 0; k < cands.size(); k++) if (!drop[k]) kept.add(cands.get(k));

        LinkedHashSet<Integer> out = new LinkedHashSet<>();
        Set<String> tokSet = null;
        for (Cand c : kept) {
            if (out.contains(c.g)) continue;
            boolean strong = !c.weak || c.hashed || isQuoted(text, c.s, c.e);
            for (int k = 0; k < kept.size() && !strong; k++) {
                Cand o = kept.get(k);
                strong = !o.key.equals(c.key) && shares(o.g, c.g);
            }
            if (strong) { out.add(c.g); continue; }
            if (c.part || !upperAt(text, c.s)) continue; // remaining rules need a capitalized form
            if (tokSet == null) tokSet = new HashSet<>(tk.toks);
            boolean year = false;
            for (int w : groups[c.g]) if (years[w] != 0 && tokSet.contains(String.valueOf(years[w]))) { year = true; break; }
            if (year) { out.add(c.g); continue; }
            int lo = Math.max(0, c.i - 3), hi = Math.min(len, c.i + c.n + 3);
            boolean near = false;
            for (int j = lo; j < hi && !near; j++) near = (j < c.i || j >= c.i + c.n) && isContext(tk.toks.get(j));
            // everyday-word names only take an adjacent media word, and never at the start of a sentence
            boolean add;
            if (c.common) add = near && !sentenceStart(text, c.s);
            else {
                boolean any = false;
                for (String t : tk.toks) if (isContext(t)) { any = true; break; }
                add = near || (!sentenceStart(text, c.s) && any);
            }
            if (add) out.add(c.g);
        }
        // A group whose works are all inside another matched group adds nothing ("Potter" inside "Harry Potter").
        List<Integer> res = new ArrayList<>();
        for (int g : out) {
            boolean inside = false;
            for (int o : out) {
                if (o == g || groups[g].length >= groups[o].length) continue;
                boolean all = true;
                for (int w : groups[g]) if (!contains(groups[o], w)) { all = false; break; }
                if (all) { inside = true; break; }
            }
            if (!inside) res.add(g);
        }
        int[] r = new int[res.size()];
        for (int k = 0; k < r.length; k++) r[k] = res.get(k);
        Arrays.sort(r);
        return r;
    }

    public boolean groupSeen(int g, boolean[] seenWork) {
        for (int w : groups[g]) if (!seenWork[w]) return false;
        return true;
    }

    private boolean shares(int a, int b) {
        if (a == b) return true;
        for (int w : groups[a]) if (contains(groups[b], w)) return true;
        return false;
    }

    private static boolean contains(int[] a, int v) {
        for (int x : a) if (x == v) return true;
        return false;
    }

    private static boolean isContext(String t) { return CONTEXT.contains(t) || SXEX.matcher(t).matches(); }

    private static boolean upperAt(String s, int i) {
        return i < s.length() && Character.getType(s.codePointAt(i)) == Character.UPPERCASE_LETTER;
    }

    private static boolean upperOrDigitAt(String s, int i) {
        if (i >= s.length()) return false;
        int t = Character.getType(s.codePointAt(i));
        return t == Character.UPPERCASE_LETTER || t == Character.DECIMAL_DIGIT_NUMBER || t == Character.LETTER_NUMBER || t == Character.OTHER_NUMBER;
    }

    private static boolean isQuoted(String text, int s, int e) {
        return s > 0 && "\"“'‘«*_".indexOf(text.charAt(s - 1)) >= 0 && e < text.length() && "\"”'’»*_".indexOf(text.charAt(e)) >= 0;
    }

    private static boolean sentenceStart(String text, int s) {
        for (int i = s - 1; i >= 0; i--) {
            char c = text.charAt(i);
            if (c == '\n') return true; // a line break separates texts (UI labels such as YouTube's "Go to channel X" lines)
            if (jsSpace(c)) continue;
            return ".!?:;\n•|-–—([".indexOf(c) >= 0;
        }
        return true;
    }

    // JavaScript's \s (Java's \s is ASCII-only)
    static boolean jsSpace(char c) {
        return c == ' ' || (c >= '\t' && c <= '\r') || c == 0xa0 || c == 0x1680 || (c >= 0x2000 && c <= 0x200a) ||
            c == 0x2028 || c == 0x2029 || c == 0x202f || c == 0x205f || c == 0x3000 || c == 0xfeff;
    }
}
