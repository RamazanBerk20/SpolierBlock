// The user's config (docs/agents/contract.md): works, custom, settings, learned. Pure functions, shared by the background,
// the settings page, the popup and the Node tests.

export const TYPES = ['movie', 'tv', 'game', 'book', 'anime', 'manga', 'comic'];
export const DEFAULTS = Object.freeze({
  enabled: true, scanImages: true, blockUnlisted: true, style: 'all', unknownImages: false, pausedSites: [], catalogUpdate: 'off',
});
const UPDATES = ['off', 'daily', 'weekly', 'monthly'];
const SITE_LISTS = ['pausedSites']; // host names: normHost, deduplicated
export const FORMAT = 'spolierblock', VERSION = 1;

export const withDefaults = (s) => {
  const out = { ...DEFAULTS, ...(s && typeof s === 'object' ? s : {}) };
  for (const k of SITE_LISTS) if (!Array.isArray(out[k])) out[k] = [];
  delete out.captionlessVideos; // rule 10, removed after 0.2.5: an older stored config drops it
  return out;
};

// 0.1 -> 0.2: seen[id] -> works[id] (state seen), settings.mode -> settings.style. Returns null when there is nothing
// to do, else { set, remove } for one storage write. Existing works entries win over old seen entries.
export function migrate({ seen, settings, works }) {
  const hasMode = settings && typeof settings === 'object' && 'mode' in settings;
  if (!seen && !hasMode) return null;
  const set = {};
  if (seen) {
    const next = { ...(works ?? {}) };
    for (const [id, w] of Object.entries(seen)) {
      next[id] ??= { state: 'seen', style: null, title: String(w?.title ?? id), type: w?.type ?? null, year: w?.year ?? null, ts: w?.ts ?? Date.now() };
    }
    set.works = next;
  }
  if (hasMode) {
    const { mode, ...rest } = settings;
    set.settings = { ...rest, style: rest.style ?? (mode === 'spoiler' ? 'spoilers' : 'all') };
  }
  return { set, remove: seen ? ['seen'] : [] };
}

// ---------- import (a trust boundary: everything is re-built from checked fields, nothing is copied through) ----------
const str = (v, max) => (typeof v === 'string' && v.trim() && v.length <= max ? v.trim() : null);
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const HOST = /^[a-z0-9.-]{1,253}$/;
const ID = /^[^\s\u0000-\u001f]{1,64}$/;
const CUSTOM_ID = /^custom:\d{1,9}$/;

function cleanWork(w) {
  if (!isObj(w) || (w.state !== 'seen' && w.state !== 'blocked')) return null;
  const title = str(w.title, 300);
  if (!title) return null;
  return {
    state: w.state,
    style: w.style === 'all' || w.style === 'spoilers' ? w.style : null,
    title,
    type: TYPES.includes(w.type) ? w.type : null,
    year: Number.isInteger(w.year) && w.year > 0 && w.year < 3000 ? w.year : null,
    ts: Number.isFinite(w.ts) && w.ts > 0 ? w.ts : Date.now(),
  };
}

export function cleanCustom(c) {
  if (!isObj(c) || typeof c.id !== 'string' || !CUSTOM_ID.test(c.id)) return null;
  const title = str(c.title, 200);
  if (!title || !TYPES.includes(c.type)) return null;
  const seen = new Set([title.toLowerCase()]);
  const aliases = (Array.isArray(c.aliases) ? c.aliases : []).map((a) => str(a, 200))
    .filter((a) => a && !seen.has(a.toLowerCase()) && seen.add(a.toLowerCase())).slice(0, 8);
  return { id: c.id, title, aliases, type: c.type };
}

function cleanSettings(s) {
  if (!isObj(s)) return {};
  const out = {};
  for (const k of ['enabled', 'scanImages', 'blockUnlisted', 'unknownImages']) if (typeof s[k] === 'boolean') out[k] = s[k];
  if (s.style === 'all' || s.style === 'spoilers') out.style = s.style;
  if (UPDATES.includes(s.catalogUpdate)) out.catalogUpdate = s.catalogUpdate;
  for (const k of SITE_LISTS) if (Array.isArray(s[k])) out[k] = [...new Set(s[k].map(normHost).filter(Boolean))];
  return out;
}

// "https://www.Example.com/x" or "example.com" -> "example.com"; null when it is not a host name.
export function normHost(v) {
  if (typeof v !== 'string') return null;
  let h = v.trim().toLowerCase();
  try { if (h.includes('/')) h = new URL(h.includes('://') ? h : 'http://' + h).hostname; } catch { return null; }
  h = h.replace(/^www\./, '').replace(/\.$/, '');
  return HOST.test(h) && h.includes('.') || h === 'localhost' ? h : null;
}

export const MAX_IMPORT_BYTES = 5e6;

// text of a file -> { ok: true, data: { works, custom, settings, learned }, skipped } or { ok: false, error }
export function parseImport(text) {
  if (typeof text !== 'string' || text.length > MAX_IMPORT_BYTES) return { ok: false, error: 'This file is too large to be a SpolierBlock export.' };
  let o;
  try { o = JSON.parse(text); } catch { return { ok: false, error: 'This file is not valid JSON.' }; }
  if (!isObj(o) || o.format !== FORMAT) return { ok: false, error: 'This is not a SpolierBlock export file.' };
  if (!Number.isInteger(o.version) || o.version < 1) return { ok: false, error: 'This export file has no valid version.' };
  if (o.version > VERSION) return { ok: false, error: 'This file comes from a newer SpolierBlock. Update the extension, then import it again.' };
  let skipped = 0;
  const works = {};
  for (const [id, w] of Object.entries(isObj(o.works) ? o.works : {})) {
    const c = ID.test(id) && id !== '__proto__' ? cleanWork(w) : null;
    if (c) works[id] = c; else skipped++;
  }
  const custom = [], ids = new Set();
  for (const c of Array.isArray(o.custom) ? o.custom : []) {
    const x = cleanCustom(c);
    if (x && !ids.has(x.id)) { ids.add(x.id); custom.push(x); } else skipped++;
  }
  return { ok: true, data: { works, custom, settings: cleanSettings(o.settings), learned: cleanLearned(o.learned) }, skipped };
}

// current, imported: { works, custom, settings, learned } -> the new { works, custom, settings, learned } to write in one set call.
export function applyImport(current, imported, { mode, withSettings }) {
  if (mode === 'replace') return { works: imported.works, custom: imported.custom, settings: withDefaults(imported.settings), learned: cleanLearned(imported.learned) };
  const custom = new Map((current.custom ?? []).map((c) => [c.id, c]));
  for (const c of imported.custom) custom.set(c.id, c);
  return {
    works: { ...(current.works ?? {}), ...imported.works },
    custom: [...custom.values()],
    settings: withSettings ? withDefaults({ ...current.settings, ...imported.settings }) : withDefaults(current.settings),
    learned: mergeLearned(current.learned, imported.learned),
  };
}

export const exportFile = ({ works, custom, settings, learned }, now = new Date()) =>
  ({ format: FORMAT, version: VERSION, exportedAt: now.toISOString().replace(/\.\d+Z$/, 'Z'), works: works ?? {}, custom: custom ?? [], settings: withDefaults(settings), learned: cleanLearned(learned) });

// ---------- learned (rule 11): extra names, where a name is not a work ----------
export const NAME_MIN = 2, NAME_MAX = 60, NAMES_PER_WORK = 20;
const okId = (id) => ID.test(id) && id !== '__proto__';
// a not-key: "{site}" or "{site}/{source}", lower-case; the site is a host name as in pausedSites
const okKey = (k) => typeof k === 'string' && k.length <= 300 && k === k.trim().toLowerCase() && !!k && normHost(k.split('/')[0]) === k.split('/')[0] &&
  (!k.includes('/') || k.split('/').slice(1).join('/').trim().length > 0);
export const cleanName = (v) => (typeof v === 'string' && v.trim().length >= NAME_MIN && v.trim().length <= NAME_MAX ? v.trim() : null);
// names of one work: trimmed, 2-60 characters, deduplicated case-insensitively (first spelling kept), at most 20
export function cleanNames(list) {
  const seen = new Set();
  return (Array.isArray(list) ? list : []).map(cleanName).filter((n) => n && !seen.has(n.toLowerCase()) && seen.add(n.toLowerCase())).slice(0, NAMES_PER_WORK);
}
// storage or file value -> { names, not }, malformed entries dropped
export function cleanLearned(l) {
  const o = isObj(l) ? l : {}, names = {}, not = {};
  for (const [id, list] of Object.entries(isObj(o.names) ? o.names : {})) { const n = okId(id) ? cleanNames(list) : []; if (n.length) names[id] = n; }
  for (const [id, list] of Object.entries(isObj(o.not) ? o.not : {})) {
    const k = okId(id) && Array.isArray(list) ? [...new Set(list.filter(okKey))] : [];
    if (k.length) not[id] = k;
  }
  return { names, not };
}
// Merge unions: names and keys per work (current first); then the limits again
export function mergeLearned(a, b) {
  const x = cleanLearned(a), y = cleanLearned(b);
  const names = { ...x.names }, not = { ...x.not };
  for (const [id, n] of Object.entries(y.names)) names[id] = cleanNames([...(names[id] ?? []), ...n]);
  for (const [id, k] of Object.entries(y.not)) not[id] = [...new Set([...(not[id] ?? []), ...k])];
  return { names, not };
}
// learned with one more name for work id -> { learned } or { error } (the message to show)
export function addName(learned, id, name) {
  const l = cleanLearned(learned), n = cleanName(name), cur = l.names[id] ?? [];
  if (!n) return { error: `A name is ${NAME_MIN} to ${NAME_MAX} characters.` };
  if (cur.some((x) => x.toLowerCase() === n.toLowerCase())) return { error: `"${n}" is already one of its names.` };
  if (cur.length >= NAMES_PER_WORK) return { error: `A work has at most ${NAMES_PER_WORK} other names.` };
  return { learned: { ...l, names: { ...l.names, [id]: [...cur, n] } } };
}

export const nextCustomId = (custom) => 'custom:' + (Math.max(0, ...custom.map((c) => +c.id.slice(7) || 0)) + 1);
