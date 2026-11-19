package dev.spoilerblock;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.json.JSONObject;
import org.junit.Test;

import java.io.File;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.regex.Pattern;

/** YouTube row descriptions lose their metadata tail (test/fixtures/yt-rows.jsonl: rows logged on the emulator). */
public class YouTubeTextTest {
    private static final File REPO = new File(System.getProperty("sb.dist")).getParentFile().getParentFile().getParentFile();

    @Test public void videoShortAndTurkish() {
        assertEquals("DİNİ BÜTÜN KÖY HALKI | RESIDENT EVIL 4 REMAKE | - RRaenee", YouTubeText.strip(
            "DİNİ BÜTÜN KÖY HALKI | RESIDENT EVIL 4 REMAKE | - 1 hour, 45 minutes, 23 seconds - Go to channel RRaenee - RRaenee - 934 thousand views - 3 years ago - play video"));
        assertEquals("RESIDENT EVIL 4 REMAKE Gameplay Walkthrough FULL GAME [4K 60FPS] - No Commentary - MKIceAndFire", YouTubeText.strip(
            "RESIDENT EVIL 4 REMAKE Gameplay Walkthrough FULL GAME [4K 60FPS] - No Commentary - 14 hours, 12 minutes, 18 seconds - Go to channel MKIceAndFire - MKIceAndFire - 1.7 million views - 8 months ago - play video"));
        assertEquals("Iron Golem Build Battle Noob vs Pro vs Hacker vs God (Minecraft) - Athos", YouTubeText.strip(
            "Iron Golem Build Battle Noob vs Pro vs Hacker vs God (Minecraft), 225 thousand views, Athos, 1 day ago - play Short"));
        assertEquals("[Resident Evil 4 Remake] Kill All Enemies (1,052 Kills), Professional, No Save No Damage, S+ Rank - Aether", YouTubeText.strip(
            "[Resident Evil 4 Remake] Kill All Enemies (1,052 Kills), Professional, No Save No Damage, S+ Rank - 5 hours, 52 minutes, 45 seconds - Go to channel Aether - Aether - 532 thousand views - 1 year ago - play video"));
        // Turkish, as YouTube 21.30 writes it (emulator, app language tr-TR)
        assertEquals("cook and chill \uD83D\uDC3C smooth lofi music to listening in the kitchen - little lofi panda", YouTubeText.strip(
            "cook and chill \uD83D\uDC3C smooth lofi music to listening in the kitchen - 1 saat 5 dakika 52 saniye - Kanala git: little lofi panda  - little lofi panda  - 85 bin görüntüleme - 2 yıl önce - 10 ürün - videoyu oynat"));
        assertEquals("DİNİ BÜTÜN KÖY HALKI | RESIDENT EVIL 4 REMAKE | - RRaenee", YouTubeText.strip(
            "DİNİ BÜTÜN KÖY HALKI | RESIDENT EVIL 4 REMAKE | - 1 saat 45 dakika 23 saniye - Kanala git: RRaenee - RRaenee - 934 bin görüntüleme - 3 yıl önce - videoyu oynat"));
        assertEquals("POV: YOU HAVE A FAVE BIOME, Minecraft", YouTubeText.strip( // a Short: "title, channel - views - age - play"
            "POV: YOU HAVE A FAVE BIOME, Minecraft - 1,2 milyon görüntüleme - 1 gün önce - kısa videoyu oynat"));
        assertEquals("The POW Show: Challenges & Trivia - Minecraft", YouTubeText.strip( // an official channel: an empty button label
            "The POW Show: Challenges & Trivia - 2 saat 5 dakika 25 saniye -  - Minecraft - 462 bin görüntüleme - 3 gün önce yayınlandı - videoyu oynat"));
        // a channel label with the name first, as other languages write it
        assertEquals("Battlefield Oyunlarının Evrimi - GameScape", YouTubeText.strip(
            "Battlefield Oyunlarının Evrimi - 10 dakika 29 saniye - GameScape kanalına git - GameScape - 11 B görüntüleme - 1 yıl önce - videoyu oynat"));
        assertEquals("Minecraft'ın gizli zırhı - camman18", YouTubeText.strip(
            "Minecraft'ın gizli zırhı, 3,3 Mn görüntüleme, camman18, 1 gün önce - Short'u oynat"));
        // neither shape: unchanged
        String ad = "Sponsored - Spotify: Music and Podcasts - 11 seconds - Ücretsiz Müzik Dinle - 4.5 stars";
        assertEquals(ad, YouTubeText.strip(ad));
        assertEquals("Lost - Lost season 6 was a mess", YouTubeText.strip("Lost - Lost season 6 was a mess"));
    }

    /** Every logged row's description: no duration, view count, age or button phrase is left when a shape was found. */
    @Test public void loggedRows() throws Exception {
        Pattern tail = Pattern.compile("\\d+ (seconds?|minutes?|hours?)\\b|\\bviews\\b|\\bago\\b|play video|play Short|Go to channel");
        int stripped = 0;
        for (String line : Files.readAllLines(new File(REPO, "test/fixtures/yt-rows.jsonl").toPath(), StandardCharsets.UTF_8)) {
            for (String cd : new JSONObject(line).getString("text").split("\u0001")[0].split("\n")) {
                if (!cd.contains(" - play video") && !cd.contains(" - play Short")) continue;
                if (cd.startsWith("Sponsored")) continue; // ads keep their text
                String s = YouTubeText.strip(cd);
                assertFalse(cd + " -> " + s, tail.matcher(s).find());
                assertTrue(cd + " -> " + s, cd.startsWith(s.substring(0, Math.max(0, s.lastIndexOf(" - "))))); // the title, unchanged
                stripped++;
            }
        }
        assertTrue("rows checked: " + stripped, stripped >= 40);
    }
}
