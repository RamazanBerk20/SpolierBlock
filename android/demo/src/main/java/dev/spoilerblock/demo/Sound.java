package dev.spoilerblock.demo;

import android.media.AudioAttributes;
import android.media.AudioFormat;
import android.media.AudioTrack;
import android.util.Log;
import android.view.View;
import android.view.ViewGroup;

import androidx.recyclerview.widget.RecyclerView;

import java.io.File;
import java.io.FileOutputStream;
import java.lang.reflect.Method;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;

/**
 * Sound for the demo's players (AudioTrack in the feed, MediaPlayer in the reels, the two APIs the real apps play
 * through) and the per-frame check that a covered player is silent: while any attached item holding a video surface is
 * covered the blocker must have the app's players muted, and not otherwise. The blocker's state is read by reflection
 * (dev.spoilerblock.Media.muted(), present only in the patched build); the volume actually applied shows in
 * `dumpsys audio`.
 */
final class Sound {
    static long checks, mismatches;
    private static Method muted;
    private static boolean last;

    /** A one-second 440 Hz tone, looping for ever, quiet. */
    static AudioTrack tone() {
        int rate = 22050, n = rate;
        short[] pcm = new short[n];
        for (int i = 0; i < n; i++) pcm[i] = (short) (Math.sin(2 * Math.PI * 440 * i / rate) * 3000);
        AudioTrack t = new AudioTrack.Builder()
            .setAudioAttributes(new AudioAttributes.Builder().setUsage(AudioAttributes.USAGE_MEDIA).setContentType(AudioAttributes.CONTENT_TYPE_MOVIE).build())
            .setAudioFormat(new AudioFormat.Builder().setEncoding(AudioFormat.ENCODING_PCM_16BIT).setSampleRate(rate).setChannelMask(AudioFormat.CHANNEL_OUT_MONO).build())
            .setTransferMode(AudioTrack.MODE_STATIC).setBufferSizeInBytes(n * 2).build();
        t.write(pcm, 0, n);
        t.setLoopPoints(0, n, -1);
        return t;
    }

    /** The same tone as a WAV file, for MediaPlayer. */
    static File wav(android.content.Context c) throws Exception {
        File f = new File(c.getCacheDir(), "tone.wav");
        if (f.exists()) return f;
        int rate = 22050, n = rate;
        ByteBuffer b = ByteBuffer.allocate(44 + n * 2).order(ByteOrder.LITTLE_ENDIAN);
        b.put("RIFF".getBytes()).putInt(36 + n * 2).put("WAVEfmt ".getBytes()).putInt(16).putShort((short) 1).putShort((short) 1)
            .putInt(rate).putInt(rate * 2).putShort((short) 2).putShort((short) 16).put("data".getBytes()).putInt(n * 2);
        for (int i = 0; i < n; i++) b.putShort((short) (Math.sin(2 * Math.PI * 330 * i / rate) * 3000));
        try (FileOutputStream o = new FileOutputStream(f)) { o.write(b.array()); }
        return f;
    }

    /**
     * Every drawn frame: muted iff an attached item with a video surface is covered and no uncovered player is at least
     * half on screen (a list item's or the given pinned one: the video the user chose plays aloud next to a covered post).
     */
    static void check(RecyclerView rv, String where) { check(rv, where, null); }

    static void check(RecyclerView rv, String where, View pinned) {
        boolean covered = false, open = pinned != null && halfShown(video(pinned));
        for (int i = 0; i < rv.getChildCount(); i++) {
            View v = rv.getChildAt(i), t = video(v);
            if (t == null) continue;
            if (MainActivity.covered(v)) covered = true; else open |= halfShown(t);
        }
        boolean want = covered && !open;
        Boolean got = muted();
        if (got == null) return; // not patched
        checks++;
        if (got != want) {
            mismatches++;
            Log.e(MainActivity.TAG, "AUDIO MISMATCH " + where + " frame " + MainActivity.frames + " muted=" + got + " covered video=" + covered + " uncovered video=" + open);
        }
        if (got != last) Log.i(MainActivity.TAG, "AUDIO " + where + (got ? " muted" : " audible"));
        last = got;
    }

    private static boolean halfShown(View t) {
        android.graphics.Rect r = new android.graphics.Rect();
        return t != null && t.isShown() && t.getGlobalVisibleRect(r) && (long) r.width() * r.height() * 2 >= (long) t.getWidth() * t.getHeight();
    }

    private static View video(View v) {
        if (v instanceof android.view.TextureView) return v;
        if (v instanceof ViewGroup) for (int i = 0; i < ((ViewGroup) v).getChildCount(); i++) { View t = video(((ViewGroup) v).getChildAt(i)); if (t != null) return t; }
        return null;
    }

    static Boolean muted() {
        try {
            if (muted == null) { muted = Class.forName("dev.spoilerblock.Media").getDeclaredMethod("muted"); muted.setAccessible(true); }
            return (Boolean) muted.invoke(null);
        } catch (Throwable t) {
            return null;
        }
    }
}
