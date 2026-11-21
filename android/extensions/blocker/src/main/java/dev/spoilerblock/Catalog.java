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
    /** One work in the catalog schema: { id, title, type, year, aliases, characters, pop, ambiguous, other?, series? }. */
    static final class Work {
        String id, title, type;
        int year; // 0 = null
        String[] aliases = new String[0], characters = new String[0];
        String[] other = new String[0]; // names that mostly mean something else (tools/catalog/build.mjs)
        String[] series = new String[0]; // the catalog series it belongs to (tools/catalog/series.mjs)
        double pop;
        boolean ambiguous;
    }

    // ---------- catalog.json (streamed) ----------

    /** The catalog's works, plus its `series` table: { seriesId: [label, ...ids mapped to it] } (series.mjs). */
    static final class Works extends ArrayList<Work> {
        final LinkedHashMap<String, String[]> series = new LinkedHashMap<>();
    }

    static Works readWorks(Reader r) throws IOException {
        Json j = new Json(r);
        Works works = null;
        LinkedHashMap<String, String[]> series = new LinkedHashMap<>();
        j.beginObject();
        while (j.hasNext()) {
            String k = j.nextName();
            if (k.equals("works")) { works = new Works(); works.addAll(readWorkArray(j)); }
            else if (k.equals("series")) {
                j.beginObject();
                while (j.hasNext()) { String id = j.nextName(); series.put(id, strings(j)); }
                j.endObject();
            } else j.skipValue();
        }
        j.endObject();
        if (works == null) throw new IOException("catalog has no works");
        works.series.putAll(series);
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
                    case "series": w.series = strings(j); break;
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
            if (w.series.length > 0) { o.append(",\"series\":"); strs(o, w.series); }
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

    static final int COMMON_POP = 60, DISTINCT_POP = 45;
    private static final Pattern SERIES_SPLIT = Pattern.compile(":| – | — | - ");
    private static final String[] ROMAN = {"ii", "iii", "iv", "v", "vi", "vii", "viii", "ix", "x", "xi", "xii", "xiii", "xiv", "xv", "xvi", "xvii", "xviii", "xix", "xx"};
    private static final Map<String, String> TO_ARABIC = new HashMap<>(), TO_ROMAN = new HashMap<>();
    static {
        for (int i = 0; i < ROMAN.length; i++) { TO_ARABIC.put(ROMAN[i], String.valueOf(i + 2)); TO_ROMAN.put(String.valueOf(i + 2), ROMAN[i]); }
    }
    private static final int[] RANK = new int[8];
    static {
        RANK[Matcher.TITLE] = 0; RANK[Matcher.SERIES] = 1; RANK[Matcher.ALIAS] = 2; RANK[Matcher.ACRONYM] = 2; RANK[Matcher.CHAR] = 3;
        RANK[Matcher.CHAR1] = 4; RANK[Matcher.PART] = 5; RANK[Matcher.TAG] = 6;
    }
    // an alias written in capitals, 2+ letters ("GTA", "GOT")
    private static final Pattern ACRO = Pattern.compile("^\\p{Lu}{2,}$");

    /** The common-word list (tools/catalog/common-words.txt), in first-occurrence order like the JS Set. */
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
        final String text; final boolean free, numbered, joined, orig;
        Variant(String text, boolean free, boolean numbered, boolean joined, boolean orig) { this.text = text; this.free = free; this.numbered = numbered; this.joined = joined; this.orig = orig; }
    }

    private static boolean isSeq(String t, int j) { return j > 0 && (TO_ARABIC.containsKey(t) || TO_ROMAN.containsKey(t)); }

    private static List<Variant> nameVariants(String str, boolean low, Words words) {
        List<String> t = Matcher.tokenize(str).toks;
        boolean any = false;
        for (int j = 0; j < t.size() && !any; j++) any = isSeq(t.get(j), j);
        List<Variant> out = new ArrayList<>();
        if (!any) { out.add(new Variant(join(t, " "), false, false, false, true)); return out; }
        List<String> base = new ArrayList<>(), swapped = new ArrayList<>();
        for (int j = 0; j < t.size(); j++) {
            String x = t.get(j);
            if (!isSeq(x, j)) base.add(x);
            swapped.add(isSeq(x, j) ? (TO_ARABIC.containsKey(x) ? TO_ARABIC.get(x) : TO_ROMAN.get(x)) : x);
        }
        boolean free = base.size() >= 2 ? !low : base.size() == 1 && !words.everyday.contains(base.get(0)) && base.get(0).length() >= 3;
        boolean numbered = false;
        for (String b : base) if (!words.top1k.contains(b)) { numbered = true; break; }
        out.add(new Variant(join(t, " "), free, numbered, false, true));
        out.add(new Variant(join(swapped, " "), free, numbered, false, false));
        if (t.size() == 2 && isSeq(t.get(1), 1)) {
            out.add(new Variant(t.get(0) + t.get(1), free, numbered, true, false));
            out.add(new Variant(t.get(0) + swapped.get(1), free, numbered, true, false));
        }
        return out;
    }

    private static final class Key {
        int[] works = new int[2]; int n;
        int kind, amb, labelRank, g;
        String label;
        boolean free, numbered, oth = true, orig;
        // works per tier: 0 title, 1 alternative name, 2 derived series, 3 character, 4 part of a character's name
        @SuppressWarnings("unchecked") final Set<Integer>[] tiers = new Set[5];

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

    // build-index.js usedAcronym: the initials of the title (without a leading "The", or of its last part after a colon),
    // or the title spelled with stops ("W.I.T.C.H."); a work of DISTINCT_POP, COMMON_POP when the capitals are an
    // everyday word of the 10k most frequent
    private static boolean usedAcronym(String a, Work w, Words words) {
        String x = a.toLowerCase(java.util.Locale.ROOT);
        String[] parts = SERIES_SPLIT.split(w.title, -1);
        List<List<String>> forms = Arrays.asList(Matcher.tokenize(w.title).toks, Matcher.tokenize(parts[parts.length - 1]).toks);
        boolean ok = join(forms.get(0), "").equals(x);
        for (List<String> t : forms) {
            for (List<String> u : Arrays.asList(t, !t.isEmpty() && t.get(0).equals("the") ? t.subList(1, t.size()) : t)) {
                StringBuilder b = new StringBuilder();
                for (String y : u) b.append(y.charAt(0));
                ok |= b.toString().equals(x);
            }
        }
        return ok && w.pop >= (words.everyday.contains(x) ? COMMON_POP : DISTINCT_POP);
    }

    static Built buildIndex(List<Work> catalog, Words words) {
        List<Work> works = new ArrayList<>(catalog);
        Collections.sort(works, (a, b) -> Double.compare(b.pop, a.pop)); // stable, like Array.prototype.sort
        LinkedHashMap<String, Key> keys = new LinkedHashMap<>();

        Map<String, Integer> prefixCount = new HashMap<>();
        String[] prefix = new String[works.size()];
        boolean[] colon = new boolean[works.size()];
        for (int i = 0; i < works.size(); i++) {
            String p = seriesPrefix(works.get(i).title, words);
            colon[i] = p != null;
            if (p == null) p = numberedStem(works.get(i).title);
            prefix[i] = p;
            if (p != null) prefixCount.merge(join(Matcher.tokenize(p).toks, " "), 1, Integer::sum);
        }
        // the series names that qualify; "Halo: Reach" joins "Halo" (from "Halo 2", "Halo 3"...) though "Halo" is an everyday word
        Set<String> qualified = new HashSet<>();
        for (int i = 0; i < works.size(); i++) {
            if (prefix[i] == null) continue;
            String k = join(Matcher.tokenize(prefix[i]).toks, " ");
            if (prefixCount.get(k) >= (colon[i] ? 2 : 3)) qualified.add(k);
        }
        String[] seriesOf = new String[works.size()];
        List<Object[]> acronyms = new ArrayList<>(); // {alias, work, label, other}: everyday-word aliases in capitals, added last
        for (int i = 0; i < works.size(); i++) {
            Work w = works.get(i);
            boolean low = w.pop < COMMON_POP;
            Set<String> other = new HashSet<>(Arrays.asList(w.other));
            boolean ot = other.contains(w.title);
            for (String f : possessive(w.title)) for (Variant v : nameVariants(f, low, words)) {
                add(keys, works, words, v.text, i, v.joined ? Matcher.ALIAS : Matcher.TITLE, w.title, v.free, v.numbered, ot, v.orig, 0);
                if (!v.joined && v.text.contains(" ")) add(keys, works, words, v.text, i, Matcher.TAG, w.title, false, false, ot, true, 0);
            }
            String p = prefix[i]; // a colon prefix shared by 2+ titles, or a name numbered in 3+ titles ("Battlefield")
            if (p == null) {
                String raw = jsTrim(SERIES_SPLIT.split(w.title, -1)[0]);
                if (!raw.equals(jsTrim(w.title)) && qualified.contains(join(Matcher.tokenize(raw).toks, " "))) p = raw;
            }
            if (p != null && qualified.contains(join(Matcher.tokenize(p).toks, " "))) {
                add(keys, works, words, p, i, Matcher.SERIES, p, false, false, other.contains(p));
                add(keys, works, words, p, i, Matcher.TAG, p, false, false, other.contains(p), true, 2);
                seriesOf[i] = p;
            }
            for (String a : w.aliases) {
                // "GTA", "GOT": as an alias an everyday word, kept as an acronym that matches only in capitals (added below)
                if (ACRO.matcher(a).matches() && words.isCommon(Matcher.tokenize(a).toks.get(0)) && usedAcronym(a, w, words)) acronyms.add(new Object[]{a, i, w.title, other.contains(a)});
                for (String f : possessive(a)) for (Variant v : nameVariants(f, low, words)) add(keys, works, words, v.text, i, Matcher.ALIAS, w.title, v.free, v.numbered, other.contains(a), v.orig);
            }
            for (String c : w.characters) {
                add(keys, works, words, c, i, Matcher.CHAR, w.title, false, false, other.contains(c));
                List<String> parts = Matcher.tokenize(c).toks;
                if (parts.size() > 1) for (String t : parts) if (t.length() >= 4 && !words.isCommon(t)) add(keys, works, words, t, i, Matcher.PART, w.title, false, false, false);
            }
        }
        // a subtitle names its work ("Tears of the Kingdom"): the last part after a colon or dash, of 3+ words or of 2 that
        // are not both everyday words, carried by no other title and no other name; its other senses were never looked
        // up, so it counts as "other" (build-index.js)
        LinkedHashMap<String, Object[]> subs = new LinkedHashMap<>(); // key -> {subtitle, work, label}, null when several titles carry it
        for (int i = 0; i < works.size(); i++) {
            String[] parts = SERIES_SPLIT.split(works.get(i).title, -1);
            if (parts.length < 2) continue;
            String sub = jsTrim(parts[parts.length - 1]);
            List<String> t = Matcher.tokenize(sub).toks;
            boolean allCommon = true;
            for (String x : t) allCommon &= words.isCommon(x);
            if (t.size() < 2 || t.size() > Matcher.MAX_N || (t.size() == 2 && allCommon)) continue;
            String k = join(t, " ");
            subs.put(k, subs.containsKey(k) ? null : new Object[]{sub, i, works.get(i).title});
        }
        for (Map.Entry<String, Object[]> x : subs.entrySet()) {
            Object[] a = x.getValue();
            if (a != null && !keys.containsKey(x.getKey())) add(keys, works, words, (String) a[0], (Integer) a[1], Matcher.ALIAS, (String) a[2], false, false, true);
        }
        // an acronym only where no other name has the same key ("FRIENDS" stays the show Friends)
        for (Object[] a : acronyms) {
            Key k = keys.get(Matcher.tokenize((String) a[0]).toks.get(0));
            if (k == null || k.kind == Matcher.ACRONYM) add(keys, works, words, (String) a[0], (Integer) a[1], Matcher.ACRONYM, (String) a[2], false, false, (Boolean) a[3]);
        }

        Map<String, Integer> gmap = new HashMap<>();
        List<Group> groups = new ArrayList<>();
        List<Object[]> typed = new ArrayList<>(); // {typed key, label, works, group}: a type word narrows ("the Minecraft movie")
        for (Map.Entry<String, Key> en : keys.entrySet()) {
            Key e = en.getValue();
            int[] ws = sorted(closest(e, works));
            if (e.labelRank > RANK[Matcher.SERIES] && ws.length > 1 && seriesOf[ws[0]] != null) {
                String sl = seriesOf[ws[0]];
                int same = 0;
                for (int w : ws) if (sl.equals(seriesOf[w]) || works.get(w).title.equals(sl)) same++;
                if (same * 2 >= ws.length) e.label = sl; // majority
            }
            if (e.kind != Matcher.TAG && (e.tiers[0] != null || e.tiers[1] != null || e.tiers[2] != null)) {
                Set<Integer> all = new HashSet<>();
                for (int k = 0; k < 3; k++) if (e.tiers[k] != null) all.addAll(e.tiers[k]);
                for (String type : PRIORITY_TYPES) {
                    // the closest works of that type, else any works of that type the name belongs to ("Minecraft movie")
                    List<Integer> tw = new ArrayList<>();
                    for (int w : ws) if (works.get(w).type.equals(type)) tw.add(w);
                    if (tw.isEmpty()) {
                        for (int w : all) if (works.get(w).type.equals(type)) tw.add(w);
                        Collections.sort(tw);
                    }
                    if (tw.isEmpty() || tw.size() == ws.length && sameWorks(tw, ws)) continue;
                    int[] twa = new int[tw.size()];
                    for (int k = 0; k < twa.length; k++) twa[k] = tw.get(k);
                    typed.add(new Object[]{en.getKey() + " \u0002" + type, twa.length == 1 ? works.get(twa[0]).title : e.label, twa, null});
                }
            }
            // an acronym names what its works' title names when those titles name one group (build-index.js); acronyms
            // come after every other key, so the title keys have their group
            Integer tg = null;
            boolean one = e.kind == Matcher.ACRONYM;
            for (int k = 0; k < e.n && one; k++) {
                Key t = keys.get(join(Matcher.tokenize(works.get(e.works[k]).title).toks, " "));
                if (t == null || (tg != null && tg != t.g)) one = false;
                else tg = t.g;
            }
            e.g = one ? tg : groupOf(gmap, groups, e.label, ws);
        }
        for (Object[] x : typed) x[3] = groupOf(gmap, groups, (String) x[1], (int[]) x[2]);
        gmap = null;
        Integer[] order = new Integer[groups.size()];
        for (int i = 0; i < order.length; i++) order[i] = i;
        Arrays.sort(order, (a, b) -> {
            int c = groups.get(a).ws[0] - groups.get(b).ws[0];
            return c != 0 ? c : groups.get(b).ws.length - groups.get(a).ws.length;
        });
        int[] newIdx = new int[groups.size()];
        for (int i = 0; i < order.length; i++) newIdx[order[i]] = i;

        int n = keys.size() + typed.size(), bits = 4;
        while ((1 << bits) < n * 1.6) bits++;
        int slots = 1 << bits, mask = slots - 1;
        int[] u = new int[3 + slots * 3];
        u[0] = Matcher.MAGIC; u[1] = bits; u[2] = 3; // index format 3
        // fame (build-index.js): a franchise is as known as its works together, numbered sequels and subtitled entries
        Map<String, List<Integer>> startsWith = new HashMap<>();
        for (int i = 0; i < works.size(); i++) if (prefix[i] != null) startsWith.computeIfAbsent(join(Matcher.tokenize(prefix[i]).toks, " "), x -> new ArrayList<>()).add(i);
        for (Map.Entry<String, Key> en : keys.entrySet()) {
            Key e = en.getValue();
            String[] t = en.getKey().split(" ", -1);
            int best = Integer.MAX_VALUE; // the name's most popular work at any tier
            for (int k = 0; k < e.n; k++) best = Math.min(best, e.works[k]);
            double top = works.get(best).pop;
            boolean low = top < COMMON_POP;
            boolean titleLike = e.kind == Matcher.TITLE || e.kind == Matcher.ALIAS || e.kind == Matcher.SERIES || e.kind == Matcher.ACRONYM, one = t.length == 1;
            boolean allCommon = true;
            for (String x : t) if (!words.isCommon(x)) { allCommon = false; break; }
            // "The Sheep", "Thing One": everyday words only, treated like such a title
            boolean top3 = true;
            for (String x : t) if (!words.top3k.contains(x)) { top3 = false; break; }
            boolean plainChar = e.kind == Matcher.CHAR && allCommon && (t[0].equals("the") || top3);
            boolean numeric = true; // "10.5", "1917": need a media word or quotes
            for (String x : t) if (hasLetter(x)) { numeric = false; break; }
            boolean common = plainChar || titleLike && (numeric || !e.free && !e.numbered &&
                (one ? words.isCommon(t[0]) && (low || e.kind != Matcher.TITLE || words.top3k.contains(t[0]))
                    : low && allCommon && !famous(t, e, startsWith.get(en.getKey()), works)));
            boolean cap = plainChar || titleLike && !e.free && (one || low || allCommon);
            boolean rare = titleLike && one && top < DISTINCT_POP && !common && !e.free;
            boolean other = e.oth && e.kind != Matcher.PART && e.kind != Matcher.CHAR1;
            // strong enough in text read from pictures (see build-index.js)
            List<String> real = new ArrayList<>();
            for (String x : t) if (x.length() >= 3 && allLetters(x) && !LIGHT.contains(x)) real.add(x);
            String last = t[t.length - 1];
            boolean num = t.length >= 2 && (digits(last) || TO_ARABIC.containsKey(last)), numOk = false;
            if (num) for (String x : real) if (x.length() >= 4 && !words.top3k.contains(x)) { numOk = true; break; }
            boolean ocr = e.orig && !other && t.length >= 2 && (titleLike || e.kind == Matcher.CHAR) &&
                (real.size() >= 2 && !(e.amb == 1 && low) || real.size() == 1 && !low && !words.isCommon(real.get(0)) || numOk);
            ocr |= titleLike && one && (words.top1k.contains(t[0]) || top < DISTINCT_POP && words.isCommon(t[0])); // on a one-word name the bit says "quiet" (see build-index.js)
            int v = (newIdx[e.g] << 9) | (ocr ? 1 << 8 : 0) | (rare ? 1 << 7 : 0) | (cap ? 1 << 6 : 0) | (common ? 1 << 5 : 0) | (e.amb == 1 && !famous(t, e, startsWith.get(en.getKey()), works) ? 1 << 4 : 0) | (other ? 1 << 3 : 0) | e.kind;
            // buildIndexBinary: linear probing in insertion order
            int A = Matcher.SEED_A, B = Matcher.SEED_B;
            for (String tok : t) { int[] h = Matcher.tokHash(tok); A = Matcher.mixA(A, h[0]); B = Matcher.mixB(B, h[1]); }
            int s = A & mask;
            while (u[3 + s * 3 + 2] != 0) s = (s + 1) & mask;
            u[3 + s * 3] = A; u[3 + s * 3 + 1] = B; u[3 + s * 3 + 2] = v + 1;
        }
        for (Object[] x : typed) { // looked up only next to a type word
            int A = Matcher.SEED_A, B = Matcher.SEED_B;
            for (String tok : ((String) x[0]).split(" ", -1)) { int[] h = Matcher.tokHash(tok); A = Matcher.mixA(A, h[0]); B = Matcher.mixB(B, h[1]); }
            int s = A & mask;
            while (u[3 + s * 3 + 2] != 0) s = (s + 1) & mask;
            u[3 + s * 3] = A; u[3 + s * 3 + 1] = B; u[3 + s * 3 + 2] = ((newIdx[(Integer) x[3]] << 9) | Matcher.TITLE) + 1;
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
        // series (build-index.js): the works of each series with 2+ works, oldest first (no year last), in order of
        // each series' most popular work
        LinkedHashMap<String, List<Integer>> bySeries = new LinkedHashMap<>();
        for (int i = 0; i < works.size(); i++) for (String s : works.get(i).series) bySeries.computeIfAbsent(s, x -> new ArrayList<>()).add(i);
        o.append("],\"series\":[");
        boolean first = true;
        for (List<Integer> l : bySeries.values()) {
            if (l.size() < 2) continue;
            l.sort((a, b) -> {
                int ya = works.get(a).year != 0 ? works.get(a).year : 10000, yb = works.get(b).year != 0 ? works.get(b).year : 10000;
                return ya != yb ? ya - yb : a - b;
            });
            if (!first) o.append(',');
            first = false;
            o.append('[');
            for (int k = 0; k < l.size(); k++) { if (k > 0) o.append(','); o.append(l.get(k)); }
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
        add(keys, works, words, str, w, kind, label, free, numbered, oth, true);
    }

    private static void add(Map<String, Key> keys, List<Work> works, Words words, String str, int w, int kind, String label, boolean free, boolean numbered, boolean oth, boolean orig) {
        add(keys, works, words, str, w, kind, label, free, numbered, oth, orig, TIER[kind]);
    }

    // tier: how close the name is to work w (see build-index.js); the default comes from the kind as passed
    private static void add(Map<String, Key> keys, List<Work> works, Words words, String str, int w, int kind, String label, boolean free, boolean numbered, boolean oth, boolean orig, int tier) {
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
        if (e.tiers[tier] == null) e.tiers[tier] = new HashSet<>();
        e.tiers[tier].add(w);
        if (kind != Matcher.PART && kind != Matcher.CHAR1) e.oth &= oth;
        if (free) e.free = true;
        if (numbered) e.numbered = true;
        if (orig) e.orig = true;
        if (RANK[kind] < RANK[e.kind]) e.kind = kind;
        if (RANK[kind] < e.labelRank) { e.label = label; e.labelRank = RANK[kind]; }
        if ((kind == Matcher.TITLE || kind == Matcher.ALIAS) && works.get(w).ambiguous) e.amb = 1;
    }

    static byte[] utf8(String s) { return s.getBytes(StandardCharsets.UTF_8); }

    private static final int[] TIER = new int[8];
    static {
        TIER[Matcher.TITLE] = 0; TIER[Matcher.ALIAS] = 1; TIER[Matcher.ACRONYM] = 1; TIER[Matcher.SERIES] = 2; TIER[Matcher.CHAR] = 3;
        TIER[Matcher.CHAR1] = 4; TIER[Matcher.PART] = 4; TIER[Matcher.TAG] = 1;
    }
    private static final String[] PRIORITY_TYPES = {"movie", "tv", "game", "book", "anime", "manga", "comic"};

    private static double pop(Set<Integer> set, List<Work> works) {
        double m = Double.NEGATIVE_INFINITY;
        for (int w : set) m = Math.max(m, works.get(w).pop);
        return m;
    }

    /** The works a bare name refers to: its closest tier, plus its series for a franchise name (see build-index.js). */
    private static Set<Integer> closest(Key e, List<Work> works) {
        int k = 0;
        while (e.tiers[k] == null) k++;
        Set<Integer> s = e.tiers[2];
        if (k < 2 && s != null && (s.containsAll(e.tiers[k]) || pop(s, works) >= 1.5 * pop(e.tiers[k], works))) {
            Set<Integer> u = new HashSet<>(e.tiers[k]);
            u.addAll(s);
            return u;
        }
        return e.tiers[k];
    }

    private static int[] sorted(Set<Integer> set) {
        int[] a = new int[set.size()];
        int i = 0;
        for (int w : set) a[i++] = w;
        Arrays.sort(a);
        return a;
    }

    private static boolean sameWorks(List<Integer> a, int[] b) {
        for (int i = 0; i < b.length; i++) if (a.get(i) != b[i]) return false;
        return true;
    }

    /** build-index.js famous: a known franchise of 2+ words, not "The" + one word, with a later word of 3+ letters. */
    private static boolean famous(String[] t, Key e, List<Integer> startsWith, List<Work> works) {
        if (t.length < 2 || t[0].equals("the") && t.length == 2) return false;
        boolean longer = false;
        for (int i = 1; i < t.length; i++) longer |= t[i].length() >= 3;
        return longer && fame(e, startsWith, works) >= COMMON_POP;
    }

    /** build-index.js fame: the popularity of a name's title, alias and series works plus its sequels (startsWith). */
    private static double fame(Key e, List<Integer> startsWith, List<Work> works) {
        Set<Integer> ws = new HashSet<>();
        for (int k = 0; k < 3; k++) if (e.tiers[k] != null) ws.addAll(e.tiers[k]);
        if (startsWith != null) ws.addAll(startsWith);
        double sum = 0;
        for (int w : ws) sum += works.get(w).pop;
        return sum;
    }

    private static int groupOf(Map<String, Integer> gmap, List<Group> groups, String label, int[] ws) {
        StringBuilder id = new StringBuilder(label).append('\u0001');
        for (int k = 0; k < ws.length; k++) { if (k > 0) id.append(','); id.append(ws[k]); }
        Integer g = gmap.get(id.toString());
        if (g == null) { gmap.put(id.toString(), g = groups.size()); groups.add(new Group(label, ws)); }
        return g;
    }

    // function words that do not make a name strong in text read from pictures
    private static final Set<String> LIGHT = new HashSet<>(Arrays.asList(
        "the and for you are was his her its our not but all any who how why what with from this that new one two".split(" ")));

    private static boolean allLetters(String s) {
        if (s.isEmpty()) return false;
        for (int i = 0; i < s.length(); ) { int c = s.codePointAt(i); if (!Character.isLetter(c)) return false; i += Character.charCount(c); }
        return true;
    }

    private static boolean hasLetter(String s) {
        for (int i = 0; i < s.length(); ) { int c = s.codePointAt(i); if (Character.isLetter(c)) return true; i += Character.charCount(c); }
        return false;
    }

    /** "Battlefield" of "Battlefield 4" or "Battlefield V": the title without a final number, or null (see the JS). */
    static String numberedStem(String title) {
        String t = jsTrim(title);
        int k = t.length();
        while (k > 0 && !Matcher.jsSpace(t.charAt(k - 1))) k--;
        if (k == 0) return null;
        String n = t.substring(k);
        int j = k;
        while (j > 0 && Matcher.jsSpace(t.charAt(j - 1))) j--;
        if (j == 0 || n.isEmpty()) return null;
        boolean ok = digits(n) || n.matches("[IVXivx]+") && TO_ARABIC.containsKey(n.toLowerCase(java.util.Locale.ROOT));
        if (!ok) return null;
        String stem = t.substring(0, j);
        for (String x : Matcher.tokenize(stem).toks) if (x.length() >= 4 && allLetters(x)) return stem;
        return null;
    }
}
