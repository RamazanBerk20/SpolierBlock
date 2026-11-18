import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { buildIndex } from '../tools/build-index.mjs';
import { runUpdate, rebuild, mergeCatalog, alarmPlan, deltaQuery } from '../src/background/catalog-update.js';
const { Matcher } = globalThis.SBMatcher;

const catalog = JSON.parse(fs.readFileSync(new URL('./fixtures/catalog.small.json', import.meta.url)));
const words = fs.readFileSync(new URL('../tools/catalog/20k.txt', import.meta.url), 'utf8');
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

// fake SPARQL endpoint: answers the four query kinds runUpdate sends
const json = (rows) => new Response(JSON.stringify({ results: { bindings: rows } }), { status: 200 });
const wd = (id) => ({ value: 'http://www.wikidata.org/entity/' + id });
function mockFetch(mode) {
  const calls = [];
  return Object.assign(async (url, init) => {
    const q = new URLSearchParams(init.body).get('query');
    calls.push(q);
    if (mode === '429') return new Response('slow down', { status: 429, headers: { 'retry-after': '1' } });
    if (mode === 'bad') return new Response('<html>oops</html>', { status: 200 });
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
  assert.equal(meta.stats.queries, 6); // 3 date windows, labels, years, aliases (no characters below popularity 40)
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
