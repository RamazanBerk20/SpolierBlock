package dev.spoilerblock;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotEquals;

import org.junit.Test;

/** "Show once" remembers the post by its own text: counters may tick, pictures and players may change. */
public class ShownKeyTest {
    @Test public void stableForThePost() {
        String a = Scanner.shownKey("@deniz\nElden Ring boss fights are brutal\n♥ 101\n", "\u0000123"),
            b = Scanner.shownKey("@deniz\nElden Ring boss fights are brutal\n♥ 1,204\n", "\u0000456");
        assertEquals(a, b);
        assertNotEquals(a, Scanner.shownKey("@deniz\nThe Last of Us finale was brutal\n♥ 101\n", "\u0000123"));
        // a post without words is known by its pictures
        assertEquals("\u0000\u0000123", Scanner.shownKey("12\n", "\u0000123"));
    }
}
