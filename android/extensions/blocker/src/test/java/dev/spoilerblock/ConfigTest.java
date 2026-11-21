package dev.spoilerblock;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;
import static org.junit.Assert.fail;

import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.Test;

import java.util.Arrays;
import java.util.HashSet;

/** The 0.2 config: normalisation, 0.1 migration, merge patches, the export file, the decision rule, the provider's caller check. */
public class ConfigTest {
    private static Config cfg(String json) { return Config.parse(json); }

    @Test public void defaultsAndNormalisation() throws Exception {
        Config c = cfg("{\"works\":{\"Q1\":{\"state\":\"seen\",\"style\":\"bogus\",\"year\":\"x\"},\"Q2\":{\"state\":\"maybe\"}},"
            + "\"custom\":[{\"id\":\"custom:1\",\"title\":\" Mine \",\"aliases\":[\"M\",3],\"type\":\"podcast\"},{\"id\":\"x\",\"title\":\"bad\"},"
            + "{\"id\":\"custom:1\",\"title\":\"dup\"}],\"settings\":{\"style\":\"spoilers\",\"enabled\":\"yes\",\"extra\":1}}");
        assertEquals("seen", c.state("Q1"));
        assertTrue(c.work("Q1").isNull("style"));
        assertTrue(c.work("Q1").isNull("year"));
        assertNull("invalid state dropped", c.work("Q2"));
        assertEquals(1, c.custom.length());
        assertEquals("Mine", c.custom.getJSONObject(0).getString("title"));
        assertEquals("movie", c.custom.getJSONObject(0).getString("type"));
        assertEquals(new JSONArray("[\"M\"]").toString(), c.custom.getJSONObject(0).getJSONArray("aliases").toString());
        assertEquals("spoilers", c.style());
        assertTrue("a non-boolean keeps the default", c.bool("enabled"));
        assertTrue(c.bool("blockUnlisted"));
        assertFalse("unknownImages is off by default", c.bool("unknownImages"));
        assertEquals("off", c.catalogUpdate());
        assertEquals(2, c.nextCustomId());
        assertEquals(c.json(), cfg(c.json()).json());
        assertEquals("garbage gives defaults", new Config().json(), cfg("not json").json());
    }

    @Test public void captionlessVideos() throws Exception {
        assertEquals("empty by default", "[]", new Config().settings.getJSONArray("captionlessVideos").toString());
        Config c = cfg("{\"settings\":{\"captionlessVideos\":[\" X.com \",\"x.com\",\"https://www.Instagram.com/reels\",\"youtube.com.\",3,\"no host\",\"nodot\",\"localhost\"]}}");
        assertEquals("[\"x.com\",\"instagram.com\",\"youtube.com\",\"localhost\"]", c.settings.getJSONArray("captionlessVideos").toString());
        assertTrue(c.captionless("x.com"));
        assertFalse(c.captionless("demo.test"));
        assertFalse(c.captionless(null));
        assertEquals("a non-array keeps the list", c.json(), c.copy().apply(Config.settingPatch("captionlessVideos", "x.com")).json());
        assertEquals("[]", c.copy().apply(Config.settingPatch("captionlessVideos", new JSONArray())).settings.getJSONArray("captionlessVideos").toString());
        assertEquals("exported and read back", c.json(), Config.fromExport(c.export("2026-11-21T00:00:00Z")).json());
        Config mine = new Config();
        mine.mergeImport(c, false);
        assertFalse("merge keeps settings unless ticked", mine.captionless("x.com"));
        mine.mergeImport(c, true);
        assertTrue(mine.captionless("x.com"));
        assertEquals("x.com", Config.site("com.twitter.android"));
        assertEquals("instagram.com", Config.site("com.instagram.android"));
        assertEquals("youtube.com", Config.site("app.morphe.android.youtube"));
        assertEquals("demo.test", Config.site("dev.spoilerblock.demo2"));
        assertNull(Config.site("dev.spoilerblock"));
    }

    @Test public void migratesFrom01() {
        Config c = Config.migrate(new HashSet<>(Arrays.asList("Q1079", "Q42")), "spoiler", false, true, "weekly", 5);
        assertEquals("seen", c.state("Q1079"));
        assertEquals("seen", c.state("Q42"));
        assertEquals(5, c.work("Q42").optLong("ts"));
        assertEquals("spoilers", c.style());
        assertFalse(c.bool("enabled"));
        assertEquals("weekly", c.catalogUpdate());
        Config any = Config.migrate(null, "any", true, false, "nonsense", 0);
        assertEquals("all", any.style());
        assertFalse(any.bool("scanImages"));
        assertEquals("off", any.catalogUpdate());
        assertEquals(0, any.works.length());
    }

    @Test public void mergePatch() throws Exception {
        Config c = cfg("{\"works\":{\"Q1\":{\"state\":\"seen\",\"title\":\"A\"},\"Q2\":{\"state\":\"blocked\"}}}");
        c.apply(new JSONObject("{\"works\":{\"Q1\":{\"style\":\"spoilers\"},\"Q2\":null,\"Q3\":{\"state\":\"blocked\"},\"Q4\":{\"style\":\"all\"}},"
            + "\"settings\":{\"blockUnlisted\":false,\"style\":\"nope\"}}"));
        assertEquals("seen", c.state("Q1"));
        assertEquals("A", c.work("Q1").getString("title"));
        assertEquals("spoilers", c.effectiveStyle("Q1"));
        assertNull("null deletes", c.work("Q2"));
        assertEquals("blocked", c.state("Q3"));
        assertNull("an entry without a state is not created", c.work("Q4"));
        assertFalse(c.bool("blockUnlisted"));
        assertEquals("all", c.style());
        assertEquals("all", c.effectiveStyle("Q3"));
        c.apply(new JSONObject("{\"custom\":[{\"id\":\"custom:4\",\"title\":\"T\"}]}"));
        assertEquals(1, c.custom.length());
        assertEquals(5, c.nextCustomId());
    }

    @Test public void exportFileRoundTripAndRefusals() throws Exception {
        Config c = cfg("{\"works\":{\"Q1\":{\"state\":\"blocked\",\"title\":\"A\",\"ts\":3}},\"custom\":[{\"id\":\"custom:1\",\"title\":\"T\",\"type\":\"game\"}]}");
        String file = c.export("2026-11-18T12:00:00Z");
        JSONObject o = new JSONObject(file);
        assertEquals("spolierblock", o.getString("format"));
        assertEquals(1, o.getInt("version"));
        assertEquals("2026-11-18T12:00:00Z", o.getString("exportedAt"));
        assertEquals(c.json(), Config.fromExport(file).json());
        for (String bad : new String[]{"[]", "{}", "{\"format\":\"other\",\"version\":1}", "{\"format\":\"spolierblock\"}", "{\"format\":\"spolierblock\",\"version\":2}", "x"}) {
            try { Config.fromExport(bad); fail("accepted " + bad); } catch (IllegalArgumentException e) { assertFalse(e.getMessage().isEmpty()); }
        }
        try { Config.fromExport("{\"format\":\"spolierblock\",\"version\":2}"); } catch (IllegalArgumentException e) { assertTrue(e.getMessage().contains("newer")); }
        // unknown keys are ignored
        assertEquals("seen", Config.fromExport("{\"format\":\"spolierblock\",\"version\":1,\"x\":{},\"works\":{\"Q9\":{\"state\":\"seen\",\"y\":1}}}").state("Q9"));
    }

    @Test public void importMerge() throws Exception {
        Config mine = cfg("{\"works\":{\"Q1\":{\"state\":\"seen\"},\"Q2\":{\"state\":\"seen\"}},\"custom\":[{\"id\":\"custom:1\",\"title\":\"Old\"}],\"settings\":{\"scanImages\":false}}");
        Config in = cfg("{\"works\":{\"Q2\":{\"state\":\"blocked\"},\"Q3\":{\"state\":\"seen\"}},\"custom\":[{\"id\":\"custom:1\",\"title\":\"New\"},{\"id\":\"custom:2\",\"title\":\"Two\"}],\"settings\":{\"scanImages\":true,\"style\":\"spoilers\"}}");
        Config a = mine.copy();
        a.mergeImport(in, false);
        assertEquals("seen", a.state("Q1"));
        assertEquals("the file wins per id", "blocked", a.state("Q2"));
        assertEquals("seen", a.state("Q3"));
        assertEquals("New", a.custom.getJSONObject(0).getString("title"));
        assertEquals(2, a.custom.length());
        assertFalse("settings kept unless ticked", a.bool("scanImages"));
        Config b = mine.copy();
        b.mergeImport(in, true);
        assertTrue(b.bool("scanImages"));
        assertEquals("spoilers", b.style());
    }

    @Test public void absorbIntoCompanion() throws Exception {
        Config shared = cfg("{\"works\":{\"Q1\":{\"state\":\"blocked\"},\"custom:1\":{\"state\":\"blocked\"}},\"custom\":[{\"id\":\"custom:1\",\"title\":\"Theirs\",\"type\":\"game\"}],\"settings\":{\"style\":\"all\"}}");
        Config local = cfg("{\"works\":{\"Q1\":{\"state\":\"seen\"},\"Q2\":{\"state\":\"seen\"},\"custom:1\":{\"state\":\"seen\"},\"custom:2\":{\"state\":\"seen\"}},"
            + "\"custom\":[{\"id\":\"custom:1\",\"title\":\"Mine\",\"type\":\"book\"},{\"id\":\"custom:2\",\"title\":\"theirs\",\"type\":\"game\"}],\"settings\":{\"style\":\"spoilers\"}}");
        JSONObject p = shared.absorb(local);
        Config merged = shared.copy().apply(p);
        assertEquals("the companion wins", "blocked", merged.state("Q1"));
        assertEquals("seen", merged.state("Q2"));
        assertEquals("all", merged.style());
        assertEquals(2, merged.custom.length()); // "theirs" is the companion's custom:1 already; "Mine" gets a new id
        assertEquals("Mine", merged.custom.getJSONObject(1).getString("title"));
        assertEquals("custom:2", merged.custom.getJSONObject(1).getString("id"));
        assertEquals("the entry moved with the renamed work", "seen", merged.state("custom:2"));
        assertEquals("blocked", merged.state("custom:1"));
        assertEquals(0, merged.absorb(local).length() == 0 ? 0 : merged.copy().apply(merged.absorb(local)).json().equals(merged.json()) ? 0 : 1);
    }

    @Test public void decisionRule() {
        // works 0..3; group A = {0,1}, B = {2}, C = {3}
        Config c = cfg("{\"works\":{\"w0\":{\"state\":\"seen\"},\"w1\":{\"state\":\"blocked\",\"style\":\"spoilers\"},\"w2\":{\"state\":\"seen\"}},\"settings\":{\"style\":\"all\"}}");
        Config.Works v = new Config.Works(c, new String[]{"w0", "w1", "w2", "w3"});
        assertTrue(v.anyBlocked);
        assertTrue(v.anySpoilers);
        assertEquals("blocked wins; only non-seen works decide the style", Config.STYLE_SPOILERS, Config.group(new int[]{0, 1}, v, false));
        assertEquals("all seen never covers", Config.NOT_COVERED, Config.group(new int[]{2}, v, true));
        assertEquals("unlisted covers with blockUnlisted", Config.STYLE_ALL, Config.group(new int[]{3}, v, true));
        assertEquals("unlisted alone does not without it", Config.NOT_COVERED, Config.group(new int[]{3}, v, false));
        assertEquals("one seen work shows an ambiguous name", Config.NOT_COVERED, Config.group(new int[]{2, 3}, v, true));
        assertEquals("any all-style work makes the group all", Config.STYLE_ALL, Config.group(new int[]{1, 3}, v, true));
        assertFalse(Config.coverUnknownImage(false, false, false));
        assertTrue(Config.coverUnknownImage(true, false, false));
        assertFalse("text about a seen work only", Config.coverUnknownImage(true, true, false));
        assertTrue(Config.coverUnknownImage(true, true, true));
    }

    @Test public void providerCallerCheck() {
        for (String ok : new String[]{"com.google.android.youtube", "app.morphe.android.youtube", "com.twitter.android", "com.instagram.android",
            "dev.spoilerblock.demo", "dev.spoilerblock.demo2", "dev.spoilerblock"}) assertTrue(ok, Store.allowed(ok));
        for (String no : new String[]{null, "", "com.evil", "com.twitter.android.evil", "dev.spoilerblock.demo3"}) assertFalse(String.valueOf(no), Store.allowed(no));
    }

    // ---------- learned (rule 11), as test/config.test.js ----------

    /** Key order differs between org.json builds: compare objects of arrays per key. */
    private static void assertJson(String expected, JSONObject actual) throws Exception {
        JSONObject e = new JSONObject(expected);
        assertEquals(e.length(), actual.length());
        for (java.util.Iterator<String> i = e.keys(); i.hasNext(); ) { String k = i.next(); assertEquals(k, e.get(k).toString(), actual.get(k).toString()); }
    }

    private static void assertEmpty(JSONObject l) throws Exception {
        assertEquals(2, l.length());
        assertEquals(0, l.getJSONObject("names").length());
        assertEquals(0, l.getJSONObject("not").length());
    }

    @Test public void learnedNormalisation() throws Exception {
        JSONObject l = Config.cleanLearned(new JSONObject("{\"names\":{\"Q1\":[\" BrBa \",\"brba\",\"x\",\"" + new String(new char[61]).replace('\0', 'y') + "\",3,\"Heisenberg show\"],"
            + "\"Q2\":[],\"__proto__\":[\"a\"],\"bad id\":[\"Name\"],\"Q3\":\"BrBa\"},"
            + "\"not\":{\"Q4\":[\"youtube.com/dokuzsekiz müzik\",\"x.com/@somebody\",\"reddit.com\",\"Reddit.com\",\"reddit.com\",\"nohost\",\"x.com/\",\"x.com/ \",7],\"Q5\":[\"bad\"]},"
            + "\"clips\":[{\"id\":\"c1\",\"work\":\"Q6\",\"ts\":5,\"emb\":[\"x\"]}]}"));
        assertJson("{\"Q1\":[\"BrBa\",\"Heisenberg show\"]}", l.getJSONObject("names"));
        assertEquals(new JSONArray(Arrays.asList("youtube.com/dokuzsekiz müzik", "x.com/@somebody", "reddit.com")).toString(), l.getJSONObject("not").getJSONArray("Q4").toString());
        assertEquals(1, l.getJSONObject("not").length());
        assertEquals(2, l.length());
        assertEmpty(Config.cleanLearned(null));
        JSONArray many = new JSONArray();
        for (int i = 0; i < 30; i++) many.put("Name " + i);
        assertEquals(20, Config.cleanNames(many).length());
        assertEquals("a stored config keeps it", l.toString(), cfg("{\"learned\":" + l + "}").learned.toString());
    }

    @Test public void learnedExportImportMergeReplace() throws Exception {
        Config cur = cfg("{\"learned\":{\"names\":{\"Q1\":[\"BrBa\"]},\"not\":{\"Q2\":[\"reddit.com\"]}}}");
        assertEquals(cur.learned.toString(), new JSONObject(cur.export("2026-11-21T00:00:00Z")).getJSONObject("learned").toString());
        Config in = Config.fromExport("{\"format\":\"spolierblock\",\"version\":1,\"learned\":{\"names\":{\"Q1\":[\"brba\",\"Walter show\"],\"Q9\":[\"Nine\"]},"
            + "\"not\":{\"Q2\":[\"x.com/@a\"]},\"clips\":[{\"id\":\"c1\",\"work\":\"Q3\",\"ts\":2,\"emb\":[\"x\"]}]}}");
        Config m = cur.copy();
        m.mergeImport(in, false);
        assertJson("{\"Q1\":[\"BrBa\",\"Walter show\"],\"Q9\":[\"Nine\"]}", m.learned.getJSONObject("names"));
        assertJson("{\"Q2\":[\"reddit.com\",\"x.com/@a\"]}", m.learned.getJSONObject("not"));
        assertFalse(m.learned.has("clips"));
        assertEmpty(Config.fromExport("{\"format\":\"spolierblock\",\"version\":1}").learned); // an older file has none
        assertEmpty(Config.mergeLearned(null, null));
        // Replace (Store.replace): the merge patch nulls what the file lacks, so the result is the file's
        Config r = cur.copy();
        JSONObject p = new JSONObject().put("learned", new JSONObject(in.learned.toString()));
        p.getJSONObject("learned").getJSONObject("names").put("Q1", new JSONArray().put("brba").put("Walter show"));
        r.apply(p);
        r.apply(new JSONObject("{\"learned\":{\"not\":{\"Q2\":null}}}"));
        assertJson("{\"Q1\":[\"brba\",\"Walter show\"],\"Q9\":[\"Nine\"]}", r.learned.getJSONObject("names"));
        assertEquals("{}", r.learned.getJSONObject("not").toString());
        // absorb: an app's own corrections join the companion's
        JSONObject ab = cur.absorb(in);
        assertJson("{\"Q2\":[\"reddit.com\",\"x.com/@a\"]}", cur.copy().apply(ab).learned.getJSONObject("not"));
    }

    @Test public void addNameMessages() throws Exception {
        Config c = cfg("{\"learned\":{\"names\":{\"Q1\":[\"BrBa\"]}}}");
        String[][] bad = {{"x", "A name is 2 to 60 characters."}, {" brba ", "\"brba\" is already one of its names."}};
        for (String[] b : bad) try { c.addName("Q1", b[0]); fail(b[0]); } catch (IllegalArgumentException e) { assertEquals(b[1], e.getMessage()); }
        c.apply(c.addName("Q1", "  Walter show "));
        assertEquals("[\"BrBa\",\"Walter show\"]", c.names("Q1").toString());
        for (int i = 0; i < 18; i++) c.apply(c.addName("Q1", "Name " + i));
        try { c.addName("Q1", "One more"); fail(); } catch (IllegalArgumentException e) { assertEquals("A work has at most 20 other names.", e.getMessage()); }
        c.apply(Config.learnedPatch("names", "Q1", new JSONArray()));
        assertEquals("an empty list removes the work", 0, c.learned.getJSONObject("names").length());
    }

    @Test public void notThisKeysAndDrop() throws Exception {
        assertEquals(Arrays.asList("x.com/@handle_1", "x.com"), Arrays.asList(Config.where("x.com", "@Handle_1")));
        assertEquals(Arrays.asList("youtube.com/dokuzsekiz müzik", "youtube.com"), Arrays.asList(Config.where("youtube.com", "DokuzSekiz Müzik")));
        assertEquals(Arrays.asList("instagram.com"), Arrays.asList(Config.where("instagram.com", null)));
        for (String k : Config.where("youtube.com", "DokuzSekiz Müzik")) assertTrue(k, Config.okKey(k));
        // the X author: the first piece that is exactly one @handle of 1-15 letters, digits or underscores
        TextCapture.Texts t = new TextCapture.Texts();
        for (String s : new String[]{"Some Name", "@toolong_handle_16", "@ two", "@Real_1", "@second"}) t.add(s);
        assertEquals("@Real_1", t.handle);
        // works 0..2; group A = {0,1}, B = {2}
        Config c = cfg("{\"learned\":{\"not\":{\"w0\":[\"x.com/@a\"],\"w1\":[\"x.com\"],\"w2\":[\"x.com/@b\"]}}}");
        Config.Works v = new Config.Works(c, new String[]{"w0", "w1", "w2"});
        assertTrue("every work has a key of the item", Config.notHere(new int[]{0, 1}, v, Config.where("x.com", "@A")));
        assertFalse("w0 is not dropped for another author", Config.notHere(new int[]{0, 1}, v, Config.where("x.com", "@b")));
        assertFalse(Config.notHere(new int[]{0}, v, Config.where("x.com", null)));
        assertTrue("a site key drops it for every source", Config.notHere(new int[]{1}, v, Config.where("x.com", "@zz")));
        assertFalse("another site", Config.notHere(new int[]{1}, v, Config.where("youtube.com", null)));
        assertTrue(Config.notHere(new int[]{2}, v, Config.where("x.com", "@B")));
        assertFalse("no learned.not: nothing dropped", Config.notHere(new int[]{0}, new Config.Works(cfg("{}"), new String[]{"w0"}), Config.where("x.com", "@a")));
    }
}
