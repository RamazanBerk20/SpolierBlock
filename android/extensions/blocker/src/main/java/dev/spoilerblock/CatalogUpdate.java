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
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

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

    private static List<List<String>> batches(List<String> a) {
        List<List<String>> out = new ArrayList<>();
        for (int i = 0; i < a.size(); i += 200) out.add(a.subList(i, Math.min(a.size(), i + 200)));
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
    List<Catalog.Work> fetchDelta(Map<String, List<String>> classes, int sinceYear, Set<String> known, Catalog.Ambiguity amb)
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
            return out;
        } catch (RuntimeException e) { // a well-formed answer of the wrong shape
            throw new Failure("Wikidata sent an unreadable answer");
        }
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
        Bundle(List<Catalog.Work> catalog, String words, Map<String, List<String>> classes, String builtAt) {
            this.catalog = catalog; this.words = words; this.classes = classes; this.builtAt = builtAt;
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
        r.fresh = fetchDelta(bundle.classes, bundle.sinceYear(), known, new Catalog.Ambiguity(bundle.words));
        r.added = new ArrayList<>(prev);
        r.added.addAll(r.fresh);
        if (!r.fresh.isEmpty()) r.built = Catalog.buildIndex(Catalog.merge(bundle.catalog, r.added), new Catalog.Words(bundle.words));
        return r;
    }
}
