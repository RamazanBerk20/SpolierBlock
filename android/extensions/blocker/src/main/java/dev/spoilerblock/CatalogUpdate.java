package dev.spoilerblock;

import java.io.ByteArrayOutputStream;
import java.io.DataInputStream;
import java.io.DataOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.io.StringReader;
import java.net.HttpURLConnection;
import java.net.URL;
import java.net.URLEncoder;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.regex.Pattern;

/**
 * Port of src/background/catalog-update.js: the opt-in catalog refresh and the ONLY network use of the blocker.
 * Fetches works dated since the year before the bundled catalog was built from Wikidata's public SPARQL endpoint
 * (only the query is sent), merges them with the bundled catalog and rebuilds the index with Catalog.buildIndex.
 */
final class CatalogUpdate {
    static final String ENDPOINT = "https://query.wikidata.org/sparql";
    static final String[] DATE_PROPS = {"P577", "P580", "P571"};

    /** One HTTP exchange; the default sends a form POST with no cookies of ours and a generic User-Agent. */
    interface Transport { Response post(String endpoint, String formBody) throws IOException; }

    static final class Response {
        final int status; final String body, retryAfter;
        Response(int status, String body, String retryAfter) { this.status = status; this.body = body; this.retryAfter = retryAfter; }
    }

    interface Sleeper { void sleep(long ms) throws InterruptedException; }

    static final class Stats { int queries; long bytes; }

    static final class Failure extends Exception { Failure(String m) { super(m); } }

    // ---------- queries (texts identical to the JS: the recorded-response test looks them up verbatim) ----------

    static String deltaQuery(String prop, int sinceYear) {
        return "SELECT ?item ?cls ?sl WHERE {\n" +
            "  ?item wdt:" + prop + " ?d . hint:Prior hint:rangeSafe true . FILTER(?d >= \"" + sinceYear + "-01-01T00:00:00Z\"^^xsd:dateTime)\n" +
            "  ?item wikibase:sitelinks ?sl . FILTER(?sl >= " + Catalog.MIN_SITELINKS + ")\n" +
            "  ?item wdt:P31 ?cls .\n" +
            "}";
    }

    private static String values(List<String> b) {
        StringBuilder s = new StringBuilder();
        for (String i : b) { if (s.length() > 0) s.append(' '); s.append("wd:").append(i); }
        return s.toString();
    }

    static String labelQuery(List<String> b) {
        return "SELECT ?w ?en ?mul WHERE { VALUES ?w { " + values(b) + " } OPTIONAL { ?w rdfs:label ?en . FILTER(LANG(?en) = \"en\") } OPTIONAL { ?w rdfs:label ?mul . FILTER(LANG(?mul) = \"mul\") } }";
    }
    static String yearsQuery(List<String> b) {
        return "SELECT ?w ?d WHERE { VALUES ?w { " + values(b) + " } { ?w wdt:P577 ?d } UNION { ?w wdt:P580 ?d } UNION { ?w wdt:P571 ?d } }";
    }
    static String aliasQuery(List<String> b) {
        return "SELECT ?w ?a WHERE { VALUES ?w { " + values(b) + " } ?w skos:altLabel ?a . FILTER(LANG(?a) IN (\"en\", \"mul\")) }";
    }
    static String charQuery(List<String> b) {
        return "SELECT ?w ?cl ?cs WHERE { VALUES ?w { " + values(b) + " } ?w wdt:P674 ?c . FILTER NOT EXISTS { ?c wdt:P31 wd:Q5 } ?c rdfs:label ?cl . FILTER(LANG(?cl) IN (\"en\", \"mul\")) OPTIONAL { ?c wikibase:sitelinks ?cs } }";
    }
    static String charFallbackQuery(List<String> b) {
        return "SELECT ?w ?cl ?cs WHERE { VALUES ?w { " + values(b) + " } ?c wdt:P1441 ?w ; wdt:P31 wd:Q95074 ; rdfs:label ?cl . FILTER(LANG(?cl) IN (\"en\", \"mul\")) OPTIONAL { ?c wikibase:sitelinks ?cs } }";
    }

    static String kindQuery(List<String> b) {
        return "SELECT ?w ?p ?v WHERE { VALUES ?w { " + values(b) + " } VALUES ?p { wdt:P31 wdt:P136 wdt:P7937 } ?w ?p ?v }";
    }
    static String seriesQuery(List<String> b) {
        return "SELECT ?w ?p ?s WHERE { VALUES ?w { " + values(b) + " } VALUES ?p { wdt:P179 wdt:P8345 } ?w ?p ?s }";
    }
    static String senseQuery(List<String> names, String prop) {
        StringBuilder v = new StringBuilder();
        for (String n : names) {
            StringBuilder q = new StringBuilder();
            Json.quote(q, n);
            if (v.length() > 0) v.append(' ');
            v.append(q).append("@en ").append(q).append("@mul");
        }
        return "SELECT ?l ?e ?sl (GROUP_CONCAT(DISTINCT ?c) AS ?cs) WHERE { VALUES ?l { " + v + " } ?e " + prop +
            " ?l ; wikibase:sitelinks ?sl . FILTER(?sl >= " + Catalog.MIN_SITELINKS + ") OPTIONAL { ?e wdt:P31 ?c } } GROUP BY ?l ?e ?sl";
    }

    // ---------- catalog-rules.js: series membership ----------

    /** The series lookup of new works sends at most this many queries (200 works each); the rest get titleSeries. */
    static final int MAX_SERIES_QUERIES = 5;
    private static final Pattern WORDCH = Pattern.compile("[\\p{L}\\p{N}]"), SERIES_AFTER = Pattern.compile("[ 0-9:\\-–—]"),
        SERIES_AFTER1 = Pattern.compile("^( *[:\\-–—]| *[0-9]|$)"), SUBTITLE = Pattern.compile("[:\\-–—]"),
        ARTICLE = Pattern.compile("^(the|a|an)$");

    static final class SeriesCand {
        final String id, label; final int size; final Set<String> types;
        SeriesCand(String id, String label, int size, Set<String> types) { this.id = id; this.label = label; this.size = size; this.types = types; }
    }

    private static boolean wordCh(char c) { return WORDCH.matcher(String.valueOf(c)).matches(); }

    /** catalog-rules.js titleSeries: the series a work Wikidata links to none joins by its title, or null. */
    static String titleSeries(String title, String type, List<SeriesCand> cands, Catalog.Words words) {
        String t = title.toLowerCase(java.util.Locale.ROOT);
        SeriesCand best = null;
        for (SeriesCand c : cands) {
            String l = c.label.toLowerCase(java.util.Locale.ROOT);
            List<String> ws = Catalog.splitSpace(Catalog.jsTrim(l));
            int n = ws.size() - (ARTICLE.matcher(ws.get(0)).matches() ? 1 : 0);
            if (l.isEmpty() || (n < 2 && (!c.types.contains(type) || words.isCommon(ws.get(ws.size() - 1))))) continue;
            boolean ok = t.startsWith(l) && (n >= 2 ? t.length() == l.length() || SERIES_AFTER.matcher(String.valueOf(t.charAt(l.length()))).matches()
                : SERIES_AFTER1.matcher(t.substring(l.length())).find());
            int i = t.length() - l.length();
            if (n >= 2 && !ok && i > 0 && t.endsWith(l) && !wordCh(t.charAt(i - 1)) && !SUBTITLE.matcher(t.substring(0, i)).find()) ok = true;
            if (ok && (best == null || l.length() > best.label.length() || (l.length() == best.label.length() && c.size > best.size))) best = c;
        }
        return best == null ? null : best.id;
    }

    /** catalog-rules.js seriesCandidates: the catalog's series with 2+ works. */
    static List<SeriesCand> seriesCandidates(Map<String, String[]> table, List<Catalog.Work> works) {
        Map<String, Integer> size = new HashMap<>();
        Map<String, Set<String>> types = new HashMap<>();
        for (Catalog.Work w : works) for (String s : w.series) {
            size.merge(s, 1, Integer::sum);
            types.computeIfAbsent(s, x -> new HashSet<>()).add(w.type);
        }
        List<SeriesCand> out = new ArrayList<>();
        for (Map.Entry<String, String[]> e : table.entrySet()) {
            Integer n = size.get(e.getKey());
            if (n != null && n >= 2) out.add(new SeriesCand(e.getKey(), e.getValue()[0], n, types.get(e.getKey())));
        }
        return out;
    }

    /** catalog-rules.js assignSeries: Wikidata series ids (links) -> the catalog's series via its table, else by title. */
    static void assignSeries(List<Catalog.Work> works, Map<String, List<String>> links, Map<String, String[]> table, List<SeriesCand> cands,
                             Catalog.Words words) {
        Map<String, List<String>> toSeries = new HashMap<>();
        for (Map.Entry<String, String[]> e : table.entrySet()) {
            String[] v = e.getValue();
            toSeries.computeIfAbsent(e.getKey(), x -> new ArrayList<>()).add(e.getKey());
            for (int k = 1; k < v.length; k++) toSeries.computeIfAbsent(v[k], x -> new ArrayList<>()).add(e.getKey());
        }
        for (Catalog.Work w : works) {
            LinkedHashSet<String> ss = new LinkedHashSet<>();
            List<String> raw = links.get(w.id);
            if (raw != null) for (String r : raw) { List<String> m = toSeries.get(r); if (m != null) ss.addAll(m); }
            if (!ss.isEmpty()) { w.series = ss.toArray(new String[0]); continue; }
            String t = titleSeries(w.title, w.type, cands, words);
            if (t != null) w.series = new String[]{t};
        }
    }

    // ---------- catalog-rules.js: narrative works and names that mostly mean something else ----------

    private static Set<String> set(String s) { return new HashSet<>(Arrays.asList(s.split(" "))); }
    static final Set<String> NOT_NARRATIVE = set(
        "Q179461 Q29154430 Q6718887 Q10642135 Q170207 Q34274 Q1054662 Q1001051 Q1194040 Q47148 Q209680 Q188602 Q2986441 " +
        "Q215495 Q63203971 Q21848887 Q1147354 Q3831847 Q7831615 Q938714 Q1377898 Q208628 Q12378012 Q1924246 " +
        "Q13136 Q5292 Q23622 Q4942969 Q1787111 Q521983 Q1239328 Q975413 Q162827 Q1459574 Q2352616 Q18168594 Q223638 " +
        "Q2191807 Q198614 Q1631107 Q615699 Q30721375 Q55594435 Q3136090 Q1429277 " +
        "Q213051 Q27801 Q35760 Q384515 Q864737 Q185363 Q11080698 Q30277550 Q4465563 Q116513838 Q124409385 Q36279 Q4184 " +
        "Q112983 Q5891 Q13408937 Q1683266 Q995600 Q1129795 Q11826511 Q193495 Q6498453 Q58854 Q1748756 Q190399 " +
        "Q93204 Q7603925 Q133731271 Q133731263 Q1760864 Q110593123 Q1800833 Q3648909 Q4765076 Q430525 Q1358344 " +
        "Q139850703 Q5401282 Q622812 Q986699 Q131762936 Q6645282 Q3546572 Q7257679 Q5428822 Q10676514 Q2670855 Q7832972 " +
        "Q126914943 Q7551149 Q4677832 Q2096046 Q1371394 Q116763393 Q34682961 " +
        "Q1955280 Q4504495 Q846662 Q2123557 Q336181 Q743934 Q5778915 Q482994 Q209939 Q10590726 Q20089094 Q193977 Q20135338");
    private static final Set<String> NARRATIVE = set("Q8261 Q149537 Q49084 Q25379 Q1279564 Q104213567 Q1667921 Q8253 " +
        "Q130232 Q157443 Q859369 Q959790 Q2484376 Q188473 Q1054574 Q200092 Q471839 Q182415 Q1484397 Q106603795 Q725377");
    private static final Set<String> NOT_A_SENSE = set("Q4167410 Q13406463 Q4167836 Q11266439 Q15407973 Q22808320 Q17362920");
    static final int SENSE_BATCH = 150, MAX_SENSE_QUERIES = 20;

    static boolean isNarrative(List<String> vals) {
        boolean not = false, story = false;
        for (String v : vals) { not |= NOT_NARRATIVE.contains(v); story |= NARRATIVE.contains(v); }
        return !not || story;
    }

    static boolean shortName(String n) { return Catalog.splitSpace(Catalog.jsTrim(n)).size() <= 2; }

    static List<String> senseNames(Catalog.Work w, Catalog.Words words) {
        List<String> out = new ArrayList<>();
        out.add(w.title);
        out.addAll(Arrays.asList(w.aliases));
        out.addAll(Arrays.asList(w.characters));
        String p = Catalog.seriesPrefix(w.title, words);
        if (p != null) out.add(p);
        out.removeIf(String::isEmpty);
        return out;
    }

    private static List<List<String>> batches(List<String> a) { return batches(a, 200); }

    private static List<List<String>> batches(List<String> a, int n) {
        List<List<String>> out = new ArrayList<>();
        for (int i = 0; i < a.size(); i += n) out.add(a.subList(i, Math.min(a.size(), i + n)));
        return out;
    }

    // ---------- SPARQL client ----------

    private final Transport http;
    private final String endpoint;
    private final Sleeper sleeper;
    final Stats stats = new Stats();

    CatalogUpdate(Transport http, String endpoint, Sleeper sleeper) {
        this.http = http; this.endpoint = endpoint; this.sleeper = sleeper;
    }

    /** Rows of the answer: variable -> {value, xml:lang}. Sequential; 429/5xx honour Retry-After, at most 3 tries. */
    List<Map<String, String[]>> sparql(String query) throws Failure, InterruptedException {
        String body;
        try {
            body = "query=" + URLEncoder.encode(query, "UTF-8"); // what URLSearchParams sends
        } catch (IOException e) { throw new Failure("UTF-8 missing"); }
        for (int attempt = 1; attempt <= 3; attempt++) {
            Response res;
            try {
                res = http.post(endpoint, body);
            } catch (IOException e) {
                throw new Failure("Could not reach Wikidata (offline?)");
            }
            stats.queries++;
            if (res.status >= 200 && res.status < 300) {
                stats.bytes += res.body.length();
                try {
                    return bindings(res.body);
                } catch (IOException | RuntimeException e) {
                    throw new Failure("Wikidata sent an unreadable answer");
                }
            }
            if (res.status != 429 && res.status < 500) throw new Failure("Wikidata refused the request (HTTP " + res.status + ")");
            if (attempt == 3) break;
            double ra;
            try { ra = Double.parseDouble(res.retryAfter == null ? "" : res.retryAfter.trim()); } catch (NumberFormatException e) { ra = 0; }
            sleeper.sleep((long) Math.min(ra > 0 && !Double.isInfinite(ra) ? ra * 1000 : 5000.0 * attempt, 120000));
        }
        throw new Failure("Wikidata is busy right now; will try again at the next update");
    }

    static List<Map<String, String[]>> bindings(String text) throws IOException {
        Json j = new Json(new StringReader(text));
        List<Map<String, String[]>> rows = null;
        j.beginObject();
        while (j.hasNext()) {
            if (!j.nextName().equals("results")) { j.skipValue(); continue; }
            j.beginObject();
            while (j.hasNext()) {
                if (!j.nextName().equals("bindings")) { j.skipValue(); continue; }
                rows = new ArrayList<>();
                j.beginArray();
                while (j.hasNext()) {
                    Map<String, String[]> row = new HashMap<>();
                    j.beginObject();
                    while (j.hasNext()) {
                        String var = j.nextName();
                        String[] v = new String[2];
                        j.beginObject();
                        while (j.hasNext()) {
                            String k = j.nextName();
                            if (k.equals("value")) v[0] = j.nextString();
                            else if (k.equals("xml:lang")) v[1] = j.nextString();
                            else j.skipValue();
                        }
                        j.endObject();
                        row.put(var, v);
                    }
                    j.endObject();
                    rows.add(row);
                }
                j.endArray();
            }
            j.endObject();
        }
        j.endObject();
        if (rows == null) throw new IOException("no bindings");
        return rows;
    }

    private static String val(Map<String, String[]> r, String k) {
        String[] v = r.get(k);
        if (v == null || v[0] == null) throw new IllegalStateException("answer lacks ?" + k);
        return v[0];
    }

    // ---------- delta ----------

    /** New works (catalog schema) dated since sinceYear that are not in `known`; types from the bundled class list. */
    List<Catalog.Work> fetchDelta(Map<String, List<String>> classes, int sinceYear, Set<String> known, Catalog.Ambiguity amb,
                                  Catalog.Words words, Map<String, String[]> seriesTable, List<Catalog.Work> seriesWorks)
        throws Failure, InterruptedException {
        Map<String, String> typeOf = new HashMap<>(); // class -> highest-priority type containing it
        for (int p = Catalog.PRIORITY.length - 1; p >= 0; p--) {
            List<String> cs = classes.get(Catalog.PRIORITY[p]);
            if (cs != null) for (String c : cs) typeOf.put(c, Catalog.PRIORITY[p]);
        }
        LinkedHashMap<String, Catalog.Raw> cand = new LinkedHashMap<>();
        try {
            for (String prop : DATE_PROPS) {
                for (Map<String, String[]> r : sparql(deltaQuery(prop, sinceYear))) {
                    String id = Catalog.qid(val(r, "item")), type = typeOf.get(Catalog.qid(val(r, "cls")));
                    if (known.contains(id) || type == null) continue;
                    Catalog.Raw prev = cand.get(id);
                    if (prev == null || rank(type) < rank(prev.type)) {
                        Catalog.Raw w = new Catalog.Raw();
                        w.id = id; w.type = type; w.pop = Double.parseDouble(val(r, "sl"));
                        cand.put(id, w);
                    }
                }
            }
            LinkedHashMap<String, Catalog.Raw> found = new LinkedHashMap<>();
            for (List<String> b : batches(new ArrayList<>(cand.keySet()))) {
                for (Map<String, String[]> r : sparql(labelQuery(b))) {
                    String id = Catalog.qid(val(r, "w"));
                    String[] en = r.get("en"), mul = r.get("mul");
                    String title = en != null && en[0] != null ? en[0] : mul != null ? mul[0] : null;
                    if (title != null && !title.isEmpty() && Catalog.cleanTitle(title) && !found.containsKey(id)) {
                        Catalog.Raw w = cand.get(id);
                        w.title = title;
                        found.put(id, w);
                    }
                }
            }
            // scripture, reference works, documentaries... are left out, as in the catalog build
            Map<String, List<String>> kinds = new HashMap<>();
            for (List<String> b : batches(new ArrayList<>(found.keySet()))) for (Map<String, String[]> r : sparql(kindQuery(b))) {
                String id = Catalog.qid(val(r, "w"));
                List<String> l = kinds.get(id);
                if (l == null) kinds.put(id, l = new ArrayList<>());
                l.add(Catalog.qid(val(r, "v")));
            }
            for (Iterator<String> it = found.keySet().iterator(); it.hasNext(); ) {
                List<String> k = kinds.get(it.next());
                if (!isNarrative(k == null ? Collections.<String>emptyList() : k)) it.remove();
            }
            List<String> ids = new ArrayList<>(found.keySet());
            for (List<String> b : batches(ids)) for (Map<String, String[]> r : sparql(yearsQuery(b))) {
                int y = Catalog.yearOf(val(r, "d"));
                if (y != 0) found.get(Catalog.qid(val(r, "w"))).years.add(y);
            }
            Map<String, List<Object[]>> aliases = new HashMap<>(), chars = new HashMap<>();
            for (List<String> b : batches(ids)) for (Map<String, String[]> r : sparql(aliasQuery(b))) {
                String[] a = r.get("a");
                addTo(aliases, Catalog.qid(val(r, "w")), new Object[]{val(r, "a"), "en".equals(a[1]) ? 0 : 1});
            }
            List<String> popular = new ArrayList<>();
            for (Catalog.Raw w : found.values()) if (w.pop >= Catalog.CHAR_MIN_POP) popular.add(w.id);
            for (List<String> b : batches(popular)) for (Map<String, String[]> r : sparql(charQuery(b))) addTo(chars, Catalog.qid(val(r, "w")), charPair(r));
            List<String> missing = new ArrayList<>();
            for (String id : popular) if (!chars.containsKey(id)) missing.add(id);
            for (List<String> b : batches(missing)) for (Map<String, String[]> r : sparql(charFallbackQuery(b))) addTo(chars, Catalog.qid(val(r, "w")), charPair(r));
            List<Catalog.Work> out = new ArrayList<>();
            for (Catalog.Raw w : found.values()) out.add(Catalog.finalizeWork(w, aliases.get(w.id), chars.get(w.id), amb));
            Set<String> inCatalog = new HashSet<>(known);
            inCatalog.addAll(ids);
            markOther(out, inCatalog, classes, words);
            markSeries(out, seriesTable, seriesWorks, words);
            return out;
        } catch (RuntimeException e) { // a well-formed answer of the wrong shape
            throw new Failure("Wikidata sent an unreadable answer");
        }
    }

    /** Sets work.other like the catalog build, with at most MAX_SENSE_QUERIES queries; fail safe as in the JS. */
    private void markOther(List<Catalog.Work> works, Set<String> inCatalog, Map<String, List<String>> classes, Catalog.Words words)
        throws InterruptedException {
        Set<String> same = new HashSet<>();
        for (String t : Catalog.PRIORITY) { List<String> l = classes.get(t); if (l != null) same.addAll(l); }
        List<String> extra = classes.get("sameSense");
        if (extra != null) same.addAll(extra);
        same.removeAll(NOT_NARRATIVE);
        LinkedHashSet<String> uniq = new LinkedHashSet<>();
        for (Catalog.Work w : works) uniq.addAll(senseNames(w, words));
        List<String> names = new ArrayList<>(uniq);
        Collections.sort(names);
        Map<String, Double> otherPop = new HashMap<>();
        Set<String> looked = new HashSet<>();
        int queries = 0;
        try {
            for (List<String> b : batches(names, SENSE_BATCH)) {
                List<String> shortOnes = new ArrayList<>();
                for (String n : b) if (shortName(n)) shortOnes.add(n);
                int need = shortOnes.isEmpty() ? 1 : 2;
                if (queries + need > MAX_SENSE_QUERIES) break;
                queries += need;
                List<Map<String, String[]>> rows = new ArrayList<>(sparql(senseQuery(b, "rdfs:label")));
                if (!shortOnes.isEmpty()) rows.addAll(sparql(senseQuery(shortOnes, "skos:altLabel")));
                for (Map<String, String[]> r : rows) {
                    String[] cv = r.get("cs");
                    boolean skip = inCatalog.contains(Catalog.qid(val(r, "e"))), sameHit = false;
                    List<String> cs = new ArrayList<>();
                    if (cv != null && cv[0] != null && !cv[0].isEmpty()) for (String c : cv[0].split(" ", -1)) cs.add(Catalog.qid(c));
                    for (String q : cs) { skip |= NOT_A_SENSE.contains(q); sameHit |= same.contains(q); }
                    skip |= sameHit && isNarrative(cs); // a work left out of the catalog is a sense of its own
                    if (skip) continue;
                    String l = val(r, "l");
                    double sl = Double.parseDouble(val(r, "sl"));
                    Double prev = otherPop.get(l);
                    otherPop.put(l, prev == null ? sl : Math.max(prev, sl));
                }
                looked.addAll(b);
            }
        } catch (Failure | RuntimeException e) {
            // busy, refused or an odd answer: the names not looked up get the fail-safe rule
        }
        for (Catalog.Work w : works) {
            LinkedHashSet<String> other = new LinkedHashSet<>();
            for (String n : senseNames(w, words)) {
                Double p = otherPop.get(n);
                if (looked.contains(n) ? (p == null ? 0 : p) > w.pop : shortName(n)) other.add(n);
            }
            if (!other.isEmpty()) w.other = other.toArray(new String[0]);
        }
    }

    /** Sets work.series like the catalog build, with at most MAX_SERIES_QUERIES queries; title fallback as in the JS. */
    private void markSeries(List<Catalog.Work> works, Map<String, String[]> table, List<Catalog.Work> inCatalog, Catalog.Words words)
        throws InterruptedException {
        Map<String, List<String>> links = new HashMap<>();
        List<String> ids = new ArrayList<>();
        for (Catalog.Work w : works) ids.add(w.id);
        try {
            List<List<String>> bs = batches(ids);
            for (List<String> b : bs.subList(0, Math.min(bs.size(), MAX_SERIES_QUERIES))) for (Map<String, String[]> r : sparql(seriesQuery(b))) {
                links.computeIfAbsent(Catalog.qid(val(r, "w")), x -> new ArrayList<>()).add(Catalog.qid(val(r, "s")));
            }
        } catch (Failure | RuntimeException e) {
            // busy, refused or an odd answer: the title fallback
        }
        assignSeries(works, links, table, seriesCandidates(table, inCatalog), words);
    }

    private static Object[] charPair(Map<String, String[]> r) {
        String[] cs = r.get("cs");
        return new Object[]{val(r, "cl"), cs == null || cs[0] == null ? 0.0 : Double.parseDouble(cs[0])};
    }

    private static int rank(String t) {
        for (int i = 0; i < Catalog.PRIORITY.length; i++) if (Catalog.PRIORITY[i].equals(t)) return i;
        return -1;
    }

    private static void addTo(Map<String, List<Object[]>> m, String k, Object[] v) {
        List<Object[]> l = m.get(k);
        if (l == null) m.put(k, l = new ArrayList<>());
        l.add(v);
    }

    static Map<String, List<String>> readClasses(String json) throws IOException {
        Json j = new Json(new StringReader(json));
        Map<String, List<String>> out = new HashMap<>();
        j.beginObject();
        while (j.hasNext()) {
            String type = j.nextName();
            List<String> l = new ArrayList<>();
            j.beginArray();
            while (j.hasNext()) l.add(j.nextString());
            j.endArray();
            out.put(type, l);
        }
        j.endObject();
        return out;
    }

    // ---------- the default transport ----------

    static Transport httpTransport() {
        return (endpoint, form) -> {
            HttpURLConnection c = (HttpURLConnection) new URL(endpoint).openConnection();
            try {
                c.setRequestMethod("POST");
                c.setConnectTimeout(30000);
                c.setReadTimeout(90000); // Wikidata itself stops queries after 60 s
                c.setUseCaches(false);
                c.setInstanceFollowRedirects(false);
                c.setDoOutput(true);
                // shortcut: a host app that installed a process-wide java.net.CookieHandler would see this request; none
                // of the three target apps uses HttpURLConnection's default handler for its own traffic.
                c.setRequestProperty("Accept", "application/sparql-results+json");
                c.setRequestProperty("Content-Type", "application/x-www-form-urlencoded");
                c.setRequestProperty("User-Agent", "SpoilerBlock-catalog-update/0.2");
                byte[] body = form.getBytes(StandardCharsets.UTF_8);
                c.setFixedLengthStreamingMode(body.length);
                try (OutputStream o = c.getOutputStream()) { o.write(body); }
                int status = c.getResponseCode();
                InputStream in = status >= 400 ? c.getErrorStream() : c.getInputStream();
                String text = in == null ? "" : new String(readAll(in, 64 << 20), StandardCharsets.UTF_8);
                return new Response(status, text, c.getHeaderField("Retry-After"));
            } finally {
                c.disconnect();
            }
        };
    }

    static byte[] readAll(InputStream in, int limit) throws IOException {
        try (InputStream i = in) {
            ByteArrayOutputStream out = new ByteArrayOutputStream(1 << 16);
            byte[] buf = new byte[1 << 16];
            for (int n; (n = i.read(buf)) > 0; ) {
                out.write(buf, 0, n);
                if (out.size() > limit) throw new IOException("answer too large");
            }
            return out.toByteArray();
        }
    }

    // ---------- the stored index (one file, written then renamed: readers see the old or the complete new one) ----------

    static final class Stored {
        final String bundledBuiltAt; final byte[] bin; final String json; final List<Catalog.Work> added;
        Stored(String bundledBuiltAt, byte[] bin, String json, List<Catalog.Work> added) {
            this.bundledBuiltAt = bundledBuiltAt; this.bin = bin; this.json = json; this.added = added;
        }
    }

    private static final int FILE_MAGIC = 0x53424331; // "SBC1"

    static void write(File f, Stored s) throws IOException {
        File tmp = new File(f.getPath() + ".tmp");
        StringBuilder added = new StringBuilder();
        Catalog.writeWorks(added, s.added);
        try (FileOutputStream fo = new FileOutputStream(tmp); DataOutputStream o = new DataOutputStream(new java.io.BufferedOutputStream(fo))) {
            o.writeInt(FILE_MAGIC);
            o.writeUTF(s.bundledBuiltAt);
            o.writeInt(s.bin.length); o.write(s.bin);
            byte[] j = Catalog.utf8(s.json); o.writeInt(j.length); o.write(j);
            byte[] a = Catalog.utf8(added.toString()); o.writeInt(a.length); o.write(a);
            o.flush();
            fo.getFD().sync();
        }
        if (!tmp.renameTo(f)) { tmp.delete(); throw new IOException("could not replace " + f); }
    }

    static Stored read(File f) throws IOException {
        try (DataInputStream in = new DataInputStream(new java.io.BufferedInputStream(new FileInputStream(f)))) {
            if (in.readInt() != FILE_MAGIC) throw new IOException("not an index file");
            String builtAt = in.readUTF();
            byte[] bin = new byte[in.readInt()]; in.readFully(bin);
            byte[] json = new byte[in.readInt()]; in.readFully(json);
            byte[] added = new byte[in.readInt()]; in.readFully(added);
            Json j = new Json(new StringReader(new String(added, StandardCharsets.UTF_8)));
            return new Stored(builtAt, bin, new String(json, StandardCharsets.UTF_8), Catalog.readWorkArray(j));
        }
    }

    /** Bundled data the update needs, read from the APK's assets (or test files). */
    static final class Bundle {
        final List<Catalog.Work> catalog; final String words; final Map<String, List<String>> classes; final String builtAt;
        final Map<String, String[]> series; // the catalog's series table (Catalog.Works), empty for a plain list
        Bundle(List<Catalog.Work> catalog, String words, Map<String, List<String>> classes, String builtAt) {
            this.catalog = catalog; this.words = words; this.classes = classes; this.builtAt = builtAt;
            this.series = catalog instanceof Catalog.Works ? ((Catalog.Works) catalog).series : new LinkedHashMap<>();
        }
        int sinceYear() { return Integer.parseInt(builtAt.substring(0, 4)) - 1; } // builtAt is ISO UTC
    }

    static String builtAtOf(String catalogInfoJson) throws IOException {
        Json j = new Json(new StringReader(catalogInfoJson));
        String v = null;
        j.beginObject();
        while (j.hasNext()) { if (j.nextName().equals("builtAt")) v = j.nextString(); else j.skipValue(); }
        j.endObject();
        if (v == null) throw new IOException("catalog-info has no builtAt");
        return v;
    }

    /** One update run: new works since the last one are added to the earlier ones and the index is rebuilt. */
    static final class Result {
        List<Catalog.Work> fresh = new ArrayList<>(), added;
        Catalog.Built built;
    }

    Result run(Bundle bundle, List<Catalog.Work> prev) throws Failure, InterruptedException {
        Set<String> known = new HashSet<>();
        for (Catalog.Work w : bundle.catalog) known.add(w.id);
        for (Catalog.Work w : prev) known.add(w.id);
        Result r = new Result();
        Catalog.Words words = new Catalog.Words(bundle.words);
        List<Catalog.Work> inCatalog = new ArrayList<>(bundle.catalog);
        inCatalog.addAll(prev);
        r.fresh = fetchDelta(bundle.classes, bundle.sinceYear(), known, new Catalog.Ambiguity(bundle.words), words, bundle.series, inCatalog);
        r.added = new ArrayList<>(prev);
        r.added.addAll(r.fresh);
        if (!r.fresh.isEmpty()) r.built = Catalog.buildIndex(Catalog.merge(bundle.catalog, r.added), words);
        return r;
    }
}
