package dev.spoilerblock;

import android.content.ContentProvider;
import android.content.ContentValues;
import android.database.Cursor;
import android.net.Uri;
import android.os.Bundle;

/**
 * The shared config, for the patched apps. Exported without a permission because the patched apps are signed with
 * other keys than this app (a signature permission cannot work); instead only the known host packages are answered.
 * Two methods: "get" returns {json}, "patch" applies a JSON merge patch {json} and returns the result.
 * Every change is announced on Store.URI, which the apps observe.
 */
public final class ConfigProvider extends ContentProvider {
    @Override public boolean onCreate() { return true; }

    @Override public Bundle call(String method, String arg, Bundle extras) {
        String caller = getCallingPackage();
        if (!Store.allowed(caller)) throw new SecurityException("SpolierBlock does not share its settings with " + caller);
        return Store.get(getContext()).answer(method, extras == null ? new Bundle() : extras);
    }

    // Only call() is offered.
    @Override public Cursor query(Uri u, String[] p, String s, String[] a, String o) { return null; }
    @Override public String getType(Uri u) { return null; }
    @Override public Uri insert(Uri u, ContentValues v) { return null; }
    @Override public int delete(Uri u, String s, String[] a) { return 0; }
    @Override public int update(Uri u, ContentValues v, String s, String[] a) { return 0; }
}
