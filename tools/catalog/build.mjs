// Builds data/catalog.json from Wikidata. Usage: node build.mjs [minSitelinks=15]
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { TYPES, EXCLUDE, PRIORITY, qid, yearOf, cleanTitle, batches, subclassQuery, yearsQuery, aliasQuery, charQuery,
  charFallbackQuery, CHAR_MIN_POP, makeAmbiguous, finalizeWork, compareWorks, kindQuery, isNarrative, NOT_NARRATIVE, senseQuery,
  SAME_SENSE_ROOTS, shortName, senseNames, addSenses, otherNames } from '../../src/shared/catalog-rules.js';
import { seriesPrefix } from '../build-index.mjs';
import { isCommon, setCommonWords } from '../../src/shared/build-index.js';
import { fetchSeries, resolveSeries } from './series.mjs';
const { tokenize } = globalThis.SBMatcher; // loaded by build-index.js

const here = dirname(fileURLToPath(import.meta.url));
const CACHE = join(here, 'cache');
const OUT = process.env.CATALOG_OUT ?? join(here, '..', '..', 'data', 'catalog.json'); // override: verify a refactor without touching data/
const MIN = Number(process.argv[2] ?? 15);
mkdirSync(CACHE, { recursive: true });
mkdirSync(dirname(OUT), { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function sparql(query) {
  const f = join(CACHE, createHash('sha1').update(query).digest('hex') + '.json');
  if (existsSync(f)) return JSON.parse(readFileSync(f, 'utf8'));
  let lastErr;
  for (let attempt = 0; attempt < 8; attempt++) {
    await sleep(1000 + Math.min(attempt * attempt * 4000, 60000));
    try {
      const res = await fetch('https://query.wikidata.org/sparql', {
        method: 'POST',
        headers: { 'User-Agent': 'catalog-builder/1.0', Accept: 'application/sparql-results+json', 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ query }),
        signal: AbortSignal.timeout(80000),
      });
      if (res.ok) {
        const rows = (await res.json()).results.bindings;
        writeFileSync(f, JSON.stringify(rows)); console.log("fetched", rows.length);
        return rows;
      }
      lastErr = new Error('HTTP ' + res.status);
      if (res.status === 429) await sleep((Number(res.headers.get('retry-after')) || 30) * 1000);
      else if (res.status < 500) throw lastErr; // bad query: don't retry
    } catch (e) { lastErr = e; if (/^HTTP 4/.test(e.message)) throw e; }
  }
  throw lastErr;
}

const LIMIT = 40000;
// step 1b. Chosen against the size of index.bin: its table has 131,072 slots for up to 81,920 entries and doubles to
// 3.1 MB beyond that (with these values the index holds about 81,000).
const LOW_MIN = { anime: 10, manga: 10, comic: 10, book: 12 };
const LOCAL_POP = 60, LOCAL_MAX = 1; // step 4: one name in another language, for works with at least LOCAL_POP sitelinks
// step 1c: media franchises (P31 only) with an anime or manga work (anime 1 when one of them is an anime)
const franchiseQuery = (min) => `SELECT ?f ?label ?sl (MAX(?a) AS ?anime) WHERE {
  ?f wdt:P31 wd:Q196600 ; wikibase:sitelinks ?sl . FILTER(?sl >= ${min})
  ?w wdt:P8345 ?f ; wdt:P31 ?c .
  VALUES (?c ?a) { (wd:Q63952888 1) (wd:Q20650540 1) (wd:Q1107 1) (wd:Q220898 1) (wd:Q21198342 0) (wd:Q8274 0) }
  ?f rdfs:label ?label . FILTER(LANG(?label) = "en")
} GROUP BY ?f ?label ?sl`;
const membersQuery = (b) => `SELECT ?f ?w WHERE { VALUES ?f { ${b.map((i) => 'wd:' + i).join(' ')} } ?w wdt:P8345 ?f }`;
// step 3: the work's labels in the languages of the common-word list besides English (posts in those languages use
// them: "El Chavo del Ocho", "Duna: Parte Dois"), and its other names there
const LOCAL = ['tr', 'es', 'pt', 'de', 'fr', 'it'];
const localQuery = (b) => `SELECT ?w ?p ?l WHERE { VALUES ?w { ${b.map((i) => 'wd:' + i).join(' ')} } VALUES ?p { rdfs:label skos:altLabel } ?w ?p ?l . FILTER(LANG(?l) IN (${LOCAL.map((l) => `"${l}"`).join(', ')})) }`;
const BANDS = [15, 16, 17, 18, 20, 22, 25, 30, 40, 60, 100, 200, 100000].filter((b) => b > MIN);
BANDS.unshift(MIN);

const COARSE = [MIN, 20, 30, 60, 100000].filter((b, i) => i === 0 || b > MIN);
const FINE_ROOTS = new Set(['Q11424', 'Q5398426', 'Q1259759', 'Q7889', 'Q7725634', 'Q8261', 'Q1667921', 'Q277759', 'Q63952888', 'Q20650540', 'Q21198342', 'Q14406742']);
async function fetchRange(classes, out) {
  const fine = classes.length > 1 || FINE_ROOTS.has(classes[0]);
  // en first; "mul" labels (Wikidata's shared-label language, used by many game/film titles) fill the gaps
  for (const lang of ['en', 'mul']) {
    const b = fine && lang === 'en' ? BANDS : COARSE; // fine bands keep earlier cached en queries valid
    for (let i = 0; i < b.length - 1; i++) await fetchOne(classes, b[i], b[i + 1], out, lang);
  }
}
async function fetchOne(classes, lo, hi, out, lang) {
  const q = classes.length === 1
    ? `SELECT ?item ?label ?sl WHERE {
  ?item wdt:P31 wd:${classes[0]} ; wikibase:sitelinks ?sl .
  FILTER(?sl >= ${lo} && ?sl < ${hi})
  ?item rdfs:label ?label . FILTER(LANG(?label) = "${lang}")
}
LIMIT ${LIMIT}`
    : `SELECT ?item ?label ?sl WHERE {
  VALUES ?cls { ${classes.map((c) => 'wd:' + c).join(' ')} }
  ?item wdt:P31 ?cls ; wikibase:sitelinks ?sl .
  FILTER(?sl >= ${lo} && ?sl < ${hi})
  ?item rdfs:label ?label . FILTER(LANG(?label) = "${lang}")
}
LIMIT ${LIMIT}`;
  let rows;
  const split = async () => { const mid = Math.floor((lo + hi) / 2); await fetchOne(classes, lo, mid, out, lang); await fetchOne(classes, mid, hi, out, lang); };
  try { rows = await sparql(q); } catch (e) {
    if (hi - lo <= 1) throw new Error(`range ${lo}-${hi} ${classes.length} classes: ${e.message}`);
    console.log(`  split ${lo}-${hi} after ${e.message}`);
    return split();
  }
  if (rows.length >= LIMIT && hi - lo > 1) return split();
  if (rows.length >= LIMIT) console.warn(`  WARNING: ${lo}-${hi} truncated at LIMIT`);
  for (const r of rows) out.push(r);
}

// 1. works per type
const works = new Map(); // qid -> work
const classSets = {}; // type -> its class lists, as queried
for (const type of PRIORITY.slice().reverse()) { /* low priority first so higher overwrites */
  const rows = [];
  const sub = new Set();
  for (const root of TYPES[type].deep)
    for (const r of await sparql(subclassQuery(root))) sub.add(qid(r.c.value));
  for (const r of TYPES[type].roots) sub.delete(r);
  for (const x of EXCLUDE) sub.delete(x);
  console.log(type, 'subclasses', sub.size);
  const sets = [...TYPES[type].roots.map((r) => [r]), ...(sub.size ? [[...sub]] : [])];
  classSets[type] = sets;
  for (const cls of sets) await fetchRange(cls, rows);
  const per = new Map();
  for (const r of rows) {
    const id = r.item.value.split('/').pop();
    const w = per.get(id) ?? { id, title: r.label.value, type, years: [], pop: Number(r.sl.value) };
    per.set(id, w);
  }
  console.log(type, per.size);
  for (const [id, w] of per) works.set(id, w); // overwritten by higher priority later
}

// 1b. Books, comics, manga and anime have fewer Wikipedia articles than films, shows and games of the same fame ("Circe"
// has 12 sitelinks, "Piranesi" 10, the comic "Saga" 14, the "Code Geass" anime 14): they take works down to LOW_MIN.
// Fetched after the main pass and appended to it, so its cached queries and the batches below stay as they were.
const main = new Set(works.keys());
for (const type of PRIORITY.filter((t) => t in LOW_MIN && LOW_MIN[t] < MIN).reverse()) {
  const rows = [];
  for (const lang of ['en', 'mul']) for (const cls of classSets[type]) await fetchOne(cls, LOW_MIN[type], MIN, rows, lang);
  let n = 0;
  for (const r of rows) {
    const id = qid(r.item.value);
    if (main.has(id) || works.get(id)?.type === type) continue; // the first label (en) wins, as in step 1
    works.set(id, { id, title: r.label.value, type, years: [], pop: Number(r.sl.value) });
    n++;
  }
  console.log(type, 'from', LOW_MIN[type], 'sitelinks:', n);
}

// 1c. Some anime and manga have their Wikipedia articles on the media franchise item, not on the manga or the series
// ("One-Punch Man": the franchise has 48 sitelinks, the anime 0). Such a franchise stands in for its works, as an anime
// when it has an anime member, else as a manga. Step 4 drops it when its name is already a catalog name or one of its
// works in the catalog is of another type (a film or game franchise with a side anime: "Pirates of the Caribbean").
const standIns = new Map(); // franchise qid -> its member qids
for (const r of await sparql(franchiseQuery(MIN))) {
  const id = qid(r.f.value);
  if (works.has(id)) continue;
  works.set(id, { id, title: r.label.value, type: r.anime.value === '1' ? 'anime' : 'manga', years: [], pop: Number(r.sl.value) });
  standIns.set(id, []);
}
if (standIns.size) for (const r of await sparql(membersQuery([...standIns.keys()]))) standIns.get(qid(r.f.value))?.push(qid(r.w.value));
console.log('franchise stand-ins', standIns.size);

// 2. cleanup; what each work is (P31/P136/P7937), to keep only works told as a story in step 4
const kinds = new Map();
for (const b of batches([...works.keys()])) for (const r of await sparql(kindQuery(b))) {
  const id = qid(r.w.value);
  (kinds.get(id) ?? kinds.set(id, []).get(id)).push(qid(r.v.value));
}
const list = [...works.values()].filter((w) => cleanTitle(w.title));
console.log('after dedupe/cleanup', list.length);

// 3. years (separate cheap batched query), aliases, characters
const byId = new Map(list.map((w) => [w.id, w]));
const ids = list.map((w) => w.id);
for (const b of batches(ids)) {
  const rows = await sparql(yearsQuery(b));
  for (const r of rows) { const y = yearOf(r.d.value); if (y) byId.get(qid(r.w.value)).years.push(y); }
}
const aliasSets = new Map(), chars = new Map(), locals = new Map();
const addTo = (m, k, v) => { (m.get(k) ?? m.set(k, []).get(k)).push(v); };
for (const b of batches(ids)) for (const r of await sparql(localQuery(b))) addTo(locals, qid(r.w.value), [r.l.value, r.p.value.endsWith('altLabel') ? 1 : 0]);

for (const b of batches(ids)) {
  const rows = await sparql(aliasQuery(b));
  for (const r of rows) addTo(aliasSets, r.w.value.split('/').pop(), [r.a.value, r.a['xml:lang'] === 'en' ? 0 : 1]);
}
const popular = list.filter((w) => w.pop >= CHAR_MIN_POP).map((w) => w.id);
for (const b of batches(popular)) {
  const rows = await sparql(charQuery(b));
  for (const r of rows) addTo(chars, r.w.value.split('/').pop(), [r.cl.value, Number(r.cs?.value ?? 0)]);
}
const missing = popular.filter((id) => !chars.has(id));
for (const b of batches(missing)) {
  const rows = await sparql(charFallbackQuery(b));
  for (const r of rows) addTo(chars, r.w.value.split('/').pop(), [r.cl.value, Number(r.cs?.value ?? 0)]);
}

// 4. assemble: no scripture, reference works, documentaries... (isNarrative)
const ambiguous = makeAmbiguous(readFileSync(join(here, 'common-words.txt'), 'utf8'));
let result = list.filter((w) => isNarrative(kinds.get(w.id) ?? []))
  .map((w) => finalizeWork(w, aliasSets.get(w.id), chars.get(w.id), ambiguous)).sort(compareWorks);
console.log('told as a story', result.length, 'of', list.length);
const keyOf = (s) => tokenize(s).toks.join(' ');
{ // franchise stand-ins (step 1c) whose name the catalog has, or with a work of another type in the catalog, go
  const byId = new Map(result.map((w) => [w.id, w]));
  const taken = new Set(result.filter((w) => !standIns.has(w.id)).flatMap((w) => [w.title, ...w.aliases, seriesPrefix(w.title)]).filter(Boolean).map(keyOf));
  result = result.filter((w) => !standIns.has(w.id) || (!taken.has(keyOf(w.title)) &&
    standIns.get(w.id).every((m) => !byId.has(m) || byId.get(m).type === 'anime' || byId.get(m).type === 'manga')));
  console.log('franchise stand-ins kept', result.filter((w) => standIns.has(w.id)).map((w) => w.title).join(', '));
}
{ // more names, after the (at most 8) English ones of finalizeWork
  // the main title of a subtitled title, when no other work carries it as a title, alias or series prefix: "Rogue One"
  // of "Rogue One: A Star Wars Story" ("Dr. Strangelove or" of "Dr. Strangelove or: How I Learned..." is no name), nor
  // a character's name or part of one ("Voldemort" of "Voldemort: Origins of the Heir" stays Harry Potter's)
  const count = new Map(), bump = (k) => count.set(k, (count.get(k) ?? 0) + 1);
  for (const w of result) for (const k of new Set([w.title, ...w.aliases, seriesPrefix(w.title)].filter(Boolean).map(keyOf))) bump(k);
  for (const w of result) for (const c of w.characters) for (const k of [keyOf(c), ...keyOf(c).split(' ')]) count.set(k, 2);
  let mains = 0, localN = 0;
  for (const w of result) {
    const p = seriesPrefix(w.title), k = p && keyOf(p);
    if (k && count.get(k) === 1 && !/ or$/.test(k) && !w.aliases.some((a) => keyOf(a) === k)) { w.aliases.push(p); mains++; }
    // up to LOCAL_MAX labels in other languages (labels before other names, then the most often given): not a name the
    // work already has, not a single word (an everyday word of some language, a name: "Yedi" for "Seven", "Fausto" for
    // "Faust", a stray "SLB." for Super Mario Bros.), not two very frequent words (ambiguous)
    // (nor one that holds the title, which matches there already: "Avatar – Aufbruch nach Pandora")
    if (w.pop < LOCAL_POP) continue;
    const have = new Set([w.title, ...w.aliases].map(keyOf)), tk = ' ' + keyOf(w.title) + ' ', cand = new Map();
    for (const [l, alt] of locals.get(w.id) ?? []) {
      const t = l.trim(), k = keyOf(t), n = k.split(' ').length;
      if (!k || have.has(k) || n > 8 || n === 1 || /[()]/.test(t) || ambiguous(t) || (' ' + k + ' ').includes(tk)) continue;
      const e = cand.get(k) ?? cand.set(k, { t, alt, n: 0 }).get(k);
      e.n++;
      if (!alt && e.alt) { e.t = t; e.alt = 0; }
    }
    const add = [...cand.values()].sort((a, b) => a.alt - b.alt || b.n - a.n || (a.t < b.t ? -1 : a.t > b.t ? 1 : 0)).slice(0, LOCAL_MAX).map((e) => e.t);
    w.aliases.push(...add); localN += add.length;
  }
  console.log('main-title aliases', mains, 'local-language aliases', localN);
}

// 5. names that mostly mean something else: an item with the same English label or alias that is not a work or a
// fictional thing (a place, a person, a company, a song, scripture) and has more sitelinks than the work ("Palestine",
// "Napoleon", "Oppenheimer" for the physicist).
const sameSense = new Set(Object.values(TYPES).flatMap((t) => t.roots));
for (const root of [...Object.values(TYPES).flatMap((t) => t.deep), ...SAME_SENSE_ROOTS]) {
  sameSense.add(root);
  for (const r of await sparql(subclassQuery(root))) sameSense.add(qid(r.c.value));
}
for (const c of NOT_NARRATIVE) sameSense.delete(c);
const inCatalog = new Set(result.map((w) => w.id));
const namesOf = (w) => senseNames(w, seriesPrefix);
const otherPop = new Map(); // name -> sitelinks of its strongest other sense
// names go to fixed hash buckets, so a changed name only invalidates its own bucket in the query cache
const BUCKETS = 400, bucket = (n) => [...n].reduce((h, c) => Math.imul(h ^ c.codePointAt(0), 16777619) >>> 0, 2166136261) % BUCKETS;
const byBucket = Array.from({ length: BUCKETS }, () => []);
for (const n of [...new Set(result.flatMap(namesOf))].sort()) byBucket[bucket(n)].push(n);
for (const b of byBucket.filter((x) => x.length)) {
  const short = b.filter(shortName), t0 = Date.now();
  addSenses(otherPop, [...await sparql(senseQuery(b)), ...(short.length ? await sparql(senseQuery(short, 'skos:altLabel')) : [])], inCatalog, sameSense);
  if (Date.now() - t0 > 1000) console.log('senses bucket', byBucket.indexOf(b), Date.now() - t0, 'ms');
}
for (const w of result) {
  const other = otherNames(w, namesOf(w), otherPop);
  if (other.length) w.other = other;
}
console.log('works with names that mostly mean something else', result.filter((w) => w.other).length);

// 6. series membership ("More from this series"), see series.mjs
setCommonWords(readFileSync(join(here, 'common-words.txt'), 'utf8'));
const { links, info } = await fetchSeries(result.map((w) => w.id), sparql);
const seriesTable = resolveSeries(result, links, info, isCommon);
console.log('works in a series', result.filter((w) => w.series).length, 'series', Object.keys(seriesTable).length);

writeFileSync(OUT, '{"version":1,"series":' + JSON.stringify(seriesTable) + ',\n"works":[\n' + result.map((w) => JSON.stringify(w)).join(',\n') + '\n]}\n');
console.log('wrote', result.length, 'works to', OUT);
