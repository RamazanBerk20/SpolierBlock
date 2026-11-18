package dev.spoilerblock;

import android.media.AudioTrack;
import android.media.MediaPlayer;
import android.util.Log;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.WeakHashMap;

/**
 * Silences what a cover hides. The patch sends the app's own AudioTrack.play/setVolume/setStereoVolume and
 * MediaPlayer.start/setVolume calls through here (the call sites name framework methods, which obfuscation never
 * renames; ExoPlayer/Media3 inside the apps plays through AudioTrack). Every player that started is remembered weakly
 * with the volume the app last asked for; while muted every player gets volume 0, and the app's own volume changes
 * meanwhile are only remembered. Unmuting restores them. Only the players' own volume is touched: never the device's
 * stream volume nor the user's mute state. Any error passes the app's call through unchanged (fail open).
 */
public final class Media {
    private Media() { }

    private static final Map<Object, float[]> players = new WeakHashMap<>(); // player -> {left, right} the app asked for
    private static boolean muted;

    // ---------- the app's calls (any thread) ----------

    public static void play(AudioTrack t) {
        track(t);
        t.play();
    }

    public static int setVolume(AudioTrack t, float v) {
        return volume(t, v, v) ? t.setVolume(0) : t.setVolume(v);
    }

    @SuppressWarnings("deprecation")
    public static int setStereoVolume(AudioTrack t, float l, float r) {
        return volume(t, l, r) ? t.setStereoVolume(0, 0) : t.setStereoVolume(l, r);
    }

    public static void start(MediaPlayer p) {
        track(p);
        p.start();
    }

    public static void setVolume(MediaPlayer p, float l, float r) {
        if (volume(p, l, r)) p.setVolume(0, 0); else p.setVolume(l, r);
    }

    /** Remembers a starting player; silences it at once when a cover is up. */
    private static void track(Object p) {
        try {
            boolean m;
            synchronized (players) {
                if (!players.containsKey(p)) players.put(p, new float[]{1, 1});
                m = muted && !SpoilerBlock.dead;
            }
            if (m) apply(p, 0, 0);
        } catch (Throwable t) {
            Log.w(SpoilerBlock.TAG, "audio: " + t);
        }
    }

    /** Remembers the volume the app asked for; true when the player must stay silent instead. */
    private static boolean volume(Object p, float l, float r) {
        try {
            synchronized (players) {
                players.put(p, new float[]{l, r});
                return muted && !SpoilerBlock.dead;
            }
        } catch (Throwable t) {
            return false;
        }
    }

    // ---------- the blocker's side (main thread) ----------

    static boolean muted() { synchronized (players) { return muted; } }

    /** Mutes or restores every known player; a no-op when nothing changes. */
    static void setMuted(boolean on) {
        List<Object[]> todo = new ArrayList<>();
        synchronized (players) {
            if (on == muted) return;
            muted = on;
            for (Map.Entry<Object, float[]> e : players.entrySet()) todo.add(new Object[]{e.getKey(), on ? new float[]{0, 0} : e.getValue()});
        }
        for (Object[] t : todo) apply(t[0], ((float[]) t[1])[0], ((float[]) t[1])[1]);
        Log.i(SpoilerBlock.TAG, (on ? "audio muted under a cover: " : "audio restored: ") + todo.size() + " players");
    }

    @SuppressWarnings("deprecation")
    private static void apply(Object p, float l, float r) {
        try {
            if (p instanceof AudioTrack) ((AudioTrack) p).setStereoVolume(l, r); // a released track just reports an error
            else ((MediaPlayer) p).setVolume(l, r);
        } catch (Throwable ignored) { } // a released player: nothing to silence
    }
}
