package dev.spoilerblock;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

import java.io.File;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.ArrayList;
import java.util.List;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/** Hand-added works are indexed as the extension indexes them (src/background/catalog-update.js customWorks). */
public class CustomWorkTest {
    private static final File DIST = new File(System.getProperty("sb.dist")); // <repo>/dist/firefox/data
    private static final File REPO = DIST.getParentFile().getParentFile().getParentFile();

    @Test public void samePopularityAsTheExtension() throws Exception {
        String js = new String(Files.readAllBytes(new File(REPO, "src/background/catalog-update.js").toPath()), StandardCharsets.UTF_8);
        Matcher m = Pattern.compile("export const CUSTOM_POP = (\\d+);").matcher(js);
        assertTrue("CUSTOM_POP in catalog-update.js", m.find());
        assertEquals(Integer.parseInt(m.group(1)), SpoilerBlock.CUSTOM_POP);
    }

    @Test public void customWorksMatchInAnyCase() throws Exception {
        String words = new String(Files.readAllBytes(new File(DIST, "common-words.txt").toPath()), StandardCharsets.UTF_8);
        Config c = Config.parse("{\"custom\":[{\"id\":\"custom:1\",\"title\":\"Zorvak Saga\",\"aliases\":[\"ZS\",\"Zorvak\"],\"type\":\"game\"},"
            + "{\"id\":\"custom:2\",\"title\":\"Time\",\"type\":\"movie\"}]}");
        List<Catalog.Work> works = SpoilerBlock.customWorks(c, new Catalog.Ambiguity(words));
        assertEquals(SpoilerBlock.CUSTOM_POP, works.get(0).pop, 0);
        assertArrayEquals("aliases as given, like the extension", new String[]{"ZS", "Zorvak"}, works.get(0).aliases);
        assertFalse(works.get(0).ambiguous);
        assertTrue("one everyday word: ambiguous, as makeAmbiguous says", works.get(1).ambiguous);
        Catalog.Built b = Catalog.buildIndex(Catalog.merge(new ArrayList<>(), works), new Catalog.Words(words));
        dev.spoilerblock.Matcher mm = new dev.spoilerblock.Matcher(b.bin, b.json);
        boolean[] none = new boolean[mm.ids.length];
        assertEquals("a popular work's name matches in lower case", 1, mm.evaluate("cant stop playing zorvak saga lol", none).length);
        assertEquals(1, mm.evaluate("Zorvak Saga ending explained", none).length);
    }
}
