// Opt-in catalog refresh: the ONLY network use of the extension. Fetches works released since the bundled catalog
// was built from Wikidata's public SPARQL endpoint (nothing but the query is sent), merges them with the bundled
// catalog and rebuilds the matcher index with the same builder as the Node build (src/shared/build-index.js).
// The result is stored in storage.local as one key (catalogIndex) so the swap is atomic; on any failure nothing
// but catalogMeta.lastError is written, so the working index is never damaged.
import { PRIORITY, MIN_SITELINKS, qid, yearOf, cleanTitle, batches, yearsQuery, aliasQuery, charQuery, charFallbackQuery,
  CHAR_MIN_POP, makeAmbiguous, finalizeWork, compareWorks, kindQuery, isNarrative, NOT_NARRATIVE, senseQuery, SENSE_BATCH,
  shortName, senseNames, addSenses, otherNames } from '../shared/catalog-rules.js';
import { buildIndex, setCommonWords, seriesPrefix } from '../shared/build-index.js';

export const ENDPOINT = 'https://query.wikidata.org/sparql';
export const INTERVALS = { daily: 1440, weekly: 10080, monthly: 43200 }; // minutes
export const ALARM = 'catalogUpdate';

// When the alarm should fire: null = no alarm (off). First run after enabling: in one minute.
export function alarmPlan(setting, lastCheck, now) {
  const period = INTERVALS[setting];
  if (!period) return null;
  const due = lastCheck ? lastCheck + period * 60000 : now;
  return { delayInMinutes: Math.max(1, Math.ceil((due - now) / 60000)), periodInMinutes: period };
}

// Candidates: items with at least MIN_SITELINKS sitelinks dated (publication P577 / start P580 / inception P571) on or
// after Jan 1 of sinceYear, including future dates, with their P31 classes; the type is decided locally from the
// bundled class list. Date-range first is what makes this cheap: about 1.5k items for two years and 2-10 s per
// query on the live endpoint, while filtering by class first (300k films) runs into the 60 s query limit.
export const DATE_PROPS = ['P577', 'P580', 'P571'];
export function deltaQuery(prop, sinceYear) {
  return `SELECT ?item ?cls ?sl WHERE {
  ?item wdt:${prop} ?d . hint:Prior hint:rangeSafe true . FILTER(?d >= "${sinceYear}-01-01T00:00:00Z"^^xsd:dateTime)
  ?item wikibase:sitelinks ?sl . FILTER(?sl >= ${MIN_SITELINKS})
  ?item wdt:P31 ?cls .
}`;
}
const labelQuery = (b) => `SELECT ?w ?en ?mul WHERE { VALUES ?w { ${b.map((i) => 'wd:' + i).join(' ')} } OPTIONAL { ?w rdfs:label ?en . FILTER(LANG(?en) = "en") } OPTIONAL { ?w rdfs:label ?mul . FILTER(LANG(?mul) = "mul") } }`;
// shortcut: undated items (no P577/P580/P571 yet) are not fetched; add a creation-date query if they turn out to matter.

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// Sequential, polite SPARQL client. 429/5xx: honour Retry-After (capped), at most 3 attempts, then give up until the
// next interval. stats: { queries, bytes }.
export async function sparql(query, { fetch, endpoint, stats, sleep = wait }) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    let res;
    try {
      res = await fetch(endpoint, {
        method: 'POST', body: new URLSearchParams({ query }), credentials: 'omit', referrerPolicy: 'no-referrer', cache: 'no-store',
        signal: AbortSignal.timeout(90000), // Wikidata itself stops queries after 60 s
        headers: { Accept: 'application/sparql-results+json', 'Content-Type': 'application/x-www-form-urlencoded' },
      });
    } catch { throw new Error('Could not reach Wikidata (offline?)'); }
    stats.queries++;
    if (res.ok) {
      const text = await res.text();
      stats.bytes += text.length;
      let rows;
      try { rows = JSON.parse(text)?.results?.bindings; } catch { /* fall through */ }
      if (!Array.isArray(rows)) throw new Error('Wikidata sent an unreadable answer');
      return rows;
    }
    if (res.status !== 429 && res.status < 500) throw new Error(`Wikidata refused the request (HTTP ${res.status})`);
    if (attempt === 3) break;
    const ra = Number(res.headers.get('retry-after'));
    await sleep(Math.min(Number.isFinite(ra) && ra > 0 ? ra * 1000 : 5000 * attempt, 120000));
  }
  throw new Error('Wikidata is busy right now; will try again at the next update');
}

// The "name mostly means something else" lookup sends at most this many queries per update (label and alias queries
// of SENSE_BATCH names each); names beyond it, or all of them when Wikidata fails, get the fail-safe rule of otherNames.
export const MAX_SENSE_QUERIES = 20;

// -> new works (catalog schema) not in `known`, told as a story (isNarrative), with their "other" names.
// words: the common-word list (series prefixes, as in the index builder).
export async function fetchDelta({ classes, sinceYear, known, ambiguous, words, ...net }) {
  setCommonWords(words);
  const typeOf = new Map(); // class -> highest-priority type containing it
  for (const type of [...PRIORITY].reverse()) for (const c of classes[type] ?? []) typeOf.set(c, type);
  const rank = (t) => PRIORITY.indexOf(t);
  const cand = new Map(); // id -> { type, pop }
  for (const prop of DATE_PROPS) {
    for (const r of await sparql(deltaQuery(prop, sinceYear), net)) {
      const id = qid(r.item.value), type = typeOf.get(qid(r.cls.value));
      if (known.has(id) || !type) continue;
      const prev = cand.get(id);
      if (!prev || rank(type) < rank(prev.type)) cand.set(id, { type, pop: Number(r.sl.value) });
    }
  }
  const found = new Map();
  for (const b of batches([...cand.keys()])) {
    for (const r of await sparql(labelQuery(b), net)) {
      const id = qid(r.w.value), title = r.en?.value ?? r.mul?.value;
      if (title && cleanTitle(title) && !found.has(id)) found.set(id, { id, title, type: cand.get(id).type, years: [], pop: cand.get(id).pop });
    }
  }
  // scripture, reference works, documentaries... are left out, as in the catalog build (one query per 200 works)
  const kinds = new Map();
  const addTo = (m, k, v) => { (m.get(k) ?? m.set(k, []).get(k)).push(v); };
  for (const b of batches([...found.keys()])) for (const r of await sparql(kindQuery(b), net)) addTo(kinds, qid(r.w.value), qid(r.v.value));
  for (const id of [...found.keys()]) if (!isNarrative(kinds.get(id) ?? [])) found.delete(id);
  const list = [...found.values()], ids = list.map((w) => w.id);
  for (const b of batches(ids)) for (const r of await sparql(yearsQuery(b), net)) { const y = yearOf(r.d.value); if (y) found.get(qid(r.w.value)).years.push(y); }
  const aliases = new Map(), chars = new Map();
  for (const b of batches(ids)) for (const r of await sparql(aliasQuery(b), net)) addTo(aliases, qid(r.w.value), [r.a.value, r.a['xml:lang'] === 'en' ? 0 : 1]);
  const popular = list.filter((w) => w.pop >= CHAR_MIN_POP).map((w) => w.id);
  for (const b of batches(popular)) for (const r of await sparql(charQuery(b), net)) addTo(chars, qid(r.w.value), [r.cl.value, Number(r.cs?.value ?? 0)]);
  const missing = popular.filter((id) => !chars.has(id));
  for (const b of batches(missing)) for (const r of await sparql(charFallbackQuery(b), net)) addTo(chars, qid(r.w.value), [r.cl.value, Number(r.cs?.value ?? 0)]);
  const fresh = list.map((w) => finalizeWork(w, aliases.get(w.id), chars.get(w.id), ambiguous));
  await markOther(fresh, new Set([...known, ...ids]), classes, net);
  return fresh;
}

// Sets work.other like the catalog build does (tools/catalog/build.mjs step 5), within MAX_SENSE_QUERIES.
async function markOther(works, inCatalog, classes, net) {
  const sameSense = new Set([...PRIORITY.flatMap((t) => classes[t] ?? []), ...(classes.sameSense ?? [])]);
  for (const c of NOT_NARRATIVE) sameSense.delete(c);
  const names = [...new Set(works.flatMap((w) => senseNames(w, seriesPrefix)))].sort();
  const otherPop = new Map(), looked = new Set();
  let queries = 0;
  try {
    for (const b of batches(names, SENSE_BATCH)) {
      const short = b.filter(shortName);
      if (queries + (short.length ? 2 : 1) > MAX_SENSE_QUERIES) break;
      queries += short.length ? 2 : 1;
      const rows = [...await sparql(senseQuery(b), net), ...(short.length ? await sparql(senseQuery(short, 'skos:altLabel'), net) : [])];
      addSenses(otherPop, rows, inCatalog, sameSense);
      for (const n of b) looked.add(n);
    }
  } catch { /* busy, refused or an odd answer: the names not looked up get the fail-safe rule */ }
  for (const w of works) {
    const other = otherNames(w, senseNames(w, seriesPrefix), otherPop, (n) => looked.has(n));
    if (other.length) w.other = other;
  }
}

// Bundled catalog + added works (deduped by QID, bundled wins), in the catalog's own order.
export function mergeCatalog(bundled, added) {
  const known = new Set(bundled.works.map((w) => w.id));
  const extra = new Map();
  for (const w of added) if (!known.has(w.id)) extra.set(w.id, w);
  return { version: bundled.version ?? 1, works: [...bundled.works, ...extra.values()].sort(compareWorks) };
}

// Old (bundled) group index -> group index in the rebuilt index; CLIP verdicts are expressed in bundled groups.
export function mapBundledGroups(oldMeta, newMeta) {
  const byLabel = new Map();
  newMeta.groups.forEach((g, i) => { (byLabel.get(g[0]) ?? byLabel.set(g[0], []).get(g[0])).push(i); });
  const newPos = new Map(newMeta.ids.map((id, i) => [id, i]));
  return oldMeta.groups.map((g) => {
    const first = newPos.get(oldMeta.ids[g[1]]);
    return (byLabel.get(g[0]) ?? []).find((i) => newMeta.groups[i].includes(first, 1)) ?? -1;
  });
}

export const toBase64 = (buf) => {
  const u = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000));
  return btoa(s);
};

// The user's hand-entered works (storage `custom`) as catalog works. A high pop keeps them out of the
// "obscure work" rules: the user named them, so they are not everyday-word noise.
export const CUSTOM_POP = 1000;
export function customWorks(custom, words) {
  const ambiguous = makeAmbiguous(words);
  return (custom ?? []).map((c) => ({ id: c.id, title: c.title, type: c.type, year: null, aliases: c.aliases ?? [], characters: [], pop: CUSTOM_POP, ambiguous: ambiguous(c.title) }));
}

// added: works from catalog updates; custom: storage `custom` (hand-entered works)
export function rebuild(bundle, added, custom = []) {
  setCommonWords(bundle.words);
  const built = buildIndex(mergeCatalog(bundle.catalog, [...added, ...customWorks(custom, bundle.words)]));
  return { bin: built.bin, meta: { ...built.meta, fromBundled: mapBundledGroups(bundle.meta, built.meta) } };
}

// One update run. deps: { fetch, storage (browser.storage.local-like), loadBundle(), endpoint, now, sleep }
// loadBundle -> { catalog, words, classes, info: { builtAt }, meta (bundled index.json) }
export async function runUpdate({ storage, loadBundle, now = Date.now(), ...net }) {
  const { catalogMeta: old = {}, catalogAdded: prev = [], custom = [] } = await storage.get(['catalogMeta', 'catalogAdded', 'custom']);
  const meta = { lastSuccess: null, added: 0, ...old, lastCheck: now, lastError: null };
  const stats = { queries: 0, bytes: 0 };
  try {
    const bundle = await loadBundle();
    const sinceYear = new Date(bundle.info.builtAt).getUTCFullYear() - 1;
    const known = new Set([...bundle.catalog.works.map((w) => w.id), ...prev.map((w) => w.id)]);
    const fresh = await fetchDelta({ classes: bundle.classes, sinceYear, known, ambiguous: makeAmbiguous(bundle.words), words: bundle.words, stats, ...net });
    if (fresh.length) {
      const added = [...prev, ...fresh];
      const { bin, meta: indexMeta } = rebuild(bundle, added, custom);
      // single set call: content scripts see either the old or the complete new index
      await storage.set({ catalogIndex: { builtAt: now, bin: toBase64(bin), meta: indexMeta }, catalogAdded: added });
      meta.added = added.length;
    }
    meta.lastSuccess = now;
    meta.found = fresh.length;
  } catch (e) {
    meta.lastError = String(e?.message ?? e);
  }
  meta.stats = stats;
  await storage.set({ catalogMeta: meta });
  return meta;
}
