package dev.spoilerblock;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.util.Arrays;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Iterator;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * The 0.2 config of docs/agents/contract.md: {works, custom, settings}. Every way in (stored JSON, the companion's
 * answer, an imported file, a patch) goes through the same normalisation, so the rest of the code can trust its shape.
 * Changes are JSON merge patches (RFC 7386): objects merge per key, null deletes, arrays replace. The companion's
 * provider applies them atomically, so two apps writing at once never lose each other's entries.
 */
final class Config {
    static final List<String> TYPES = Arrays.asList("movie", "tv", "game", "book", "anime", "manga", "comic");
    static final List<String> CATALOG_MODES = Arrays.asList("off", "daily", "weekly", "monthly");
    static final String SEEN = "seen", BLOCKED = "blocked", ALL = "all", SPOILERS = "spoilers";

    final JSONObject works = new JSONObject();
    JSONArray custom = new JSONArray();
    final JSONObject settings = new JSONObject();

    Config() { this(new JSONObject()); }

    /** Normalised copy: invalid entries are dropped, unknown keys ignored, missing settings take their defaults. */
    Config(JSONObject o) {
        try {
            settings.put("enabled", true).put("scanImages", true).put("blockUnlisted", true).put("style", ALL)
                .put("unknownImages", false).put("pausedSites", new JSONArray()).put("catalogUpdate", "off");
            JSONObject w = o.optJSONObject("works");
            if (w != null) for (Iterator<String> i = w.keys(); i.hasNext(); ) {
                String id = i.next();
                JSONObject e = work(w.optJSONObject(id));
                if (e != null && !id.isEmpty()) works.put(id, e);
            }
            JSONArray c = o.optJSONArray("custom");
            if (c != null) {
                Set<String> ids = new HashSet<>();
                for (int i = 0; i < c.length(); i++) {
                    JSONObject e = customWork(c.optJSONObject(i));
                    if (e != null && ids.add(e.getString("id"))) custom.put(e);
                }
            }
            JSONObject s = o.optJSONObject("settings");
            if (s != null) applySettings(s);
        } catch (JSONException e) {
            throw new IllegalStateException(e); // only puts of valid values above
        }
    }

    static Config parse(String json) {
        if (json == null || json.isEmpty()) return new Config();
        try {
            return new Config(new JSONObject(json));
        } catch (JSONException e) {
            return new Config();
        }
    }

    JSONObject toJson() {
        try {
            return new JSONObject().put("works", works).put("custom", custom).put("settings", settings);
        } catch (JSONException e) {
            throw new IllegalStateException(e);
        }
    }

    String json() { return toJson().toString(); }

    Config copy() { return parse(json()); }

    // ---------- validation ----------

    private static JSONObject work(JSONObject e) throws JSONException {
        if (e == null) return null;
        String state = e.optString("state");
        if (!SEEN.equals(state) && !BLOCKED.equals(state)) return null;
        JSONObject out = new JSONObject().put("state", state);
        String style = e.isNull("style") ? null : e.optString("style");
        out.put("style", ALL.equals(style) || SPOILERS.equals(style) ? style : JSONObject.NULL);
        Object title = e.opt("title");
        out.put("title", title instanceof String ? title : JSONObject.NULL);
        String type = e.optString("type");
        out.put("type", TYPES.contains(type) ? type : JSONObject.NULL);
        Object year = e.opt("year");
        out.put("year", year instanceof Number && ((Number) year).intValue() > 0 ? ((Number) year).intValue() : JSONObject.NULL);
        Object ts = e.opt("ts");
        out.put("ts", ts instanceof Number ? ((Number) ts).longValue() : 0);
        return out;
    }

    private static JSONObject customWork(JSONObject e) throws JSONException {
        if (e == null) return null;
        String id = e.optString("id"), title = e.optString("title").trim();
        if (!id.matches("custom:\\d+") || title.isEmpty()) return null;
        JSONArray aliases = new JSONArray();
        JSONArray a = e.optJSONArray("aliases");
        if (a != null) for (int i = 0; i < a.length() && aliases.length() < 8; i++) {
            Object x = a.opt(i);
            if (x instanceof String && !((String) x).trim().isEmpty()) aliases.put(((String) x).trim());
        }
        String type = e.optString("type");
        return new JSONObject().put("id", id).put("title", title).put("aliases", aliases).put("type", TYPES.contains(type) ? type : "movie");
    }

    private void applySettings(JSONObject s) throws JSONException {
        for (String k : new String[]{"enabled", "scanImages", "blockUnlisted", "unknownImages"}) {
            Object v = s.opt(k);
            if (v instanceof Boolean) settings.put(k, v);
        }
        String style = s.optString("style");
        if (ALL.equals(style) || SPOILERS.equals(style)) settings.put("style", style);
        String cu = s.optString("catalogUpdate");
        if (CATALOG_MODES.contains(cu)) settings.put("catalogUpdate", cu);
        JSONArray ps = s.optJSONArray("pausedSites");
        if (ps != null) {
            JSONArray out = new JSONArray();
            for (int i = 0; i < ps.length(); i++) if (ps.opt(i) instanceof String) out.put(ps.opt(i));
            settings.put("pausedSites", out);
        }
    }

    // ---------- reading ----------

    boolean bool(String key) { return settings.optBoolean(key); }
    String style() { return settings.optString("style", ALL); }
    String catalogUpdate() { return settings.optString("catalogUpdate", "off"); }
    JSONObject work(String id) { return works.optJSONObject(id); }
    String state(String id) { JSONObject e = works.optJSONObject(id); return e == null ? null : e.optString("state"); }

    /** "all" or "spoilers": the work's own style, else the default. */
    String effectiveStyle(String id) {
        JSONObject e = works.optJSONObject(id);
        return e == null || e.isNull("style") ? style() : e.optString("style");
    }

    int nextCustomId() {
        int max = 0;
        for (int i = 0; i < custom.length(); i++) max = Math.max(max, Integer.parseInt(custom.optJSONObject(i).optString("id").substring(7)));
        return max + 1;
    }

    // ---------- changes ----------

    /** Applies a merge patch (in place) and returns this. Values are normalised like a loaded config. */
    Config apply(JSONObject patch) {
        try {
            JSONObject w = patch.optJSONObject("works");
            if (w != null) for (Iterator<String> i = w.keys(); i.hasNext(); ) {
                String id = i.next();
                if (w.isNull(id)) { works.remove(id); continue; }
                JSONObject base = works.optJSONObject(id), change = w.optJSONObject(id);
                if (change == null) continue;
                JSONObject merged = base == null ? new JSONObject() : new JSONObject(base.toString());
                for (Iterator<String> k = change.keys(); k.hasNext(); ) { String key = k.next(); merged.put(key, change.opt(key)); }
                JSONObject e = work(merged);
                if (e != null) works.put(id, e);
            }
            if (patch.has("custom")) custom = new Config(new JSONObject().put("custom", patch.optJSONArray("custom"))).custom;
            JSONObject s = patch.optJSONObject("settings");
            if (s != null) applySettings(s);
            return this;
        } catch (JSONException e) {
            throw new IllegalArgumentException(e);
        }
    }

    static JSONObject workPatch(String id, JSONObject entry) {
        try {
            return new JSONObject().put("works", new JSONObject().put(id, entry == null ? JSONObject.NULL : entry));
        } catch (JSONException e) {
            throw new IllegalStateException(e);
        }
    }

    static JSONObject settingPatch(String key, Object value) {
        try {
            return new JSONObject().put("settings", new JSONObject().put(key, value));
        } catch (JSONException e) {
            throw new IllegalStateException(e);
        }
    }

    static JSONObject entry(String state, String style, String title, String type, int year, long ts) {
        try {
            return new JSONObject().put("state", state).put("style", style == null ? JSONObject.NULL : style)
                .put("title", title == null ? JSONObject.NULL : title).put("type", type == null ? JSONObject.NULL : type)
                .put("year", year > 0 ? year : JSONObject.NULL).put("ts", ts);
        } catch (JSONException e) {
            throw new IllegalStateException(e);
        }
    }

    // ---------- 0.1 migration ----------

    /** 0.1 preferences: a "seen" set of ids, "mode" any|spoiler, "enabled", "scanImages", "catalogMode". */
    static Config migrate(Set<String> seen, String mode, boolean enabled, boolean scanImages, String catalogMode, long now) {
        Config c = new Config();
        try {
            if (seen != null) for (String id : seen) c.works.put(id, entry(SEEN, null, null, null, 0, now));
            c.settings.put("style", "spoiler".equals(mode) ? SPOILERS : ALL).put("enabled", enabled).put("scanImages", scanImages);
            if (CATALOG_MODES.contains(catalogMode)) c.settings.put("catalogUpdate", catalogMode);
        } catch (JSONException e) {
            throw new IllegalStateException(e);
        }
        return c;
    }

    // ---------- export file ----------

    static final String FILE_NAME = "spolierblock-config.json";

    String export(String isoNow) {
        try {
            JSONObject o = new JSONObject().put("format", "spolierblock").put("version", 1).put("exportedAt", isoNow);
            return o.put("works", works).put("custom", custom).put("settings", settings).toString(2);
        } catch (JSONException e) {
            throw new IllegalStateException(e);
        }
    }

    /** The file's config, or IllegalArgumentException with a message for the user. */
    static Config fromExport(String text) {
        JSONObject o;
        try {
            o = new JSONObject(text);
        } catch (JSONException | NullPointerException e) {
            throw new IllegalArgumentException("This is not a SpolierBlock settings file.");
        }
        if (!"spolierblock".equals(o.opt("format"))) throw new IllegalArgumentException("This is not a SpolierBlock settings file.");
        Object v = o.opt("version");
        if (!(v instanceof Number) || ((Number) v).doubleValue() < 1) throw new IllegalArgumentException("This settings file has no valid version.");
        if (((Number) v).doubleValue() > 1) throw new IllegalArgumentException("This settings file comes from a newer SpolierBlock. Update the app first.");
        return new Config(o);
    }

    /** Import "Merge": the imported entries win per id; settings only when asked. Custom works are matched by id. */
    void mergeImport(Config in, boolean settingsToo) {
        try {
            for (Iterator<String> i = in.works.keys(); i.hasNext(); ) { String id = i.next(); works.put(id, in.works.get(id)); }
            Map<String, Integer> at = new HashMap<>();
            for (int i = 0; i < custom.length(); i++) at.put(custom.getJSONObject(i).getString("id"), i);
            for (int i = 0; i < in.custom.length(); i++) {
                JSONObject e = in.custom.getJSONObject(i);
                Integer k = at.get(e.getString("id"));
                if (k != null) custom.put(k, e); else custom.put(e);
            }
            if (settingsToo) applySettings(in.settings);
        } catch (JSONException e) {
            throw new IllegalStateException(e);
        }
    }

    /**
     * One-time merge of an app's own list into the companion's (this): the companion's entries win, the app adds what
     * the companion lacks. An app's custom work whose id is taken by a different work gets a fresh id (and its entry
     * moves with it). Settings stay the companion's. Returns the merge patch to send.
     */
    JSONObject absorb(Config local) {
        try {
            JSONObject w = new JSONObject();
            JSONArray c = new JSONArray(custom.toString());
            Map<String, String> renamed = new HashMap<>();
            Map<String, JSONObject> byId = new HashMap<>();
            for (int i = 0; i < custom.length(); i++) byId.put(custom.getJSONObject(i).getString("id"), custom.getJSONObject(i));
            int next = nextCustomId();
            for (int i = 0; i < local.custom.length(); i++) {
                JSONObject e = new JSONObject(local.custom.getJSONObject(i).toString());
                String id = e.getString("id");
                JSONObject same = null;
                for (JSONObject x : byId.values()) if (x.getString("title").equalsIgnoreCase(e.getString("title")) && x.getString("type").equals(e.getString("type"))) same = x;
                if (same != null) { renamed.put(id, same.getString("id")); continue; } // already there
                if (byId.containsKey(id)) { renamed.put(id, "custom:" + next); e.put("id", "custom:" + next++); }
                byId.put(e.getString("id"), e);
                c.put(e);
            }
            for (Iterator<String> i = local.works.keys(); i.hasNext(); ) {
                String id = i.next();
                String to = renamed.containsKey(id) ? renamed.get(id) : id;
                if (!works.has(to)) w.put(to, local.works.get(id));
            }
            JSONObject p = new JSONObject();
            if (w.length() > 0) p.put("works", w);
            if (c.length() != custom.length()) p.put("custom", c);
            return p;
        } catch (JSONException e) {
            throw new IllegalStateException(e);
        }
    }

    // ---------- decision rule (contract steps 1-3, 6) ----------

    /** The config seen through one index: per work index, its state and effective style. */
    static final class Works {
        static final byte UNLISTED = 0, IS_SEEN = 1, IS_BLOCKED = 2;
        final byte[] state;
        final boolean[] seen, all;
        boolean anyBlocked, anySpoilers;

        Works(Config c, String[] ids) {
            state = new byte[ids.length];
            seen = new boolean[ids.length];
            all = new boolean[ids.length];
            boolean defAll = ALL.equals(c.style());
            anySpoilers = !defAll;
            for (int w = 0; w < ids.length; w++) {
                JSONObject e = c.works.optJSONObject(ids[w]);
                all[w] = defAll;
                if (e == null) continue;
                String s = e.optString("state");
                state[w] = SEEN.equals(s) ? IS_SEEN : BLOCKED.equals(s) ? IS_BLOCKED : UNLISTED;
                seen[w] = state[w] == IS_SEEN;
                anyBlocked |= state[w] == IS_BLOCKED;
                if (!e.isNull("style")) all[w] = ALL.equals(e.optString("style"));
                anySpoilers |= !all[w] && !seen[w];
            }
        }
    }

    static final int NOT_COVERED = -1, STYLE_SPOILERS = 0, STYLE_ALL = 1;

    /** Steps 1-3 for one name group: NOT_COVERED, or the group's style. */
    static int group(int[] groupWorks, Works v, boolean blockUnlisted) {
        boolean allSeen = true, blocked = false, styleAll = false;
        for (int w : groupWorks) {
            if (v.seen[w]) continue;
            allSeen = false;
            blocked |= v.state[w] == Works.IS_BLOCKED;
            styleAll |= v.all[w];
        }
        if (allSeen || (!blocked && !blockUnlisted)) return NOT_COVERED;
        return styleAll ? STYLE_ALL : STYLE_SPOILERS;
    }

    /** Step 6: an untitled media image covers only when asked, and not next to text about seen works only. */
    static boolean coverUnknownImage(boolean unknownImages, boolean textNamesSeen, boolean textNamesCovered) {
        return unknownImages && !(textNamesSeen && !textNamesCovered);
    }
}
