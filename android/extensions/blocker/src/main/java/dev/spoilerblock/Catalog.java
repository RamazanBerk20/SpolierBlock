package dev.spoilerblock;

import java.io.IOException;
import java.io.Reader;
import java.math.BigInteger;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.regex.Pattern;

/**
 * Port of src/shared/catalog-rules.js (work finalisation, ambiguity rule, ordering) and src/shared/build-index.js
 * (the index builder). Same inputs give byte-identical index.bin / index.json; CatalogTest checks that against the
 * Node build. Any rule change must be made in the JS first.
 */
final class Catalog {
    /** One work in the catalog schema: { id, title, type, year, aliases, characters, pop, ambiguous, other? }. */
    static final class Work {
        String id, title, type;
        int year; // 0 = null
        String[] aliases = new String[0], characters = new String[0];
        String[] other = new String[0]; // names that mostly mean something else (tools/catalog/build.mjs)
        double pop;
        boolean ambiguous;
    }

    // ---------- catalog.json (streamed) ----------

    static List<Work> readWorks(Reader r) throws IOException {
        Json j = new Json(r);
        List<Work> works = null;
        j.beginObject();
        while (j.hasNext()) {
            if (j.nextName().equals("works")) works = readWorkArray(j);
            else j.skipValue();
        }
        j.endObject();
        if (works == null) throw new IOException("catalog has no works");
        return works;
    }

    static List<Work> readWorkArray(Json j) throws IOException {
        List<Work> works = new ArrayList<>();
        j.beginArray();
        while (j.hasNext()) {
            Work w = new Work();
            j.beginObject();
            while (j.hasNext()) {
                String k = j.nextName();
                if (j.nextNull()) continue;
                switch (k) {
                    case "id": w.id = j.nextString().intern(); break;
                    case "title": w.title = j.nextString(); break;
                    case "type": w.type = j.nextString().intern(); break;
                    case "year": w.year = (int) j.nextNumber(); break;
                    case "pop": w.pop = j.nextNumber(); break;
                    case "ambiguous": w.ambiguous = j.nextBoolean(); break;
                    case "aliases": w.aliases = strings(j); break;
                    case "characters": w.characters = strings(j); break;
                    case "other": w.other = strings(j); break;
                    default: j.skipValue();
                }
            }
            j.endObject();
            works.add(w);
        }
        j.endArray();
        return works;
    }

    private static String[] strings(Json j) throws IOException {
        List<String> l = new ArrayList<>();
        j.beginArray();
        while (j.hasNext()) l.add(j.nextString());
        j.endArray();
        return l.toArray(new String[0]);
    }

    static void writeWorks(StringBuilder o, List<Work> works) {
        o.append('[');
        for (int i = 0; i < works.size(); i++) {
            Work w = works.get(i);
            if (i > 0) o.append(',');
            o.append("{\"id\":"); Json.quote(o, w.id);
            o.append(",\"title\":"); Json.quote(o, w.title);
            o.append(",\"type\":"); Json.quote(o, w.type);
            o.append(",\"year\":").append(w.year == 0 ? "null" : String.valueOf(w.year));
            o.append(",\"aliases\":"); strs(o, w.aliases);
            o.append(",\"characters\":"); strs(o, w.characters);
            o.append(",\"pop\":").append(num(w.pop));
            o.append(",\"ambiguous\":").append(w.ambiguous);
            if (w.other.length > 0) { o.append(",\"other\":"); strs(o, w.other); }
            o.append('}');
        }
        o.append(']');
    }

    private static void strs(StringBuilder o, String[] a) {
        o.append('[');
        for (int i = 0; i < a.length; i++) { if (i > 0) o.append(','); Json.quote(o, a[i]); }
        o.append(']');
    }

    private static String num(double d) { return d == Math.rint(d) && Math.abs(d) < 1e15 ? String.valueOf((long) d) : String.valueOf(d); }

    // ---------- catalog-rules.js ----------

    static final String[] PRIORITY = {"anime", "tv", "movie", "game", "manga", "comic", "book"};
    static final int MIN_SITELINKS = 15, CHAR_MIN_POP = 40;
    private static final Pattern YEAR = Pattern.compile("^(\\d+)-");
    private static final Pattern NOT_WORD = Pattern.compile("[^\\p{L}\\p{N}]");

    static String qid(String uri) { return uri.substring(uri.lastIndexOf('/') + 1); }

    static int yearOf(String s) {
        java.util.regex.Matcher m = YEAR.matcher(s == null ? "" : s);
        if (!m.find()) return 0;
        try { return Integer.parseInt(m.group(1)); } catch (NumberFormatException e) { return 0; }
    }

    static String jsTrim(String s) {
        int a = 0, b = s.length();
        while (a < b && Matcher.jsSpace(s.charAt(a))) a++;
        while (b > a && Matcher.jsSpace(s.charAt(b - 1))) b--;
        return s.substring(a, b);
    }

    /** JS s.split(/\s+/) */
    static List<String> splitSpace(String s) {
        List<String> out = new ArrayList<>();
        int start = 0;
        for (int i = 0; i < s.length(); ) {
            if (!Matcher.jsSpace(s.charAt(i))) { i++; continue; }
            out.add(s.substring(start, i));
            while (i < s.length() && Matcher.jsSpace(s.charAt(i))) i++;
            start = i;
        }
        out.add(s.substring(start));
        return out;
    }

    static boolean cleanTitle(String t) {
        String s = jsTrim(t);
        boolean digits = !s.isEmpty();
        for (int i = 0; i < s.length() && digits; i++) digits = s.charAt(i) >= '0' && s.charAt(i) <= '9';
        return !digits && s.codePointCount(0, s.length()) > 1;
    }

    static final class Ambiguity {
        private final Set<String> common = new HashSet<>(), top1k = new HashSet<>();

        Ambiguity(String words) {
            List<String> lines = new ArrayList<>();
            for (String x : splitSpace(words)) if (!x.isEmpty()) lines.add(x);
            common.addAll(lines);
            top1k.addAll(lines.subList(0, Math.min(1000, lines.size())));
        }

        boolean test(String t) {
            List<String> w = new ArrayList<>();
            for (String x : splitSpace(t.toLowerCase(java.util.Locale.ROOT))) {
                String y = NOT_WORD.matcher(x).replaceAll("");
                if (!y.isEmpty()) w.add(y);
            }
            return t.codePointCount(0, t.length()) < 4 || (w.size() == 1 && common.contains(w.get(0))) ||
                (w.size() == 2 && top1k.contains(w.get(0)) && top1k.contains(w.get(1)));
        }
    }

    /** A delta candidate before finalisation. */
    static final class Raw {
        String id, title, type;
        List<Integer> years = new ArrayList<>();
        double pop;
    }

    /** aliasPairs: (label, 0 for en | 1 for mul); charPairs: (label, sitelinks). */
    static Work finalizeWork(Raw w, List<Object[]> aliasPairs, List<Object[]> charPairs, Ambiguity amb) {
        String tl = w.title.toLowerCase(java.util.Locale.ROOT);
        List<Object[]> ap = new ArrayList<>(aliasPairs == null ? Collections.emptyList() : aliasPairs);
        Collections.sort(ap, (a, b) -> Integer.compare((Integer) a[1], (Integer) b[1])); // en first, then mul (stable)
        Set<String> seen = new HashSet<>();
        List<String> aliases = new ArrayList<>();
        for (Object[] p : ap) {
            String a = (String) p[0], low = a.toLowerCase(java.util.Locale.ROOT);
            if (a.length() >= 3 && !low.equals(tl) && seen.add(low)) aliases.add(a);
        }
        if (aliases.size() > 8) Collections.sort(aliases, (a, b) -> a.length() - b.length()); // abbreviations first
        if (aliases.size() > 8) aliases = aliases.subList(0, 8);
        List<Object[]> cs = new ArrayList<>();
        for (Object[] p : charPairs == null ? Collections.<Object[]>emptyList() : charPairs) {
            String n = (String) p[0];
            if (splitSpace(jsTrim(n)).size() >= 2 && n.length() >= 6) cs.add(p);
        }
        Collections.sort(cs, (a, b) -> Double.compare((Double) b[1], (Double) a[1]));
        LinkedHashSet<String> chars = new LinkedHashSet<>();
        for (Object[] p : cs) chars.add((String) p[0]);
        Work out = new Work();
        out.id = w.id; out.title = w.title; out.type = w.type; out.pop = w.pop;
        for (int y : w.years) out.year = out.year == 0 ? y : Math.min(out.year, y);
        out.aliases = aliases.toArray(new String[0]);
        out.characters = new ArrayList<>(chars).subList(0, Math.min(8, chars.size())).toArray(new String[0]);
        out.ambiguous = amb.test(w.title);
        return out;
    }

    /** compareWorks: popularity, then QID in numeric order (localeCompare with numeric: true). */
    static int compareWorks(Work a, Work b) {
        int c = Double.compare(b.pop, a.pop);
        return c != 0 ? c : compareIds(a.id, b.id);
    }

    private static int compareIds(String a, String b) {
        // shortcut: assumes Wikidata ids ("Q" + digits) like every catalog entry; other ids fall back to plain order.
        if (a.length() > 1 && b.length() > 1 && a.charAt(0) == 'Q' && b.charAt(0) == 'Q') {
            try { return new BigInteger(a.substring(1)).compareTo(new BigInteger(b.substring(1))); } catch (NumberFormatException ignored) { }
        }
        return a.compareTo(b);
    }

    /** Bundled catalog + added works (deduped by QID, bundled wins), in the catalog's own order. */
    static List<Work> merge(List<Work> bundled, List<Work> added) {
        Set<String> known = new HashSet<>();
        for (Work w : bundled) known.add(w.id);
        LinkedHashMap<String, Work> extra = new LinkedHashMap<>();
        for (Work w : added) if (!known.contains(w.id)) extra.put(w.id, w);
        List<Work> all = new ArrayList<>(bundled);
        all.addAll(extra.values());
        Collections.sort(all, Catalog::compareWorks);
        return all;
    }

    // ---------- build-index.js ----------

    static final int COMMON_POP = 60;
    private static final Pattern SERIES_SPLIT = Pattern.compile(":| – | — | - ");
    private static final String[] ROMAN = {"ii", "iii", "iv", "v", "vi", "vii", "viii", "ix", "x", "xi", "xii", "xiii", "xiv", "xv", "xvi", "xvii", "xviii", "xix", "xx"};
    private static final Map<String, String> TO_ARABIC = new HashMap<>(), TO_ROMAN = new HashMap<>();
    static {
        for (int i = 0; i < ROMAN.length; i++) { TO_ARABIC.put(ROMAN[i], String.valueOf(i + 2)); TO_ROMAN.put(String.valueOf(i + 2), ROMAN[i]); }
    }
    private static final int[] RANK = new int[7];
    static {
        RANK[Matcher.TITLE] = 0; RANK[Matcher.SERIES] = 1; RANK[Matcher.ALIAS] = 2; RANK[Matcher.CHAR] = 3;
        RANK[Matcher.CHAR1] = 4; RANK[Matcher.PART] = 5; RANK[Matcher.TAG] = 6;
    }

    /** The common-word list (tools/catalog/20k.txt), in first-occurrence order like the JS Set. */
    static final class Words {
        final Set<String> common = new LinkedHashSet<>(), everyday = new HashSet<>(), top1k = new HashSet<>(), top3k = new HashSet<>();

        Words(String text) {
            for (String w : text.split("\n", -1)) common.add(jsTrim(w).toLowerCase(java.util.Locale.ROOT));
            int i = 0;
            for (String w : common) {
                if (i < 10000) everyday.add(w);
                if (i < 1000) top1k.add(w);
                if (i < 3000) top3k.add(w);
                if (++i >= 10000) break;
            }
        }

        boolean isCommon(String t) { return digits(t) || common.contains(t); }
    }

    private static boolean digits(String t) {
        if (t.isEmpty()) return false;
        for (int i = 0; i < t.length(); i++) if (t.charAt(i) < '0' || t.charAt(i) > '9') return false;
        return true;
    }

    private static String join(List<String> t, String sep) { return String.join(sep, t); }

    static String seriesPrefix(String title, Words words) {
        String[] parts = SERIES_SPLIT.split(title, -1);
        if (parts.length < 2) return null;
        String p = jsTrim(parts[0]);
        List<String> t = Matcher.tokenize(p).toks;
        if (t.isEmpty() || (t.size() == 1 && (t.get(0).length() < 4 || words.common.contains(t.get(0))))) return null;
        return p;
    }

    private static final class Variant {
        final String text; final boolean free, numbered, joined;
        Variant(String text, boolean free, boolean numbered, boolean joined) { this.text = text; this.free = free; this.numbered = numbered; this.joined = joined; }
    }

    private static boolean isSeq(String t, int j) { return j > 0 && (TO_ARABIC.containsKey(t) || TO_ROMAN.containsKey(t)); }

    private static List<Variant> nameVariants(String str, boolean low, Words words) {
        List<String> t = Matcher.tokenize(str).toks;
        boolean any = false;
        for (int j = 0; j < t.size() && !any; j++) any = isSeq(t.get(j), j);
        List<Variant> out = new ArrayList<>();
        if (!any) { out.add(new Variant(join(t, " "), false, false, false)); return out; }
        List<String> base = new ArrayList<>(), swapped = new ArrayList<>();
        for (int j = 0; j < t.size(); j++) {
            String x = t.get(j);
            if (!isSeq(x, j)) base.add(x);
            swapped.add(isSeq(x, j) ? (TO_ARABIC.containsKey(x) ? TO_ARABIC.get(x) : TO_ROMAN.get(x)) : x);
        }
        boolean free = base.size() >= 2 ? !low : base.size() == 1 && !words.everyday.contains(base.get(0)) && base.get(0).length() >= 3;
        boolean numbered = false;
        for (String b : base) if (!words.top1k.contains(b)) { numbered = true; break; }
        out.add(new Variant(join(t, " "), free, numbered, false));
        out.add(new Variant(join(swapped, " "), free, numbered, false));
        if (t.size() == 2 && isSeq(t.get(1), 1)) {
            out.add(new Variant(t.get(0) + t.get(1), free, numbered, true));
            out.add(new Variant(t.get(0) + swapped.get(1), free, numbered, true));
        }
        return out;
    }

    private static final class Key {
        int[] works = new int[2]; int n;
        int kind, amb, labelRank, g;
        String label;
        boolean free, numbered, oth = true;

        void add(int w) {
            for (int i = 0; i < n; i++) if (works[i] == w) return;
            if (n == works.length) works = Arrays.copyOf(works, n * 2);
            works[n++] = w;
        }
    }

    private static final class Group {
        final String label; final int[] ws;
        Group(String label, int[] ws) { this.label = label; this.ws = ws; }
    }

    /** index.bin bytes and index.json text, as tools/build-index.mjs writes them. */
    static final class Built {
        final byte[] bin; final String json;
        Built(byte[] bin, String json) { this.bin = bin; this.json = json; }
    }

    static Built buildIndex(List<Work> catalog, Words words) {
        List<Work> works = new ArrayList<>(catalog);
        Collections.sort(works, (a, b) -> Double.compare(b.pop, a.pop)); // stable, like Array.prototype.sort
        LinkedHashMap<String, Key> keys = new LinkedHashMap<>();

        Map<String, Integer> prefixCount = new HashMap<>();
        String[] prefix = new String[works.size()];
        for (int i = 0; i < works.size(); i++) {
            String p = prefix[i] = seriesPrefix(works.get(i).title, words);
            if (p != null) prefixCount.merge(join(Matcher.tokenize(p).toks, " "), 1, Integer::sum);
        }
        String[] seriesOf = new String[works.size()];
        for (int i = 0; i < works.size(); i++) {
            Work w = works.get(i);
            boolean low = w.pop < COMMON_POP;
            Set<String> other = new HashSet<>(Arrays.asList(w.other));
            boolean ot = other.contains(w.title);
            for (String f : possessive(w.title)) for (Variant v : nameVariants(f, low, words)) {
                add(keys, works, words, v.text, i, v.joined ? Matcher.ALIAS : Matcher.TITLE, w.title, v.free, v.numbered, ot);
                if (!v.joined && v.text.contains(" ")) add(keys, works, words, v.text, i, Matcher.TAG, w.title, false, false, ot);
            }
            String p = prefix[i];
            if (p != null && prefixCount.get(join(Matcher.tokenize(p).toks, " ")) >= 2) {
                add(keys, works, words, p, i, Matcher.SERIES, p, false, false, other.contains(p));
                add(keys, works, words, p, i, Matcher.TAG, p, false, false, other.contains(p));
                seriesOf[i] = p;
            }
            for (String a : w.aliases) for (String f : possessive(a)) for (Variant v : nameVariants(f, low, words)) add(keys, works, words, v.text, i, Matcher.ALIAS, w.title, v.free, v.numbered, other.contains(a));
            for (String c : w.characters) {
                add(keys, works, words, c, i, Matcher.CHAR, w.title, false, false, other.contains(c));
                List<String> parts = Matcher.tokenize(c).toks;
                if (parts.size() > 1) for (String t : parts) if (t.length() >= 4 && !words.isCommon(t)) add(keys, works, words, t, i, Matcher.PART, w.title, false, false, false);
            }
        }

        Map<String, Integer> gmap = new HashMap<>();
        List<Group> groups = new ArrayList<>();
        for (Key e : keys.values()) {
            int[] ws = Arrays.copyOf(e.works, e.n);
            Arrays.sort(ws);
            if (e.labelRank > RANK[Matcher.SERIES] && ws.length > 1 && seriesOf[ws[0]] != null) {
                String sl = seriesOf[ws[0]];
                int same = 0;
                for (int w : ws) if (sl.equals(seriesOf[w]) || works.get(w).title.equals(sl)) same++;
                if (same * 2 >= ws.length) e.label = sl; // majority
            }
            StringBuilder id = new StringBuilder(e.label).append('\u0001');
            for (int k = 0; k < ws.length; k++) { if (k > 0) id.append(','); id.append(ws[k]); }
            Integer g = gmap.get(id.toString());
            if (g == null) { gmap.put(id.toString(), g = groups.size()); groups.add(new Group(e.label, ws)); }
            e.g = g;
        }
        gmap = null;
        Integer[] order = new Integer[groups.size()];
        for (int i = 0; i < order.length; i++) order[i] = i;
        Arrays.sort(order, (a, b) -> {
            int c = groups.get(a).ws[0] - groups.get(b).ws[0];
            return c != 0 ? c : groups.get(b).ws.length - groups.get(a).ws.length;
        });
        int[] newIdx = new int[groups.size()];
        for (int i = 0; i < order.length; i++) newIdx[order[i]] = i;

        int n = keys.size(), bits = 4;
        while ((1 << bits) < n * 1.6) bits++;
        int slots = 1 << bits, mask = slots - 1;
        int[] u = new int[3 + slots * 3];
        u[0] = Matcher.MAGIC; u[1] = bits; u[2] = 1; // index format 1
        for (Map.Entry<String, Key> en : keys.entrySet()) {
            Key e = en.getValue();
            String[] t = en.getKey().split(" ", -1);
            boolean low = works.get(groups.get(e.g).ws[0]).pop < COMMON_POP;
            boolean titleLike = e.kind == Matcher.TITLE || e.kind == Matcher.ALIAS || e.kind == Matcher.SERIES, one = t.length == 1;
            boolean allCommon = true;
            for (String x : t) if (!words.isCommon(x)) { allCommon = false; break; }
            // "The Sheep", "Thing One": everyday words only, treated like such a title
            boolean top3 = true;
            for (String x : t) if (!words.top3k.contains(x)) { top3 = false; break; }
            boolean plainChar = e.kind == Matcher.CHAR && allCommon && (t[0].equals("the") || top3);
            boolean common = plainChar || titleLike && !e.free && !e.numbered &&
                (one ? digits(t[0]) || (words.isCommon(t[0]) && (low || e.kind != Matcher.TITLE || words.top3k.contains(t[0]))) : low && allCommon);
            boolean cap = plainChar || titleLike && !e.free && (one || low || allCommon);
            boolean rare = titleLike && one && low && !common && !e.free;
            boolean other = e.oth && e.kind != Matcher.PART && e.kind != Matcher.CHAR1;
            int v = (newIdx[e.g] << 8) | (rare ? 1 << 7 : 0) | (cap ? 1 << 6 : 0) | (common ? 1 << 5 : 0) | (e.amb << 4) | (other ? 1 << 3 : 0) | e.kind;
            // buildIndexBinary: linear probing in insertion order
            int A = Matcher.SEED_A, B = Matcher.SEED_B;
            for (String tok : t) { int[] h = Matcher.tokHash(tok); A = Matcher.mixA(A, h[0]); B = Matcher.mixB(B, h[1]); }
            int s = A & mask;
            while (u[3 + s * 3 + 2] != 0) s = (s + 1) & mask;
            u[3 + s * 3] = A; u[3 + s * 3 + 1] = B; u[3 + s * 3 + 2] = v + 1;
        }
        keys = null;
        ByteBuffer bb = ByteBuffer.allocate(u.length * 4).order(ByteOrder.LITTLE_ENDIAN);
        bb.asIntBuffer().put(u);
        u = null;

        StringBuilder o = new StringBuilder(2 << 20);
        o.append("{\"ids\":[");
        for (int i = 0; i < works.size(); i++) { if (i > 0) o.append(','); Json.quote(o, works.get(i).id); }
        o.append("],\"titles\":[");
        for (int i = 0; i < works.size(); i++) { if (i > 0) o.append(','); Json.quote(o, works.get(i).title); }
        o.append("],\"types\":[");
        for (int i = 0; i < works.size(); i++) { if (i > 0) o.append(','); Json.quote(o, works.get(i).type); }
        o.append("],\"years\":[");
        for (int i = 0; i < works.size(); i++) { if (i > 0) o.append(','); o.append(works.get(i).year); }
        o.append("],\"groups\":[");
        for (int i = 0; i < order.length; i++) {
            Group g = groups.get(order[i]);
            if (i > 0) o.append(',');
            o.append('[');
            Json.quote(o, g.label);
            for (int w : g.ws) o.append(',').append(w);
            o.append(']');
        }
        o.append("]}");
        return new Built(bb.array(), o.toString());
    }

    // the tokenizer splits at an apostrophe; text written without it ("Schindlers List") needs the joined form too
    private static final Pattern APOSTROPHE = Pattern.compile("['’]");

    private static List<String> possessive(String s) {
        if (!APOSTROPHE.matcher(s).find()) return Collections.singletonList(s);
        return Arrays.asList(s, APOSTROPHE.matcher(s).replaceAll(""));
    }

    private static void add(Map<String, Key> keys, List<Work> works, Words words, String str, int w, int kind, String label, boolean free, boolean numbered, boolean oth) {
        List<String> t = Matcher.tokenize(str).toks;
        if (t.isEmpty() || t.size() > Matcher.MAX_N || (t.size() == 1 && t.get(0).length() < 2)) return;
        if ((kind == Matcher.CHAR || kind == Matcher.PART) && t.size() == 1) {
            if (t.get(0).length() < 4) return;
            if (kind == Matcher.CHAR) kind = Matcher.CHAR1;
        }
        if (kind == Matcher.ALIAS && t.size() == 1 && words.isCommon(t.get(0))) return; // "Ultimate", "Family": never evidence
        String key = join(t, kind == Matcher.TAG ? "" : " ");
        Key e = keys.get(key);
        if (e == null) {
            keys.put(key, e = new Key());
            e.kind = kind; e.label = label; e.labelRank = RANK[kind];
        }
        e.add(w);
        if (kind != Matcher.PART && kind != Matcher.CHAR1) e.oth &= oth;
        if (free) e.free = true;
        if (numbered) e.numbered = true;
        if (RANK[kind] < RANK[e.kind]) e.kind = kind;
        if (RANK[kind] < e.labelRank) { e.label = label; e.labelRank = RANK[kind]; }
        if ((kind == Matcher.TITLE || kind == Matcher.ALIAS) && works.get(w).ambiguous) e.amb = 1;
    }

    static byte[] utf8(String s) { return s.getBytes(StandardCharsets.UTF_8); }
}
