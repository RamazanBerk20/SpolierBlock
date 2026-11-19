package dev.spoilerblock;

import org.json.JSONArray;
import org.json.JSONObject;

import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.text.Normalizer;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.LinkedHashSet;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.regex.Pattern;

/**
 * Line-by-line port of src/content/matcher.js (the browser extension's matcher). It reads the same
 * index.bin / index.json that tools/build-index.mjs writes; any behaviour change must be made there first.
 * Equality with the JS implementation is checked by MatcherTest against vectors produced by tools/vectors.mjs.
 */
public final class Matcher {
    static final int MAX_N = 8;
    static final int TITLE = 0, ALIAS = 1, CHAR = 2, TAG = 3, CHAR1 = 4, SERIES = 5, PART = 6;
    // media context words -> the work types they corroborate (TYPE_BIT); see the JS for the reasons
    private static final int MOV = 1, EPIS = 2 | 16, SCREEN = 1 | 2 | 16, GAME = 4, READ = 8 | 32 | 64, ALL = 127, YT = 128;
    private static final Map<String, Integer> CONTEXT = new HashMap<>();
    private static final Map<String, Integer> TYPE_BIT = new HashMap<>();
    static {
        Object[][] ctx = {
            {ALL, "ending endings finale spoiler spoilers sequel prequel remake reboot character characters plot adaptation franchise saga trilogy premiere"},
            // video-title words: weak (YT), an everyday-word name does not take them (see the JS)
            {ALL | YT, "review reviews reaction reacts reacting soundtrack ost lore recap recaps breakdown masterpiece remastered inceleme incelemesi"},
            {GAME | YT, "walkthrough mod mods modded"},
            {SCREEN | GAME, "trailer teaser scene scenes cast animation animated"},
            {SCREEN, "director cinema theater theatre netflix hbo disney pixar imdb tv watched watching rewatch rewatched " +
                "rewatching binge imax oscar oscars emmy emmys blockbuster screenplay cine kino"},
            {MOV, "movie movies film films"},
            {EPIS, "season seasons episode episodes ep eps show episodic showrunner sitcom miniseries"},
            {ALL, "series"},
            {GAME, "game games dlc boss playthrough gameplay nintendo playstation xbox steam played playing replayed roguelike " +
                "roguelite metroidvania platformer rpg jrpg mmo mmorpg fps soulslike speedrun multiplayer"},
            {READ, "chapter chapters volume book books novel read reading reread author comic comics webcomic"},
            {16 | 32, "anime manga shonen seinen isekai manhwa webtoon"},
            {SCREEN | GAME, "fragman fragmani"},
            {EPIS | READ, "capitulo capitulos"},
            {ALL, "serie seri serien"},
            {EPIS, "finali temporada episodio episodios staffel folge folgen saison stagione puntata"},
            {MOV, "pelicula peliculas filme filmes"},
            {GAME, "juego videojuego jogo spiel jeu gioco"},
            {READ, "libro livro novela livre tome"},
        };
        for (Object[] c : ctx) for (String w : ((String) c[1]).split(" ")) CONTEXT.merge(w, (Integer) c[0], (a, b) -> a | b);
        String[] types = {"movie", "tv", "game", "book", "anime", "manga", "comic"};
        for (int i = 0; i < types.length; i++) TYPE_BIT.put(types[i], 1 << i);
    }
    // Turkish suffixes: these stems match any longer word they start
    private static final String[] STEMS = {"sezon", "bolum", "dizi", "fragman", "film", "izle", "izli", "oyun", "oyn", "kitap", "kitab",
        "okudu", "okuyor", "okuma", "cizgi", "serisi", "serinin", "seriye", "manga", "anime", "sinema"};
    private static final int[] STEM_MASK = {EPIS, EPIS | READ, EPIS, SCREEN | GAME, MOV, SCREEN, SCREEN, GAME, GAME, READ, READ,
        READ, READ, READ, READ, ALL, ALL, ALL, 16 | 32, 16 | 32, SCREEN};
    private static final Pattern SXEX = Pattern.compile("^s\\d{1,2}e\\d{1,3}$");
    // shortcut: CJK/Thai text has no spaces (same limit as the JS matcher), add per-script segmentation when the JS side does.
    private static final Pattern WORD = Pattern.compile("&|[\\p{L}\\p{N}]+"); // an apostrophe splits words, as in the JS
    private static final Pattern MARKS = Pattern.compile("\\p{M}");
    static final int MAGIC = 0x53424959;
    static final int SEED_A = 0x9e3779b9, SEED_B = 0x7f4a7c15;

    // index.json columns
    public final String[] ids, titles, types, labels;
    final int[] years;
    final int[][] groups; // group -> work indices (the JSON's [label, w...] without the label)
    private final int[] u;
    private final int mask;
    private final int fmt; // index format (see the JS): 2 = group << 9 with ocr, rare and other bits; 1 = group << 8; 0
    private final Map<Integer, Integer> masks = new HashMap<>();

    public Matcher(byte[] bin, String json) throws Exception {
        ByteBuffer bb = ByteBuffer.wrap(bin).order(ByteOrder.LITTLE_ENDIAN);
        u = new int[bin.length / 4];
        bb.asIntBuffer().get(u);
        if (u[0] != MAGIC) throw new IllegalArgumentException("bad index");
        mask = (1 << u[1]) - 1;
        fmt = u[2];
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
        s = s.toLowerCase(java.util.Locale.ROOT);
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
        while (m.find()) {
            // a suffix after an apostrophe ("'s", Turkish "'i") is dropped when the word before it has more than 2 letters
            int k = t.size() - 1;
            if (k >= 0 && t.ends.get(k) == m.start() - 1 && "'’".indexOf(text.charAt(t.ends.get(k))) >= 0
                && t.ends.get(k) - t.starts.get(k) > 2 && m.end() - m.start() <= 4) {
                t.ends.set(k, m.end());
                continue;
            }
            t.toks.add(normTok(m.group())); t.starts.add(m.start()); t.ends.add(m.end());
        }
        return t;
    }

    // sentence number of each token: a new sentence after . ! ? or a line break between two tokens, except the dot of
    // an ordinal number ("2. sezon")
    private static int[] sentences(String text, Tokens tk) {
        int[] out = new int[tk.size()];
        int n = 0;
        for (int i = 0; i < out.length; i++) {
            if (i > 0) {
                String gap = text.substring(tk.ends.get(i - 1), tk.starts.get(i)), prev = tk.toks.get(i - 1);
                boolean ordinal = gap.equals(". ") && ORDINAL.matcher(prev).matches();
                for (int k = 0; k < gap.length() && !ordinal; k++) {
                    char c = gap.charAt(k);
                    if (c == '.' || c == '!' || c == '?' || c == '\n' || c == '\u0001') { n++; break; }
                }
            }
            out[i] = n;
        }
        return out;
    }
    private static final Pattern ORDINAL = Pattern.compile("\\d{1,2}"), DIGITS = Pattern.compile("\\d+");

    private static boolean lineBreak(String text, int from, int to) {
        for (int k = from; k < to; k++) { char c = text.charAt(k); if (c == '\n' || c == '\u0001') return true; }
        return false;
    }

    private static boolean caps(String text, Tokens tk, int i) {
        String w = text.substring(tk.starts.get(i), tk.ends.get(i));
        boolean letter = false;
        for (int k = 0; k < w.length(); ) { int c = w.codePointAt(k); letter |= Character.isLetter(c); k += Character.charCount(c); }
        return w.length() >= 2 && letter && w.equals(w.toUpperCase(java.util.Locale.ROOT)) && !w.equals(w.toLowerCase(java.util.Locale.ROOT));
    }

    /** Tokens [0, end) whose capitals prove nothing: ALL-CAPS runs and Headline Case lines (see the JS). */
    private static boolean[] caseless(String text, Tokens tk, int end) {
        boolean[] out = new boolean[end];
        int[] line = new int[end];
        int n = 0;
        for (int i = 0; i < end; i++) { if (i > 0 && lineBreak(text, tk.ends.get(i - 1), tk.starts.get(i))) n++; line[i] = n; }
        for (int i = 0; i < end; i++) {
            out[i] = caps(text, tk, i) && (i > 0 && line[i - 1] == line[i] && caps(text, tk, i - 1) || i + 1 < end && line[i + 1] == line[i] && caps(text, tk, i + 1));
        }
        for (int a = 0, b; a < end; a = b) {
            int words = 0, up = 0;
            for (b = a; b < end && line[b] == line[a]; b++) {
                String t = tk.toks.get(b);
                if (t.length() >= 4 && hasLetter(t)) { words++; if (upperAt(text, tk.starts.get(b))) up++; }
            }
            if (words >= 4 && up >= 0.7 * words) for (int i = a; i < b; i++) out[i] = true;
        }
        return out;
    }

    private static boolean hasLetter(String s) {
        for (int k = 0; k < s.length(); ) { int c = s.codePointAt(k); if (Character.isLetter(c)) return true; k += Character.charCount(c); }
        return false;
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
        int g, i, n, s, e; boolean common, other, rare, caseOnly, weak, part, hashed, ocr, plain, wordy, bare; String key, typed;
    }

    /**
     * Group indices the text is about, in label order: groups named by the post's own text first, then groups named
     * only by OCR text (after a U+0001 marker); within each, the longer matched name first, then the more popular.
     * seenWork[w] marks works the user has seen.
     */
    public int[] evaluate(String text, boolean[] seenWork) {
        Tokens tk = tokenize(text);
        int len = tk.size();
        if (len == 0) return new int[0];
        int mark = text.indexOf('\u0001'), ocrFrom = len;
        if (mark >= 0) for (int i = 0; i < len; i++) if (tk.starts.get(i) > mark) { ocrFrom = i; break; }
        int shift = fmt >= 2 ? 9 : fmt >= 1 ? 8 : 7;
        boolean[] loud = null;
        int[] ha = new int[len], hb = new int[len];
        for (int i = 0; i < len; i++) { int[] h = tokHash(tk.toks.get(i)); ha[i] = h[0]; hb[i] = h[1]; }
        List<Cand> cands = new ArrayList<>();
        for (int i = 0; i < len; i++) {
            int A = SEED_A, B = SEED_B;
            for (int n = 1; n <= MAX_N && i + n <= len; n++) {
                A = mixA(A, ha[i + n - 1]); B = mixB(B, hb[i + n - 1]);
                int v = lookup(A, B);
                if (v < 0) continue;
                int kind = v & (fmt >= 1 ? 7 : 15);
                boolean ocrOk = fmt >= 2 && ((v >>> 8) & 1) != 0, rare = fmt >= 1 && ((v >>> 7) & 1) != 0, cap = ((v >>> 6) & 1) != 0;
                boolean common = ((v >>> 5) & 1) != 0, amb = ((v >>> 4) & 1) != 0, other = fmt >= 1 && ((v >>> 3) & 1) != 0;
                int s = tk.starts.get(i), e = tk.ends.get(i + n - 1);
                boolean titleLike = kind == TITLE || kind == ALIAS || kind == SERIES;
                String typed = typeNear(tk, text, i, n);
                Integer narrowed = narrow(tk, i, n, titleLike, typed);
                int g = narrowed != null ? narrowed : v >>> shift;
                if (i >= ocrFrom) { // text read from pictures: only names strong without help count
                    if (ocrOk) {
                        Cand c = new Cand();
                        c.g = g; c.i = i; c.n = n; c.s = s; c.e = e; c.ocr = true; c.typed = typed; c.key = String.join(" ", tk.toks.subList(i, i + n));
                        cands.add(c);
                    }
                    continue;
                }
                if (i + n > ocrFrom) continue; // never across the marker
                boolean hashed = s > 0 && text.charAt(s - 1) == '#';
                if (kind == TAG && !hashed) continue;
                String firstTok = text.substring(s, tk.ends.get(i));
                if ((kind == CHAR1 || kind == PART) && !upperAt(firstTok, 0)) continue; // bare names must be capitalized
                if (cap && !hashed) { // "cap" names must appear in Title Case, quoted or not
                    boolean bad = false;
                    for (int j = 0; j < n && !bad; j++) {
                        int st = tk.starts.get(i + j);
                        bad = (j == 0 || tk.toks.get(i + j).length() > 3) && !upperOrDigitAt(text, st);
                    }
                    if (bad) continue;
                }
                if (loud == null) loud = caseless(text, tk, ocrFrom);
                boolean caseOnly = false; // a capital proves nothing in an ALL-CAPS run or a Headline Case line
                if (cap && (common || amb || rare || other) && (n == 1 || common && n == 2)) for (int j = i; j < i + n && !caseOnly; j++) caseOnly = loud[j];
                Cand c = new Cand();
                c.g = g; c.i = i; c.n = n; c.s = s; c.e = e; c.common = common; c.other = other; c.rare = rare; c.hashed = hashed;
                c.caseOnly = caseOnly; c.typed = typed;
                // a single word that is everyday, ambiguous or obscure; a bare number (".45" in "45 minutes")
                c.plain = titleLike && n == 1 && (common || amb || rare);
                c.wordy = c.plain && !rare;
                c.bare = titleLike && n == 1 && DIGITS.matcher(tk.toks.get(i)).matches();
                c.weak = caseOnly || common || other || rare || kind == CHAR1 || kind == PART || (titleLike && ((amb && n <= 2) || (n == 1 && firstTok.length() <= 3))) || c.bare;
                c.part = kind == PART;
                c.key = String.join(" ", tk.toks.subList(i, i + n));
                cands.add(c);
            }
        }
        if (cands.isEmpty()) return new int[0];
        // Longest match wins, seen or not: "Us" inside "The Last of Us", "Assassin" inside "Assassin's Creed".
        boolean[] drop = new boolean[cands.size()];
        for (int k = 0; k < cands.size(); k++) {
            Cand c = cands.get(k);
            for (Cand o : cands) if (!drop[k] && o != c && o.i <= c.i && o.i + o.n >= c.i + c.n && o.n > c.n) drop[k] = true;
        }
        List<Cand> kept = new ArrayList<>();
        for (int k = 0; k < cands.size(); k++) if (!drop[k]) kept.add(cands.get(k));

        LinkedHashSet<Integer> own = new LinkedHashSet<>(), pics = new LinkedHashSet<>();
        Map<Integer, Integer> longest = new HashMap<>();
        java.util.Set<Integer> named = new java.util.HashSet<>();
        int[] line = lines(text, tk, ocrFrom), sent = null;
        // a music title names a song: a single word there is no work
        boolean music = MUSIC.matcher(mark >= 0 ? text.substring(0, mark) : text).find();
        // everyday single words come last: a line that already names a work keeps its media words (see the JS)
        List<Cand> queue = new ArrayList<>();
        for (Cand c : kept) if (c.ocr || !c.wordy) queue.add(c);
        for (Cand c : kept) if (!c.ocr && c.wordy) queue.add(c);
        for (Cand c : queue) {
            boolean ok;
            if (c.ocr) ok = true;
            else {
                // a hashtag or quotes are no evidence for a name that mostly means something else (#Palestine), and a
                // hashtag alone does not make a plain single word a title (#verity)
                boolean firm = !c.other && ((c.hashed && !c.plain) || isQuoted(text, c.s, c.e));
                for (int k = 0; k < kept.size() && !firm; k++) {
                    Cand o = kept.get(k);
                    firm = !o.ocr && !o.key.equals(c.key) && (shares(o.g, c.g) || apart(o.key, c.key) && (within(o.key, c.g) || within(c.key, o.g)));
                }
                if (music && c.n == 1) ok = firm;
                else if (!c.weak || firm) ok = true;
                else if (c.bare) ok = false; // a bare number is a title only in quotes or beside another name of its work
                else ok = corroborated(c, text, tk, sent == null ? (sent = sentences(text, tk)) : sent, len,
                    c.wordy && named.contains(line[c.i]) && c.typed == null);
            }
            if (ok) {
                (c.ocr ? pics : own).add(c.g);
                Integer l = longest.get(c.g);
                longest.put(c.g, l == null ? c.n : Math.max(l, c.n));
                if (!c.ocr && !c.wordy) named.add(line[c.i]);
            }
        }
        // The post's own text outranks its pictures: when it names a seen work and no other, OCR names do not count.
        List<Integer> ownOpen = new ArrayList<>(), picOnly = new ArrayList<>(), all = new ArrayList<>();
        for (int g : own) if (!groupSeen(g, seenWork)) ownOpen.add(g);
        if (own.isEmpty() || !ownOpen.isEmpty()) for (int g : pics) if (!own.contains(g) && !groupSeen(g, seenWork)) picOnly.add(g);
        all.addAll(ownOpen);
        all.addAll(picOnly);
        java.util.Comparator<Integer> order = (a1, b1) -> {
            int d = longest.get(b1) - longest.get(a1);
            return d != 0 ? d : Integer.compare(a1, b1);
        };
        List<Integer> res = new ArrayList<>();
        for (List<Integer> tier : Arrays.asList(ownOpen, picOnly)) {
            List<Integer> t = new ArrayList<>();
            for (int g : tier) if (!insideOther(g, all)) t.add(g);
            t.sort(order);
            res.addAll(t);
        }
        int[] r = new int[res.size()];
        for (int k = 0; k < r.length; k++) r[k] = res.get(k);
        return r;
    }

    // a song's title: "ft.", "feat.", "prod.", "official (music) video/audio", "music/lyric video", "(lyrics)", "klip"
    private static final Pattern MUSIC = Pattern.compile(
        "(?:^|[^\\p{L}])(?:ft|feat|prod)\\.|official (?:music )?(?:video|audio)|(?:music|lyric) video|\\(lyrics?\\)|(?:^|[^\\p{L}])klip(?:$|[^\\p{L}])",
        Pattern.CASE_INSENSITIVE | Pattern.UNICODE_CASE);

    // line number of each token before `end`
    private static int[] lines(String text, Tokens tk, int end) {
        int[] out = new int[end];
        int n = 0;
        for (int i = 0; i < end; i++) { if (i > 0 && lineBreak(text, tk.ends.get(i - 1), tk.starts.get(i))) n++; out[i] = n; }
        return out;
    }

    // "Castle" and "Castle Rock" share a word: one name inside the other's title is no evidence then
    private static boolean apart(String a, String b) {
        java.util.Set<String> x = new java.util.HashSet<>(Arrays.asList(a.split(" ")));
        for (String t : b.split(" ")) if (x.contains(t)) return false;
        return true;
    }

    // the name (tokens joined by spaces) appears in the title of one of the group's works ("Fallout" and "New Vegas")
    private boolean within(String key, int g) {
        for (int w : groups[g]) if ((" " + titleKey(w) + " ").contains(" " + key + " ")) return true;
        return false;
    }

    private final Map<Integer, String> tkeys = new HashMap<>();
    private String titleKey(int w) {
        String k = tkeys.get(w);
        if (k == null) tkeys.put(w, k = String.join(" ", tokenize(titles[w]).toks));
        return k;
    }

    // type words for narrowing (normalised tokens; Turkish suffixed forms by stem)
    private static final Map<String, String> TYPE_WORDS = new HashMap<>();
    static {
        String[][] tw = {{"movie", "movie movies film films pelicula peliculas filme filmes"}, {"tv", "show tv dizi"},
            {"game", "game games juego videojuego jogo spiel jeu gioco oyun"}, {"book", "book books novel novels kitap libro livro novela livre"},
            {"anime", "anime"}, {"manga", "manga"}, {"comic", "comic comics"}};
        for (String[] x : tw) for (String w : x[1].split(" ")) TYPE_WORDS.put(w, x[0]);
    }
    private static final String[][] TYPE_STEMS = {{"film", "movie"}, {"dizi", "tv"}, {"oyun", "game"}, {"kitap", "book"}, {"kitab", "book"}};
    private static String typeWord(String t) {
        String x = TYPE_WORDS.get(t);
        if (x != null) return x;
        for (String[] st : TYPE_STEMS) if (t.startsWith(st[0])) return st[1];
        return null;
    }

    // the type word right after the name, else right before it, with no sentence break between
    private static String typeNear(Tokens tk, String text, int i, int n) {
        int j = i + n;
        String type = j < tk.size() && !sentenceBreak(text, tk.ends.get(j - 1), tk.starts.get(j)) ? typeWord(tk.toks.get(j)) : null;
        if (type == null && i > 0 && !sentenceBreak(text, tk.ends.get(i - 1), tk.starts.get(i))) type = typeWord(tk.toks.get(i - 1));
        return type;
    }

    private static boolean sentenceBreak(String text, int from, int to) {
        for (int k = from; k < to; k++) { char c = text.charAt(k); if (c == '.' || c == '!' || c == '?' || c == '\n' || c == '\u0001') return true; }
        return false;
    }

    // a type word next to a work's name narrows its group: the index holds it under the name + "\u0002" + type
    private Integer narrow(Tokens tk, int i, int n, boolean titleLike, String type) {
        if (fmt < 3 || !titleLike || type == null) return null;
        int A = SEED_A, B = SEED_B;
        for (int k = i; k < i + n; k++) { int[] h = tokHash(tk.toks.get(k)); A = mixA(A, h[0]); B = mixB(B, h[1]); }
        int[] h = tokHash("\u0002" + type);
        A = mixA(A, h[0]); B = mixB(B, h[1]);
        int v = lookup(A, B);
        return v >= 0 ? v >>> 9 : null;
    }

    // A group whose works are all inside another matched group adds nothing ("Potter" inside "Harry Potter").
    private boolean insideOther(int g, List<Integer> all) {
        for (int o : all) {
            if (o == g || groups[g].length >= groups[o].length) continue;
            boolean every = true;
            for (int w : groups[g]) if (!contains(groups[o], w)) { every = false; break; }
            if (every) return true;
        }
        return false;
    }

    /**
     * The rules for a weak name of the post's own text: media words of its type in its sentence, a year...
     * lined: an everyday single word in a line that already names a work (it takes only a media word joined to it by a
     * space, see the JS).
     */
    private boolean corroborated(Cand c, String text, Tokens tk, int[] sent, int len, boolean lined) {
        if (c.part || !upperOrDigitAt(text, c.s)) return false; // the remaining rules need a capitalized form (or a number)
        int si = sent[c.i], mask = typeMask(c.g);
        Integer verb = c.i > 0 && sent[c.i - 1] == si ? VERBS.get(tk.toks.get(c.i - 1)) : null;
        boolean said = (c.n > 1 || !SUBJECT.contains(c.key)) && described(tk, sent, c.i + c.n, si, mask, c.common) || verb != null && (verb & mask) != 0;
        boolean near = said;
        for (int j = Math.max(0, c.i - 3), hi = Math.min(len, c.i + c.n + 3); j < hi && !near; j++) near = fits(c, j, si, mask, sent, tk);
        int after = c.i + c.n + (c.i + c.n < len && DIGITS.matcher(tk.toks.get(c.i + c.n)).matches() ? 1 : 0); // "Lost 2. sezon"
        boolean adjacent = said || fits(c, c.i - 1, si, mask, sent, tk) || fits(c, after, si, mask, sent, tk);
        if (lined && !(joined(text, tk, c.i - 1, c.i) && fits(c, c.i - 1, si, mask, sent, tk))
            && !(joined(text, tk, c.i, c.i + 1) && fits(c, c.i + 1, si, mask, sent, tk))) return false;
        if (c.caseOnly) return adjacent;
        // a name that mostly means something else: a media word near it; as an everyday word at the start of a
        // sentence ("Go to channel TV"), right next to it
        if (c.other) return c.common && sentenceStart(text, c.s) ? adjacent : near;
        boolean ok = false; // a release year of one of its works in the same sentence
        for (int j = 0; j < len && !ok; j++) {
            if (sent[j] != si) continue;
            for (int w : groups[c.g]) if (years[w] != 0 && tk.toks.get(j).equals(String.valueOf(years[w]))) { ok = true; break; }
        }
        // at the start of a sentence everyday words need a second capitalised word of 3+ letters
        boolean capped = !c.common || !sentenceStart(text, c.s);
        for (int j = c.i + 1; j < c.i + c.n && !capped; j++) capped = tk.toks.get(j).length() >= 3 && upperAt(text, tk.starts.get(j));
        if (!ok && !capped) ok = adjacent;
        else if (!ok && c.common && c.n == 1) ok = near;
        else for (int j = 0; j < len && !ok; j++) ok = fits(c, j, si, mask, sent, tk);
        return ok;
    }

    // two tokens separated by spaces only
    private static boolean joined(String text, Tokens tk, int a, int b) {
        if (a < 0 || b >= tk.size()) return false;
        String gap = text.substring(tk.ends.get(a), tk.starts.get(b));
        return !gap.isEmpty() && gap.chars().allMatch(ch -> ch == ' ');
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

    // a media word of the work's type in the name's own sentence, outside the name
    private static boolean fits(Cand c, int j, int si, int mask, int[] sent, Tokens tk) {
        if (j < 0 || j >= sent.length || sent[j] != si || (j >= c.i && j < c.i + c.n)) return false;
        int cm = contextMask(tk.toks.get(j));
        return (cm & mask) != 0 && !((cm & YT) != 0 && c.common);
    }

    // verbs of consuming a work, only right before the name; "<name> is (such) a ... game" (see the JS)
    private static final Map<String, Integer> VERBS = new HashMap<>();
    static {
        for (String w : "beat beating".split(" ")) VERBS.put(w, GAME);
        for (String w : "binged binging".split(" ")) VERBS.put(w, SCREEN);
        for (String w : "finished finishing completed started starting".split(" ")) VERBS.put(w, ALL);
    }
    private static final java.util.Set<String> SUBJECT = words("it this that he she they we you i there here what who which"),
        COPULA = words("is was are were es ist war est etait"),
        DET = words("a an the such my our your his her their this one un una ein eine einen une um uma bir"),
        STOP = words("to of for in on at with about from that which who where when because but and or if than like as by while");
    private static java.util.Set<String> words(String s) { return new java.util.HashSet<>(Arrays.asList(s.split(" "))); }

    private static boolean described(Tokens tk, int[] sent, int j, int si, int mask, boolean everyday) {
        boolean cop = j < sent.length && sent[j] == si && COPULA.contains(tk.toks.get(j));
        if (cop) j++;
        boolean det = false;
        for (int k = j; k < Math.min(tk.size(), j + 8) && sent[k] == si; k++) {
            String t = tk.toks.get(k);
            if (DET.contains(t)) { det = det || cop || t.equals("bir"); continue; }
            int cm = contextMask(t);
            if (det && (cm & mask) != 0 && !(everyday && (cm & YT) != 0)) return true;
            if (STOP.contains(t) && !(t.equals("of") && tk.toks.get(k - 1).equals("one"))) return false; // "one of the best films"
        }
        return false;
    }

    static int contextMask(String t) {
        Integer m = CONTEXT.get(t);
        if (m != null) return m;
        if (SXEX.matcher(t).matches()) return EPIS;
        for (int k = 0; k < STEMS.length; k++) if (t.startsWith(STEMS[k])) return STEM_MASK[k];
        return 0;
    }

    private int typeMask(int g) {
        Integer m = masks.get(g);
        if (m == null) {
            int x = 0;
            for (int w : groups[g]) { Integer b = TYPE_BIT.get(types[w]); if (b != null) x |= b; }
            masks.put(g, m = x);
        }
        return m;
    }

    private static boolean upperAt(String s, int i) {
        return i < s.length() && Character.getType(s.codePointAt(i)) == Character.UPPERCASE_LETTER;
    }

    private static boolean upperOrDigitAt(String s, int i) {
        if (i >= s.length()) return false;
        int t = Character.getType(s.codePointAt(i));
        return t == Character.UPPERCASE_LETTER || t == Character.DECIMAL_DIGIT_NUMBER || t == Character.LETTER_NUMBER || t == Character.OTHER_NUMBER;
    }

    private static boolean isQuoted(String text, int s, int e) {
        return s > 0 && "\"“'‘«*_".indexOf(text.charAt(s - 1)) >= 0 && e < text.length() && "\"”'’»*_".indexOf(text.charAt(e)) >= 0
            && !((text.charAt(e) == '\'' || text.charAt(e) == '’') && e + 1 < text.length() && Character.isLetter(text.codePointAt(e + 1))); // "It's"
    }

    private static boolean sentenceStart(String text, int s) {
        for (int i = s - 1; i >= 0; i--) {
            char c = text.charAt(i);
            if (c == '\n' || c == '\u0001') return true; // a line break separates texts (UI labels such as YouTube's "Go to channel X" lines)
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
