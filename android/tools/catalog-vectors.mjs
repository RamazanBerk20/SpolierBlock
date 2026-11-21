// Expected outputs for the Java port of the catalog update (CatalogTest.java), produced by the extension's own JS:
//   1. the delta fetch (src/background/catalog-update.js fetchDelta) against the mock world of tools/mock-sparql.mjs,
//      recording every query and answer so the Java client can be fed the same exchange and must send the same queries;
//   2. the rebuilt index (bundled catalog + that delta, merged and built by src/shared/build-index.js) as bytes;
//   3. the index with hand-added works and learned.names (contract rule 11) for a catalog and a custom work, as
//      src/background/catalog-update.js rebuild builds it, plus the config it was built from.
// The bundled-only case needs no output: the expected bytes are dist/firefox/data/index.{bin,json} themselves
// (tools/vectors.mjs checks that they are what data/catalog.json builds).
// usage: node android/tools/catalog-vectors.mjs
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { answer } from './mock-sparql.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const dist = path.join(repo, 'dist/firefox/data');
const out = path.join(repo, 'android/build/vectors');
fs.mkdirSync(out, { recursive: true });
const { fetchDelta, mergeCatalog, customWorks, withNames } = await import(path.join(repo, 'src/background/catalog-update.js'));
const { buildIndex, setCommonWords } = await import(path.join(repo, 'src/shared/build-index.js'));
const { makeAmbiguous } = await import(path.join(repo, 'src/shared/catalog-rules.js'));

const catalog = JSON.parse(fs.readFileSync(path.join(dist, 'catalog.json'), 'utf8'));
const words = fs.readFileSync(path.join(dist, 'common-words.txt'), 'utf8');
const classes = JSON.parse(fs.readFileSync(path.join(dist, 'catalog-classes.json'), 'utf8'));
const info = JSON.parse(fs.readFileSync(path.join(dist, 'catalog-info.json'), 'utf8'));

const exchanges = []; // [query, answer]
const fetch = async (url, init) => {
  const q = init.body.get('query');
  const body = answer(q);
  exchanges.push([q, body]);
  return { ok: true, status: 200, text: async () => body, headers: { get: () => null } };
};
const stats = { queries: 0, bytes: 0 };
const sinceYear = new Date(info.builtAt).getUTCFullYear() - 1;
const known = new Set(catalog.works.map((w) => w.id));
const series = { table: catalog.series, works: catalog.works };
const fresh = await fetchDelta({ classes, sinceYear, known, ambiguous: makeAmbiguous(words), words, series, fetch, endpoint: 'mock', stats });

setCommonWords(words);
const bundledBuilt = buildIndex(catalog);
assert.ok(Buffer.from(bundledBuilt.bin).equals(fs.readFileSync(path.join(dist, 'index.bin'))), 'dist index.bin is not the build of dist catalog.json');
assert.equal(JSON.stringify(bundledBuilt.meta), fs.readFileSync(path.join(dist, 'index.json'), 'utf8'));
const built = buildIndex(mergeCatalog(catalog, fresh));

// the sequel joined the series group: what "I've seen Star Wars" marks contains it
const sw = built.meta.ids.indexOf('Q900000002');
assert.ok(sw >= 0);
assert.ok(built.meta.groups.some((g) => g[0] === 'Star Wars' && g.includes(sw, 1) && g.length > 3), 'sequel not in the Star Wars group');
assert.deepEqual(fresh.map((w) => w.id).sort(), ['Q900000001', 'Q900000002', 'Q900000003', 'Q900000005', 'Q900000007', 'Q900000008', 'Q900000009']);
// "other" names: a city called Zorblax, a person nicknamed Hollow Crown; not the character, the dab page or the minor item
const other = Object.fromEntries(fresh.map((w) => [w.id, w.other ?? []]));
assert.deepEqual(other.Q900000001, ['Zorblax']);
assert.ok(other.Q900000009.includes('Hollow Crown'));
assert.deepEqual(other.Q900000007, []);
assert.deepEqual(other.Q900000008, []);

// series: the sequel through Wikidata's Q462, GTA VII by its title; both are listed with their series in the index
const seriesOf = Object.fromEntries(fresh.map((w) => [w.id, w.series ?? []]));
const label = (id) => catalog.series[id]?.[0];
assert.deepEqual(seriesOf.Q900000002.map(label), ['Star Wars']);
assert.deepEqual(seriesOf.Q900000003.map(label), ['Grand Theft Auto']);
assert.ok(built.meta.series.some((l) => l.includes(sw) && l.length > 20), 'sequel not listed with Star Wars');

// rule 11: learned.names appended to a catalog work's and a custom work's aliases, then built like any alias
const bb = catalog.works.find((w) => w.title === 'Breaking Bad').id;
const namesCfg = {
  custom: [{ id: 'custom:1', title: 'Zorvak Saga', aliases: ['ZS'], type: 'game' }, { id: 'custom:2', title: 'Rainfall Hollow', aliases: [], type: 'book' }],
  learned: { names: { [bb]: ['Albuquerque Chemistry Tales', 'BBX'], 'custom:2': ['Rainfall Saga'] }, not: {} },
};
const namesMerged = mergeCatalog(catalog, customWorks(namesCfg.custom, words));
const namesBuilt = buildIndex({ ...namesMerged, works: withNames(namesMerged.works, namesCfg.learned.names) });
assert.ok(!Buffer.from(namesBuilt.bin).equals(Buffer.from(buildIndex(namesMerged).bin)), 'learned names changed nothing');
fs.writeFileSync(path.join(out, 'names-config.json'), JSON.stringify(namesCfg));
fs.writeFileSync(path.join(out, 'names-index.bin'), Buffer.from(namesBuilt.bin));
fs.writeFileSync(path.join(out, 'names-index.json'), JSON.stringify(namesBuilt.meta));

fs.writeFileSync(path.join(out, 'delta-http.json'), JSON.stringify({ sinceYear, exchanges }));
fs.writeFileSync(path.join(out, 'delta-works.json'), JSON.stringify(fresh));
fs.writeFileSync(path.join(out, 'delta-index.bin'), Buffer.from(built.bin));
fs.writeFileSync(path.join(out, 'delta-index.json'), JSON.stringify(built.meta));
console.log(`catalog vectors: ${stats.queries} queries, ${fresh.length} new works, ${built.meta.ids.length} works in rebuilt index -> ${out}`);
