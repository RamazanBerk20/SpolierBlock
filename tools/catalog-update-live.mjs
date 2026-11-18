// One real catalog update against live Wikidata, with the extension's own code (src/background/catalog-update.js)
// and the bundled data of dist/firefox. Prints queries, bytes, seconds, new works and samples. Nothing is written.
// usage: node tools/catalog-update-live.mjs
import fs from 'node:fs';
import { runUpdate, ENDPOINT } from '../src/background/catalog-update.js';
const d = 'dist/firefox/data/';
const read = (f) => fs.readFileSync(d + f, 'utf8');
const bundle = { catalog: JSON.parse(read('catalog.json')), words: read('common-words.txt'), classes: JSON.parse(read('catalog-classes.json')),
  info: JSON.parse(read('catalog-info.json')), meta: JSON.parse(read('index.json')) };
// --simulate-old-bundle: drop bundled works dated >= the delta window, as if the bundle were older, and check that
// the update finds them again (recall of the delta query against the full catalog build).
const sinceYear = new Date(bundle.info.builtAt).getUTCFullYear() - 1;
const removed = process.argv.includes('--simulate-old-bundle') ? bundle.catalog.works.filter((w) => w.year >= sinceYear) : [];
if (removed.length) bundle.catalog = { ...bundle.catalog, works: bundle.catalog.works.filter((w) => !(w.year >= sinceYear)) };
const data = {};
const storage = { get: async () => ({}), set: async (o) => Object.assign(data, o) };
// Node only: identify the client as Wikimedia's policy asks (browsers send their own User-Agent)
const fetchUA = (url, init) => fetch(url, { ...init, headers: { ...init.headers, 'User-Agent': 'spolierblocker-update-test/1.0 (local test run)' } })
  .catch((e) => { console.log('fetch failed:', e.message, e.cause?.message ?? ''); throw e; });
const t0 = performance.now();
const meta = await runUpdate({ storage, loadBundle: async () => bundle, fetch: fetchUA, endpoint: ENDPOINT,
  sleep: (ms) => { console.log(`backing off ${ms} ms`); return new Promise((r) => setTimeout(r, ms)); } });
const s = ((performance.now() - t0) / 1000).toFixed(1);
console.log(`queries ${meta.stats.queries}, bytes ${meta.stats.bytes}, ${s} s, error: ${meta.lastError}`);
console.log(`new works: ${meta.found ?? 0} (bundled ${bundle.catalog.works.length}, delta window from ${new Date(bundle.info.builtAt).getUTCFullYear() - 1})`);
const added = data.catalogAdded ?? [];
const byType = {};
for (const w of added) byType[w.type] = (byType[w.type] ?? 0) + 1;
console.log('by type', byType);
for (const w of added.slice().sort((a, b) => b.pop - a.pop).slice(0, 10)) console.log(`  ${w.title} (${w.type}, ${w.year}, ${w.pop} sitelinks${w.aliases.length ? ', aka ' + w.aliases.slice(0, 2).join(' / ') : ''})`);
if (data.catalogIndex) console.log(`stored index: bin ${data.catalogIndex.bin.length} chars base64, meta ${JSON.stringify(data.catalogIndex.meta).length} chars, added works ${JSON.stringify(added).length} chars`);
if (removed.length) {
  const got = new Set(added.map((w) => w.id)), want = new Set(removed.map((w) => w.id));
  const hit = removed.filter((w) => got.has(w.id));
  console.log(`simulated old bundle: removed ${removed.length} works dated >= ${sinceYear}; update found ${hit.length} of them (${(100 * hit.length / removed.length).toFixed(1)}%), plus ${added.filter((w) => !want.has(w.id)).length} others`);
  const same = hit.filter((w) => JSON.stringify(added.find((a) => a.id === w.id)) === JSON.stringify(w)).length;
  console.log(`  identical to the full build's entry: ${same} of ${hit.length}`);
  console.log('  missed e.g.', removed.filter((w) => !got.has(w.id)).slice(0, 5).map((w) => `${w.title} (${w.type} ${w.year})`).join('; '));
}
