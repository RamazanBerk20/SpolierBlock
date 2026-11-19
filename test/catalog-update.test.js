import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { buildIndex } from '../tools/build-index.mjs';
import { runUpdate, rebuild, mergeCatalog, alarmPlan, deltaQuery, fetchDelta, customWorks, MAX_SENSE_QUERIES } from '../src/background/catalog-update.js';
const { Matcher } = globalThis.SBMatcher;

const catalog = JSON.parse(fs.readFileSync(new URL('./fixtures/catalog.small.json', import.meta.url)));
const words = fs.readFileSync(new URL('../tools/catalog/common-words.txt', import.meta.url), 'utf8');
const bundle = { catalog, words, meta: buildIndex(catalog).meta, info: { builtAt: '2026-11-18T00:00:00Z' }, classes: { game: ['Q7889'], movie: ['Q11424'] } };
const NEW = { id: 'Q999000001', title: 'Moonfall Protocol', type: 'game', year: 2026, aliases: ['MFP'], characters: [], pop: 22, ambiguous: false };

test('delta merge + in-extension rebuild equals a full Node build of the combined catalog (bytes)', () => {
  const added = [NEW, { ...catalog.works[0] }]; // second one is already bundled: must be ignored
  const merged = mergeCatalog(catalog, added);
  const viaNode = buildIndex(JSON.parse(JSON.stringify(merged)));
  const viaUpdate = rebuild(bundle, added);
  assert.deepEqual(Buffer.from(viaUpdate.bin), Buffer.from(viaNode.bin));
  const { fromBundled, ...meta } = viaUpdate.meta;
  assert.deepEqual(meta, viaNode.meta);
  // every bundled group maps to a group of the same name in the new index
  bundle.meta.groups.forEach((g, i) => assert.equal(viaUpdate.meta.groups[fromBundled[i]][0], g[0]));
});

test('dedupe by QID: bundled wins, repeated deltas do not duplicate', () => {
  const m = mergeCatalog(catalog, [NEW, NEW, { ...catalog.works[3], title: 'Renamed' }]);
  assert.equal(m.works.length, catalog.works.length + 1);
  assert.equal(m.works.filter((w) => w.id === catalog.works[3].id)[0].title, catalog.works[3].title);
});

test('interval scheduling', () => {
  const now = Date.UTC(2026, 10, 18);
  assert.equal(alarmPlan('off', 0, now), null);
  assert.equal(alarmPlan(undefined, 0, now), null);
  assert.deepEqual(alarmPlan('daily', null, now), { delayInMinutes: 1, periodInMinutes: 1440 });
  assert.deepEqual(alarmPlan('weekly', now - 2 * 86400000, now), { delayInMinutes: 5 * 1440, periodInMinutes: 10080 });
  assert.deepEqual(alarmPlan('monthly', now - 40 * 86400000, now), { delayInMinutes: 1, periodInMinutes: 43200 }); // overdue: soon
});

test('delta query: dated on or after the window start, sitelinks bar, P31 returned for local typing', () => {
  const q = deltaQuery('P577', 2025);
  assert.match(q, /wdt:P577 \?d \. hint:Prior hint:rangeSafe true \. FILTER\(\?d >= "2025-01-01T00:00:00Z"\^\^xsd:dateTime\)/);
  assert.match(q, /\?sl >= 15/);
  assert.match(q, /wdt:P31 \?cls/);
});

// fake SPARQL endpoint: answers the query kinds runUpdate sends. senses: label -> [{ e, sl, cs }]; kinds: id -> classes
const json = (rows) => new Response(JSON.stringify({ results: { bindings: rows } }), { status: 200 });
const wd = (id) => ({ value: 'http://www.wikidata.org/entity/' + id });
function mockFetch(mode, { senses = {}, kinds = {}, senseMode = 'ok' } = {}) {
  const calls = [];
  return Object.assign(async (url, init) => {
    const q = new URLSearchParams(init.body).get('query');
    calls.push(q);
    if (mode === '429') return new Response('slow down', { status: 429, headers: { 'retry-after': '1' } });
    if (mode === 'bad') return new Response('<html>oops</html>', { status: 200 });
    if (q.includes('VALUES ?l')) {
      if (senseMode === '429') return new Response('slow down', { status: 429, headers: { 'retry-after': '1' } });
      const labels = [...q.matchAll(/("(?:[^"\\]|\\.)*")@en/g)].map((m) => JSON.parse(m[1]));
      return json(labels.flatMap((l) => (senses[l] ?? []).filter((s) => !s.alias === q.includes('rdfs:label ?l'))
        .map((s) => ({ l: { value: l }, e: wd(s.e), sl: { value: String(s.sl) }, cs: { value: (s.cs ?? []).map((c) => wd(c).value).join(' ') } }))));
    }
    if (q.includes('wdt:P7937')) return json(Object.entries(kinds).flatMap(([id, cs]) => cs.map((c) => ({ w: wd(id), v: wd(c) }))));
    if (q.includes('hint:rangeSafe')) return json(q.includes('P577') ? [{ item: wd(NEW.id), cls: wd('Q7889'), sl: { value: '22' } }, { item: wd(NEW.id), cls: wd('Q5'), sl: { value: '22' } },
      { item: wd(catalog.works[0].id), cls: wd('Q11424'), sl: { value: '300' } }, { item: wd('Q1'), cls: wd('Q13442814'), sl: { value: '40' } }] : []);
    if (q.includes('rdfs:label ?en')) return json([{ w: wd(NEW.id), en: { value: NEW.title } }]);
    if (q.includes('wdt:P577')) return json([{ w: wd(NEW.id), d: { value: '2026-03-01T00:00:00Z' } }]);
    if (q.includes('skos:altLabel')) return json([{ w: wd(NEW.id), a: { value: 'MFP', 'xml:lang': 'en' } }]);
    return json([]);
  }, { calls });
}
function memStorage(init = {}) {
  const data = structuredClone(init);
  return { data, get: async (k) => Object.fromEntries([k].flat().filter((x) => x in data).map((x) => [x, structuredClone(data[x])])), set: async (o) => { Object.assign(data, structuredClone(o)); } };
}

test('successful update stores a rebuilt index in one write; the new work matches', async () => {
  const storage = memStorage(), fetch = mockFetch('ok');
  const meta = await runUpdate({ storage, loadBundle: async () => bundle, fetch, endpoint: 'http://mock/sparql', now: 1000, sleep: async () => {} });
  assert.equal(meta.lastError, null);
  assert.equal(meta.added, 1);
  assert.equal(meta.stats.queries, 9); // 3 date windows, labels, kinds, years, aliases, 2 senses (no characters below popularity 40)
  const idx = storage.data.catalogIndex, bin = Buffer.from(idx.bin, 'base64');
  const m = new Matcher(bin.buffer.slice(bin.byteOffset, bin.byteOffset + bin.length), idx.meta);
  assert.deepEqual(m.evaluate('Moonfall Protocol has a wild ending').map((g) => idx.meta.groups[g][0]), ['Moonfall Protocol']);
  assert.deepEqual(storage.data.catalogAdded.map((w) => w.id), [NEW.id]);
  // second run: nothing new, nothing rewritten
  const before = storage.data.catalogIndex;
  const again = await runUpdate({ storage, loadBundle: async () => bundle, fetch, endpoint: 'x', now: 2000, sleep: async () => {} });
  assert.equal(again.found, 0);
  assert.equal(storage.data.catalogIndex, before);
});

for (const mode of ['429', 'bad']) {
  test(`failed update (${mode}) leaves the working index untouched and records the error`, async () => {
    const old = { catalogIndex: { bin: 'AAAA', meta: { marker: 1 } }, catalogAdded: [NEW] };
    const storage = memStorage(old), sleeps = [];
    const meta = await runUpdate({ storage, loadBundle: async () => bundle, fetch: mockFetch(mode), endpoint: 'x', now: 5, sleep: async (ms) => sleeps.push(ms) });
    assert.ok(meta.lastError);
    assert.deepEqual(storage.data.catalogIndex, old.catalogIndex);
    assert.deepEqual(storage.data.catalogAdded, old.catalogAdded);
    if (mode === '429') { assert.equal(meta.stats.queries, 3); assert.deepEqual(sleeps, [1000, 1000]); } // Retry-After honoured, then give up
  });
}

const net = (fetch) => ({ fetch, endpoint: 'x', stats: { queries: 0, bytes: 0 }, sleep: async () => {} });
const delta = (fetch) => fetchDelta({ classes: bundle.classes, sinceYear: 2025, known: new Set(catalog.works.map((w) => w.id)),
  ambiguous: () => false, words, ...net(fetch) });

test('update: works that are not told as a story are left out', async () => {
  assert.deepEqual(await delta(mockFetch('ok', { kinds: { [NEW.id]: ['Q7889', 'Q93204'] } })), []); // a documentary
  assert.equal((await delta(mockFetch('ok', { kinds: { [NEW.id]: ['Q7889', 'Q93204', 'Q130232'] } }))).length, 1); // ...but a drama
});

test('update: names that mostly mean something else are flagged like in the catalog build', async () => {
  const senses = {
    'Moonfall Protocol': [{ e: 'Q123', sl: 90, cs: ['Q11424'] }], // a film: the same sense, not "other"
    MFP: [{ e: 'Q456', sl: 80, cs: ['Q4830453'], alias: true }], // a company known as MFP
  };
  const [w] = await delta(mockFetch('ok', { senses }));
  assert.deepEqual(w.other, ['MFP']);
});

test('update: when the sense lookup fails, short names count as "other" and the update still succeeds', async () => {
  const [w] = await delta(mockFetch('ok', { senseMode: '429' }));
  assert.deepEqual(w.other, ['Moonfall Protocol', 'MFP']);
  const storage = memStorage();
  const meta = await runUpdate({ storage, loadBundle: async () => bundle, fetch: mockFetch('ok', { senseMode: '429' }), endpoint: 'x', now: 1, sleep: async () => {} });
  assert.equal(meta.lastError, null);
  assert.deepEqual(storage.data.catalogAdded[0].other, ['Moonfall Protocol', 'MFP']);
});

test('update: the sense lookup sends at most MAX_SENSE_QUERIES queries', async () => {
  const many = Array.from({ length: 4000 }, (_, i) => `Q${990000000 + i}`);
  const fetch = async (url, init) => {
    const q = new URLSearchParams(init.body).get('query');
    if (q.includes('hint:rangeSafe')) return json(q.includes('P577') ? many.map((id) => ({ item: wd(id), cls: wd('Q7889'), sl: { value: '20' } })) : []);
    if (q.includes('rdfs:label ?en')) return json([...q.matchAll(/wd:(Q\d+)/g)].map((m) => ({ w: wd(m[1]), en: { value: `Title ${m[1]}` } })));
    return json([]);
  };
  const n = net(fetch), senseCalls = [];
  const spy = async (url, init) => { if (new URLSearchParams(init.body).get('query').includes('VALUES ?l')) senseCalls.push(1); return fetch(url, init); };
  const works = await fetchDelta({ classes: bundle.classes, sinceYear: 2025, known: new Set(), ambiguous: () => false, words, ...n, fetch: spy });
  assert.equal(works.length, 4000);
  assert.equal(senseCalls.length, MAX_SENSE_QUERIES);
  // 10 batches of 150 names were looked up (no other sense); the rest, unconfirmed two-word titles, fail safe
  assert.equal(works.filter((w) => w.other).length, 4000 - (MAX_SENSE_QUERIES / 2) * 150);
});

test('hand-entered works are never flagged', () => {
  assert.ok(customWorks([{ id: 'custom:1', title: 'Palestine', type: 'book' }], words).every((w) => !w.other));
});
