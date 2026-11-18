package dev.spoilerblock;

import android.app.Notification;
import android.app.NotificationManager;
import android.os.Bundle;
import android.os.Looper;
import android.os.Parcelable;
import android.util.Log;

/**
 * Push notifications the host app posts (a direct message, a reply, a "new video" alert) can carry a spoiler in their
 * preview. The patch sends every NotificationManager.notify call of the app's own code through here (the call sites
 * name the framework method, which no obfuscation renames). A notification whose text the decision rule covers is
 * posted with its text replaced; anything else, and any error, posts the original: a notification is never lost.
 */
public final class Notifications {
    private Notifications() { }

    public static void notify(NotificationManager nm, int id, Notification n) { nm.notify(id, guard(n)); }

    public static void notify(NotificationManager nm, String tag, int id, Notification n) { nm.notify(tag, id, guard(n)); }

    static Notification guard(Notification n) {
        SpoilerBlock sb = SpoilerBlock.I;
        if (sb == null || SpoilerBlock.dead || n == null || n.extras == null) return n;
        try {
            if (!sb.store.get().bool("enabled")) return n;
            String title = str(n.extras.getCharSequence(Notification.EXTRA_TITLE)), text = text(n);
            if (text.trim().isEmpty() && title.isEmpty()) return n;
            // a push can arrive before any activity: load the index here (off the main thread it may wait a little)
            Matcher m = sb.matcherNow(Looper.myLooper() == Looper.getMainLooper() ? 300 : 4000);
            if (m == null) { Log.w(SpoilerBlock.TAG, "notification posted unchecked: the title index is not loaded"); return n; }
            String why = sb.textCover(m, title + "\n" + text);
            if (why == null) return n;
            boolean titleToo = sb.textCover(m, title) != null;
            Notification.Builder b = Notification.Builder.recoverBuilder(sb.app, n);
            String note = why + ". Open the app and tap “Show once” to read it.";
            b.setContentText(why).setStyle(new Notification.BigTextStyle().bigText(note)).setSubText(null).setTicker(null);
            if (titleToo) b.setContentTitle("SpolierBlock");
            Notification out = b.build();
            out.publicVersion = null; // the lock-screen version may quote the text too
            Log.i(SpoilerBlock.TAG, "notification text hidden: " + why);
            return out;
        } catch (Throwable t) {
            Log.w(SpoilerBlock.TAG, "notification posted unchanged after an error", t);
            return n;
        }
    }

    /** Everything a notification can show as text: the body, the big text, inbox lines, conversation messages. */
    static String text(Notification n) {
        Bundle e = n.extras;
        StringBuilder s = new StringBuilder();
        for (String k : new String[]{Notification.EXTRA_TEXT, Notification.EXTRA_BIG_TEXT, Notification.EXTRA_SUB_TEXT,
            Notification.EXTRA_SUMMARY_TEXT, Notification.EXTRA_CONVERSATION_TITLE, Notification.EXTRA_INFO_TEXT}) s.append(str(e.getCharSequence(k))).append('\n');
        CharSequence[] lines = e.getCharSequenceArray(Notification.EXTRA_TEXT_LINES);
        if (lines != null) for (CharSequence l : lines) s.append(str(l)).append('\n');
        Parcelable[] msgs = e.getParcelableArray(Notification.EXTRA_MESSAGES);
        if (msgs != null) for (Parcelable p : msgs) if (p instanceof Bundle) s.append(str(((Bundle) p).getCharSequence("text"))).append('\n');
        s.append(str(n.tickerText));
        return s.toString();
    }

    private static String str(CharSequence c) { return c == null ? "" : c.toString(); }
}
