package dev.spoilerblock;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;

import java.io.File;
import java.io.FileInputStream;
import java.io.InputStreamReader;
import java.net.URLDecoder;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * The Java index builder and delta fetch against the extension's JS: byte-identical indexes for the bundled catalog
 * (expected = dist/firefox/data, the Node build) and for bundled + the mock delta (android/tools/catalog-vectors.mjs).
 */
public class CatalogTest {
    private static final File V = new File(System.getProperty("sb.vectors"));
    private static final File DIST = new File(System.getProperty("sb.dist"));

    private static String read(File f) throws Exception { return new String(Files.readAllBytes(f.toPath()), StandardCharsets.UTF_8); }

    private static CatalogUpdate.Bundle bundle() throws Exception {
        try (InputStreamReader r = new InputStreamReader(new FileInputStream(new File(DIST, "catalog.json")), StandardCharsets.UTF_8)) {
            return new CatalogUpdate.Bundle(Catalog.readWorks(r), read(new File(DIST, "common-words.txt")),
                CatalogUpdate.readClasses(read(new File(DIST, "catalog-classes.json"))), CatalogUpdate.builtAtOf(read(new File(DIST, "catalog-info.json"))));
        }
    }

    @Test public void bundledCatalogBuildsTheShippedIndex() throws Exception {
        CatalogUpdate.Bundle b = bundle();
        long t0 = System.nanoTime();
        Catalog.Built built = Catalog.buildIndex(b.catalog, new Catalog.Words(b.words));
        System.out.println("bundled build: " + b.catalog.size() + " works in " + (System.nanoTime() - t0) / 1000000 + " ms");
        assertArrayEquals(Files.readAllBytes(new File(DIST, "index.bin").toPath()), built.bin);
        assertEquals(read(new File(DIST, "index.json")), built.json);
    }

    /** Replays the JS run's exchanges; also checks the Java client sends the same queries in the same order. */
    private static final class Replay implements CatalogUpdate.Transport {
        final List<String> sent = new ArrayList<>();
        final Map<String, String> answers = new HashMap<>();
        boolean lenient; // answer queries the JS run did not record with no rows
        @Override public CatalogUpdate.Response post(String endpoint, String form) throws java.io.IOException {
            assertTrue(form.startsWith("query="));
            String q = URLDecoder.decode(form.substring(6), "UTF-8");
            sent.add(q);
            String a = answers.get(q);
            if (a == null && lenient) a = "{\"results\":{\"bindings\":[]}}";
            if (a == null) fail("query the JS did not send: " + q);
            return new CatalogUpdate.Response(200, a, null);
        }
    }

    @Test public void deltaFetchAndRebuildMatchTheJs() throws Exception {
        JSONObject http = new JSONObject(read(new File(V, "delta-http.json")));
        JSONArray ex = http.getJSONArray("exchanges");
        Replay t = new Replay();
        List<String> jsQueries = new ArrayList<>();
        for (int i = 0; i < ex.length(); i++) {
            jsQueries.add(ex.getJSONArray(i).getString(0));
            t.answers.put(ex.getJSONArray(i).getString(0), ex.getJSONArray(i).getString(1));
        }
        CatalogUpdate.Bundle b = bundle();
        assertEquals(http.getInt("sinceYear"), b.sinceYear());
        CatalogUpdate u = new CatalogUpdate(t, "mock", ms -> fail("no retries expected"));
        long t0 = System.nanoTime();
        CatalogUpdate.Result r = u.run(b, new ArrayList<>());
        System.out.println("delta run + rebuild: " + (System.nanoTime() - t0) / 1000000 + " ms, " + u.stats.queries + " queries");
        assertEquals(jsQueries, t.sent);
        StringBuilder works = new StringBuilder();
        Catalog.writeWorks(works, r.fresh);
        assertEquals(read(new File(V, "delta-works.json")), works.toString());
        assertArrayEquals(Files.readAllBytes(new File(V, "delta-index.bin").toPath()), r.built.bin);
        assertEquals(read(new File(V, "delta-index.json")), r.built.json);

        // the new works match, and the sequel is in the "Star Wars" group "I've seen Star Wars" marks
        Matcher m = new Matcher(r.built.bin, r.built.json);
        boolean[] none = new boolean[m.ids.length];
        int[] g = m.evaluate("Zorblax Chronicles finale was wild", none);
        assertEquals("Zorblax Chronicles", m.labels[g[0]]);
        int sw = java.util.Arrays.asList(m.ids).indexOf("Q900000002");
        int[] s = m.evaluate("Talking about Star Wars tonight", none);
        assertEquals("Star Wars", m.labels[s[0]]);
        boolean in = false;
        for (int w : m.groupWorks(s[0])) in |= w == sw;
        assertTrue("sequel not in the Star Wars group", in);
        assertEquals("Grand Theft Auto VII", m.labels[m.evaluate("gta7 leak", none)[0]]);

        // a second run with nothing new keeps the earlier additions and builds nothing ("2027" is re-asked: dropped, not known)
        t.lenient = true;
        CatalogUpdate again = new CatalogUpdate(t, "mock", ms -> fail("no retries expected"));
        CatalogUpdate.Result r2 = again.run(b, r.added);
        assertEquals(0, r2.fresh.size());
        assertEquals(r.added.size(), r2.added.size());
        assertEquals(null, r2.built);

        // the stored file round-trips
        File f = File.createTempFile("sbindex", ".dat");
        CatalogUpdate.write(f, new CatalogUpdate.Stored(b.builtAt, r.built.bin, r.built.json, r.added));
        CatalogUpdate.Stored st = CatalogUpdate.read(f);
        assertArrayEquals(r.built.bin, st.bin);
        assertEquals(r.built.json, st.json);
        StringBuilder a1 = new StringBuilder(), a2 = new StringBuilder();
        Catalog.writeWorks(a1, r.added);
        Catalog.writeWorks(a2, st.added);
        assertEquals(a1.toString(), a2.toString());
        f.delete();
    }

    /** Rule 11: learned.names for a catalog and a custom work give the index catalog-vectors.mjs built with them. */
    @Test public void learnedNamesBuildTheJsIndex() throws Exception {
        CatalogUpdate.Bundle b = bundle();
        Config c = Config.parse(read(new File(V, "names-config.json")));
        assertEquals(2, c.learned.getJSONObject("names").length());
        Catalog.Built built = Catalog.buildIndex(SpoilerBlock.indexWorks(b.catalog, new ArrayList<>(), c, b.words), new Catalog.Words(b.words));
        assertArrayEquals(Files.readAllBytes(new File(V, "names-index.bin").toPath()), built.bin);
        assertEquals(read(new File(V, "names-index.json")), built.json);
        Matcher m = new Matcher(built.bin, built.json);
        boolean[] none = new boolean[m.ids.length];
        int[] g = m.evaluate("Finally finished Albuquerque Chemistry Tales, what an ending", none);
        assertEquals(1, g.length);
        assertEquals("Breaking Bad", m.titles[m.groupWorks(g[0])[0]]);
        g = m.evaluate("The Rainfall Saga ending made me cry", none);
        assertEquals("custom:2", m.ids[m.groupWorks(g[0])[0]]);
        for (Catalog.Work w : b.catalog) if (w.title.equals("Breaking Bad")) assertFalse("the bundled list is not changed", java.util.Arrays.asList(w.aliases).contains("BBX"));
        assertTrue("no names, no custom works: the bundled index is used", SpoilerBlock.customSig(Config.parse("{}")).isEmpty());
        assertFalse(SpoilerBlock.customSig(Config.parse("{\"learned\":{\"names\":{\"Q1\":[\"BrBa\"]}}}")).isEmpty());
    }

    @Test public void busyAndBrokenAnswersFailCleanly() throws Exception {
        List<Long> slept = new ArrayList<>();
        CatalogUpdate busy = new CatalogUpdate((e, f) -> new CatalogUpdate.Response(429, "busy", "7"), "mock", slept::add);
        try { busy.sparql("SELECT 1"); fail(); } catch (CatalogUpdate.Failure e) {
            assertEquals("Wikidata is busy right now; will try again at the next update", e.getMessage());
        }
        assertEquals(3, busy.stats.queries);
        assertEquals(java.util.Arrays.asList(7000L, 7000L), slept); // Retry-After honoured, 3 tries

        CatalogUpdate broken = new CatalogUpdate((e, f) -> new CatalogUpdate.Response(200, "{\"results\": {\"bindings\": [ {\"w\": ", null), "mock", ms -> { });
        try { broken.sparql("SELECT 1"); fail(); } catch (CatalogUpdate.Failure e) {
            assertEquals("Wikidata sent an unreadable answer", e.getMessage());
        }
        CatalogUpdate refused = new CatalogUpdate((e, f) -> new CatalogUpdate.Response(403, "", null), "mock", ms -> { });
        try { refused.sparql("SELECT 1"); fail(); } catch (CatalogUpdate.Failure e) {
            assertEquals("Wikidata refused the request (HTTP 403)", e.getMessage());
        }
        CatalogUpdate offline = new CatalogUpdate((e, f) -> { throw new java.io.IOException("no route"); }, "mock", ms -> { });
        try { offline.sparql("SELECT 1"); fail(); } catch (CatalogUpdate.Failure e) {
            assertEquals("Could not reach Wikidata (offline?)", e.getMessage());
        }
    }

    /** Opt-in live run against query.wikidata.org: SB_LIVE=1 ./gradlew :extensions:blocker:testDebugUnitTest */
    @Test public void liveWikidata() throws Exception {
        if (System.getenv("SB_LIVE") == null) return;
        CatalogUpdate.Bundle full = bundle();
        // The bundled catalog was built from the same Wikidata today, so a plain run finds (almost) nothing. Leave out
        // the bundled works dated 2025 or later and check that the live delta finds them again.
        List<Catalog.Work> older = new ArrayList<>();
        java.util.Set<String> removed = new java.util.HashSet<>();
        for (Catalog.Work w : full.catalog) if (w.year >= 2025) removed.add(w.id); else older.add(w);
        CatalogUpdate.Bundle b = new CatalogUpdate.Bundle(older, full.words, full.classes, full.builtAt);
        CatalogUpdate u = new CatalogUpdate(CatalogUpdate.httpTransport(), CatalogUpdate.ENDPOINT, Thread::sleep);
        long t0 = System.nanoTime();
        CatalogUpdate.Result r = u.run(b, new ArrayList<>());
        System.out.println("LIVE: " + u.stats.queries + " queries, " + u.stats.bytes + " chars, " + (System.nanoTime() - t0) / 1000000 +
            " ms, " + r.fresh.size() + " new works, rebuilt index " + (r.built == null ? 0 : r.built.bin.length + r.built.json.length()) + " bytes");
        int refound = 0;
        for (Catalog.Work w : r.fresh) if (removed.contains(w.id)) refound++;
        System.out.println("LIVE: left out " + removed.size() + " bundled works dated 2025+, found again " + refound + ", other new " + (r.fresh.size() - refound));
        for (int i = 0; i < Math.min(15, r.fresh.size()); i++) System.out.println("LIVE new: " + r.fresh.get(i).type + " " + r.fresh.get(i).title + " (" + r.fresh.get(i).year + ")");
    }
}
