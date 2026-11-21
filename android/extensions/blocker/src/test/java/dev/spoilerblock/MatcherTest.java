package dev.spoilerblock;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertTrue;

import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;

import java.io.File;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.ArrayList;
import java.util.List;

/** Java port == JS matcher on the vectors written by android/tools/vectors.mjs (run it first). */
public class MatcherTest {
    private static final File V = new File(System.getProperty("sb.vectors"));
    private static final File DIST = new File(System.getProperty("sb.dist"));

    private static String read(File f) throws Exception { return new String(Files.readAllBytes(f.toPath()), StandardCharsets.UTF_8); }

    private static List<String> strs(JSONArray a) throws Exception {
        List<String> r = new ArrayList<>();
        for (int i = 0; i < a.length(); i++) r.add(a.getString(i));
        return r;
    }

    private static int check(Matcher m, JSONArray cases) throws Exception {
        int failures = 0;
        for (int i = 0; i < cases.length(); i++) {
            JSONObject c = cases.getJSONObject(i);
            boolean[] seen = new boolean[m.ids.length];
            JSONArray s = c.getJSONArray("seen");
            for (int j = 0; j < s.length(); j++) seen[s.getInt(j)] = true;
            List<String> got = new ArrayList<>();
            List<int[]> unsure = new ArrayList<>();
            int[] gs = m.evaluate(c.getString("text"), seen, unsure);
            for (int g : gs) got.add(m.labels[g]);
            List<String> want = strs(c.getJSONArray("expect"));
            // "More from this series" of those groups (Matcher.moreFromSeries == matcher.js moreFromSeries)
            got.add("more=" + java.util.Arrays.toString(m.moreFromSeries(gs)));
            JSONArray mo = c.getJSONArray("more");
            int[] wm = new int[mo.length()];
            for (int j = 0; j < wm.length; j++) wm[j] = mo.getInt(j);
            want.add("more=" + java.util.Arrays.toString(wm));
            // the names the matcher is unsure about, [group, start, end, other] (also through unsure(), the same scan)
            List<String> gu = new ArrayList<>(), wu = new ArrayList<>(), gu2 = new ArrayList<>();
            for (int[] x : unsure) gu.add(java.util.Arrays.toString(x));
            for (int[] x : m.unsure(c.getString("text"), seen)) gu2.add(java.util.Arrays.toString(x));
            JSONArray ju = c.getJSONArray("unsure");
            for (int j = 0; j < ju.length(); j++) {
                JSONArray x = ju.getJSONArray(j);
                wu.add(java.util.Arrays.toString(new int[]{x.getInt(0), x.getInt(1), x.getInt(2), x.getInt(3)}));
            }
            got.add("unsure=" + gu + gu2);
            want.add("unsure=" + wu + wu);
            if (!got.equals(want)) {
                if (++failures <= 20) System.err.println("MISMATCH " + c.getString("text") + " seen=" + s + " js=" + want + " java=" + got);
            }
        }
        return failures;
    }

    @Test public void fixtureCatalog() throws Exception {
        Matcher m = new Matcher(Files.readAllBytes(new File(V, "fixture.bin").toPath()), read(new File(V, "fixture.json")));
        JSONArray cases = new JSONArray(read(new File(V, "fixture-cases.json")));
        assertTrue(cases.length() > 3000);
        assertEquals(0, check(m, cases));
    }

    @Test public void shippedIndex() throws Exception {
        Matcher m = new Matcher(Files.readAllBytes(new File(DIST, "index.bin").toPath()), read(new File(DIST, "index.json")));
        JSONObject d = new JSONObject(read(new File(V, "dist-cases.json")));
        assertEquals(0, check(m, d.getJSONArray("cases")));
        // group membership: what "I've seen {label}" marks
        JSONArray groups = d.getJSONArray("groups");
        for (int i = 0; i < groups.length(); i++) {
            JSONObject g = groups.getJSONObject(i);
            int[] gs = m.evaluate(g.getString("text"), new boolean[m.ids.length]);
            assertTrue(g.getString("text"), gs.length > 0);
            assertEquals(g.getString("label"), m.labels[gs[0]]);
            List<String> titles = new ArrayList<>(), types = new ArrayList<>();
            for (int w : m.groupWorks(gs[0])) { titles.add(m.titles[w]); types.add(m.types[w]); }
            for (String t : strs(g.getJSONArray("members"))) assertTrue(g.getString("label") + " lacks " + t, titles.contains(t));
            for (String t : strs(g.getJSONArray("types"))) assertTrue(g.getString("label") + " lacks type " + t, types.contains(t));
            boolean[] all = new boolean[m.ids.length];
            for (int w : m.groupWorks(gs[0])) all[w] = true;
            for (int x : m.evaluate(g.getString("text"), all)) assertTrue(!m.labels[x].equals(g.getString("label")));
        }
    }
}
