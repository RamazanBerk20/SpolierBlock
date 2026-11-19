package dev.spoilerblock;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.regex.Pattern;

/**
 * A YouTube result row's content description is its title followed by metadata in a fixed order, joined with " - ":
 * "title - duration - {go to channel C} - C - views - age - {play video}"; a Short is "title, views, C, age - {play
 * Short}" in English and "title, C - views - age - {play Short}" in Turkish. The metadata (durations, view counts, ages,
 * button phrases) reaches the matcher as text, so it is cut off here, keeping the title and the channel name once.
 * Locale-independent: the anchors are structure, not phrases. The views and the age are two neighbouring parts that
 * start with a number; the channel is the part before them; before the channel, an empty part, a part that holds the
 * channel's name as its first or last words (the localised "go to channel" button) and a duration are metadata too.
 * A description that fits no shape (ads, other apps' strings) is returned unchanged.
 */
final class YouTubeText {
    private YouTubeText() { }

    // "1 hour, 45 minutes, 23 seconds", "1 saat 45 dakika 23 saniye": numbers, each followed by one word
    private static final Pattern DURATION = Pattern.compile("\\d+\\s+\\p{L}+((\\s*,)?\\s+\\d+\\s+\\p{L}+)*");
    // "223 thousand views", "1,2 milyon görüntüleme", "20 hours ago", "3 gün önce yayınlandı": a number, then up to three words
    private static final Pattern COUNT = Pattern.compile("\\d[\\d.,\\u00a0]*\\s*\\p{L}*\\.?(\\s+\\p{L}+\\.?){0,3}");

    private static boolean count(String s) { return COUNT.matcher(s.trim()).matches(); }

    static String strip(String cd) {
        if (cd == null) return null;
        String[] seg = cd.split(" - ", -1);
        // views and age: the channel comes right before them
        for (int v = 1; v + 1 < seg.length; v++) {
            if (!count(seg[v]) || !count(seg[v + 1])) continue;
            String c = seg[v - 1].trim();
            if (v == 1) return c; // "title, channel" in one part (a Short)
            List<String> head = new ArrayList<>(Arrays.asList(seg).subList(0, v - 1));
            while (head.size() > 1) {
                String last = head.get(head.size() - 1).trim();
                if (last.isEmpty() || names(last, c) || DURATION.matcher(last).matches()) head.remove(head.size() - 1);
                else break;
            }
            return String.join(" - ", head) + " - " + c;
        }
        // no counts (a live video, a channel without views): the "go to channel" label and its name
        for (int k = 1; k + 1 < seg.length; k++) {
            String c = seg[k + 1].trim();
            if (!names(seg[k].trim(), c)) continue;
            int end = k; // the title is seg[0 .. end)
            if (end > 1 && DURATION.matcher(seg[end - 1].trim()).matches()) end--;
            return String.join(" - ", Arrays.copyOfRange(seg, 0, end)) + " - " + c;
        }
        // an English Short: "title, views, channel, age" before the last " - " (the play button's label)
        int dash = cd.lastIndexOf(" - ");
        if (dash > 0) {
            String[] p = cd.substring(0, dash).split(", ", -1);
            int n = p.length;
            if (n >= 4 && count(p[n - 1]) && count(p[n - 3]) && !p[n - 2].trim().isEmpty())
                return String.join(", ", Arrays.copyOfRange(p, 0, n - 3)) + " - " + p[n - 2].trim();
        }
        return cd;
    }

    /** Whether a part is a button label naming the channel: the name as its first or last words, and more. */
    private static boolean names(String part, String channel) {
        return channel.length() >= 2 && !part.equals(channel) && (part.endsWith(" " + channel) || part.startsWith(channel + " "));
    }
}
