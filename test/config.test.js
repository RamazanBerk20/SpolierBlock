import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { buildIndex } from '../tools/build-index.mjs';
import { rebuild, runUpdate, customWorks, withNames, CUSTOM_POP } from '../src/background/catalog-update.js';
import { migrate, parseImport, applyImport, exportFile, withDefaults, normHost, nextCustomId, DEFAULTS, cleanLearned, mergeLearned, cleanNames } from '../src/options/config.js';
const { Matcher } = globalThis.SBMatcher;

test('migration 0.1 -> 0.2: seen becomes works, mode becomes style, old keys go', () => {
  const plan = migrate({
    seen: { Q1: { title: 'Dune', type: 'book', year: 1965, ts: 5 }, Q2: { title: 'Arrival', type: 'movie', year: null, ts: 6 } },
    settings: { enabled: false, scanImages: true, mode: 'spoiler', pausedSites: ['x.com'], catalogUpdate: 'weekly' },
    works: { Q2: { state: 'blocked', style: 'all', title: 'Arrival', type: 'movie', year: 2016, ts: 9 } },
  });
  assert.deepEqual(plan.remove, ['seen']);
  assert.deepEqual(plan.set.works.Q1, { state: 'seen', style: null, title: 'Dune', type: 'book', year: 1965, ts: 5 });
  assert.equal(plan.set.works.Q2.state, 'blocked'); // an existing 0.2 entry wins
  assert.deepEqual(plan.set.settings, { enabled: false, scanImages: true, style: 'spoilers', pausedSites: ['x.com'], catalogUpdate: 'weekly' });
  assert.equal(migrate({ settings: { mode: 'any' } }).set.settings.style, 'all');
  assert.equal(migrate({ settings: { mode: 'any' } }).remove.length, 0);
  assert.equal(migrate({ works: {}, settings: { style: 'all' } }), null); // already migrated: nothing to do
  assert.equal(migrate({}), null);
});

const file = (o) => JSON.stringify({ format: 'spolierblock', version: 1, exportedAt: '2026-11-18T12:00:00Z', works: {}, custom: [], settings: {}, ...o });

test('import refuses wrong files with a message and never throws', () => {
  for (const [text, re] of [['not json', /not valid JSON/], ['[]', /not a SpolierBlock/], [JSON.stringify({ format: 'other', version: 1 }), /not a SpolierBlock/],
    [file({ version: 2 }), /newer SpolierBlock/], [file({ version: '1' }), /no valid version/], ['x'.repeat(5e6 + 1), /too large/]]) {
    const r = parseImport(text);
    assert.equal(r.ok, false);
    assert.match(r.error, re);
  }
});

test('import keeps only well-formed entries and ignores unknown keys', () => {
  const r = parseImport(file({
    extra: 1,
    works: {
      Q1: { state: 'seen', style: null, title: ' Dune ', type: 'book', year: 1965, ts: 3, evil: '<script>' },
      Q2: { state: 'blocked', style: 'loud', title: 'Arrival', type: 'film', year: 'x' }, // bad style/type/year are reset
      Q3: { state: 'maybe', title: 'X' }, Q4: { state: 'seen' }, ['__proto__']: { state: 'seen', title: 'p' }, 'a b': { state: 'seen', title: 'y' },
    },
    custom: [{ id: 'custom:1', title: 'Hollow Pines', aliases: ['HP', 'hp', 'Hollow Pines', 7], type: 'game' }, { id: 'custom:1', title: 'Dup', type: 'game' },
      { id: 'Q9', title: 'Not custom', type: 'game' }, { id: 'custom:2', title: 'No type' }],
    settings: { enabled: false, style: 'spoilers', blockUnlisted: 'yes', pausedSites: ['https://www.Example.com/a', 'bad host!', 3], catalogUpdate: 'hourly' },
  }));
  assert.equal(r.ok, true);
  assert.deepEqual(Object.keys(r.data.works), ['Q1', 'Q2']);
  assert.deepEqual(r.data.works.Q1, { state: 'seen', style: null, title: 'Dune', type: 'book', year: 1965, ts: 3 });
  assert.deepEqual({ ...r.data.works.Q2, ts: 0 }, { state: 'blocked', style: null, title: 'Arrival', type: null, year: null, ts: 0 });
  assert.deepEqual(r.data.custom, [{ id: 'custom:1', title: 'Hollow Pines', aliases: ['HP'], type: 'game' }]);
  assert.deepEqual(r.data.settings, { enabled: false, style: 'spoilers', pausedSites: ['example.com'] });
  assert.equal(r.skipped, 4 + 3);
});

test('captionlessVideos (rule 10, removed): an older config or export file is accepted and the key is dropped', () => {
  const r = parseImport(file({ settings: { captionlessVideos: ['x.com'], pausedSites: ['x.com'] } }));
  assert.equal(r.ok, true);
  assert.deepEqual(r.data.settings, { pausedSites: ['x.com'] });
  const stored = withDefaults({ captionlessVideos: ['x.com'] });
  assert.equal('captionlessVideos' in stored, false);
  assert.equal('captionlessVideos' in exportFile({ settings: { captionlessVideos: ['x.com'] } }).settings, false);
});

test('merge: imported wins per id, settings only when asked; replace: everything from the file', () => {
  const current = { works: { Q1: { state: 'seen', title: 'A' }, Q2: { state: 'seen', title: 'B' } }, custom: [{ id: 'custom:1', title: 'Old', aliases: [], type: 'game' }], settings: { enabled: false, style: 'all' } };
  const imported = { works: { Q2: { state: 'blocked', title: 'B' }, Q3: { state: 'seen', title: 'C' } }, custom: [{ id: 'custom:1', title: 'New', aliases: [], type: 'book' }], settings: { style: 'spoilers' } };
  const m = applyImport(current, imported, { mode: 'merge', withSettings: false });
  assert.deepEqual(Object.keys(m.works), ['Q1', 'Q2', 'Q3']);
  assert.equal(m.works.Q2.state, 'blocked');
  assert.equal(m.custom[0].title, 'New');
  assert.deepEqual(m.settings, withDefaults({ enabled: false, style: 'all' }));
  assert.equal(applyImport(current, imported, { mode: 'merge', withSettings: true }).settings.style, 'spoilers');
  assert.equal(applyImport(current, imported, { mode: 'merge', withSettings: true }).settings.enabled, false);
  const r = applyImport(current, imported, { mode: 'replace' });
  assert.deepEqual(r.works, imported.works);
  assert.deepEqual(r.settings, { ...DEFAULTS, style: 'spoilers' });
  assert.deepEqual(applyImport({}, imported, { mode: 'merge' }).custom.length, 1); // empty store
});

test('export round-trips through import', () => {
  const store = { works: { Q1: { state: 'seen', style: 'spoilers', title: 'Dune', type: 'book', year: 1965, ts: 1 } }, custom: [{ id: 'custom:4', title: 'Hollow Pines', aliases: ['HP'], type: 'game' }], settings: { style: 'spoilers' } };
  const out = exportFile(store, new Date('2026-11-18T12:00:00.123Z'));
  assert.equal(out.exportedAt, '2026-11-18T12:00:00Z');
  const back = parseImport(JSON.stringify(out));
  assert.deepEqual(back.data.works, store.works);
  assert.deepEqual(back.data.custom, store.custom);
  assert.deepEqual(withDefaults(back.data.settings), withDefaults(store.settings));
  assert.equal(back.skipped, 0);
});

test('small helpers', () => {
  assert.equal(normHost('https://www.Reddit.com/r/x'), 'reddit.com');
  assert.equal(normHost('news.ycombinator.com'), 'news.ycombinator.com');
  assert.equal(normHost('localhost'), 'localhost');
  assert.equal(normHost('nonsense'), null);
  assert.equal(normHost('a b.com'), null);
  assert.equal(nextCustomId([]), 'custom:1');
  assert.equal(nextCustomId([{ id: 'custom:3' }, { id: 'custom:1' }]), 'custom:4');
});

// ---------- custom works are indexed like catalog works ----------
const catalog = JSON.parse(fs.readFileSync(new URL('./fixtures/catalog.small.json', import.meta.url)));
const words = fs.readFileSync(new URL('../tools/catalog/common-words.txt', import.meta.url), 'utf8');
const bundle = { catalog, words, meta: buildIndex(catalog).meta, info: { builtAt: '2026-11-18T00:00:00Z' }, classes: {} };
const matcher = ({ bin, meta }) => new Matcher(bin, meta);
const CUSTOM = [{ id: 'custom:1', title: 'Hollow Pines', aliases: ['HPX'], type: 'game' }, { id: 'custom:2', title: 'Rain', aliases: [], type: 'book' }];

test('custom works are shaped as popular catalog works with computed ambiguity', () => {
  const [a, b] = customWorks(CUSTOM, words);
  assert.deepEqual(a, { id: 'custom:1', title: 'Hollow Pines', type: 'game', year: null, aliases: ['HPX'], characters: [], pop: CUSTOM_POP, ambiguous: false });
  assert.equal(b.ambiguous, true); // one everyday word
});

test('rebuild with custom works: they match in text, by title and alias', () => {
  const built = rebuild(bundle, [], CUSTOM);
  const m = matcher(built);
  const hit = (t) => m.evaluate(t, () => false).map((g) => built.meta.groups[g].slice(1).map((i) => built.meta.ids[i])).flat();
  assert.deepEqual(hit('Finally finished Hollow Pines, what an ending'), ['custom:1']);
  assert.deepEqual(hit('HPX ending explained'), ['custom:1']);
  assert.ok(hit('Breaking Bad season 5').length); // bundled works still match
  // bundled groups still map into the rebuilt index (CLIP verdicts use bundled groups)
  bundle.meta.groups.forEach((g, i) => assert.equal(built.meta.groups[built.meta.fromBundled[i]][0], g[0]));
});

test('a catalog update keeps the custom works in the index it writes', async () => {
  const data = { custom: CUSTOM };
  const storage = { get: async (k) => Object.fromEntries([k].flat().filter((x) => x in data).map((x) => [x, data[x]])), set: async (o) => Object.assign(data, o) };
  const NEW = { id: 'Q999000001', title: 'Moonfall Protocol', type: 'game' };
  const json = (rows) => new Response(JSON.stringify({ results: { bindings: rows } }));
  const wd = (id) => ({ value: 'http://www.wikidata.org/entity/' + id });
  const fetch = async (_u, init) => {
    const q = new URLSearchParams(init.body).get('query');
    if (q.includes('hint:rangeSafe')) return json(q.includes('P577') ? [{ item: wd(NEW.id), cls: wd('Q7889'), sl: { value: '22' } }] : []);
    if (q.includes('rdfs:label ?en')) return json([{ w: wd(NEW.id), en: { value: NEW.title } }]);
    return json([]);
  };
  await runUpdate({ storage, loadBundle: async () => ({ ...bundle, classes: { game: ['Q7889'] } }), fetch, endpoint: 'x', now: 1, sleep: async () => {} });
  const ids = data.catalogIndex.meta.ids;
  assert.ok(ids.includes(NEW.id) && ids.includes('custom:1') && ids.includes('custom:2'));
  assert.deepEqual(data.catalogAdded.map((w) => w.id), [NEW.id]); // custom works are not stored as catalog additions
});

// ---------- learned (contract rule 11) ----------
test('learned: malformed entries are dropped, names trimmed and limited, keys lower-case host[/source]', () => {
  const l = cleanLearned({
    names: { Q1: [' BrBa ', 'brba', 'x', 'y'.repeat(61), 3, 'Heisenberg show'], Q2: [], __proto__: ['a'], 'bad id': ['Name'], Q3: 'BrBa' },
    not: { Q4: ['youtube.com/dokuzsekiz müzik', 'x.com/@somebody', 'reddit.com', 'Reddit.com', 'reddit.com', 'nohost', 'x.com/', 'x.com/ ', 7], Q5: ['bad'] },
    clips: [{ id: 'c1', work: 'Q6', ts: 5, emb: ['x'] }], // a dropped feature: ignored
  });
  assert.deepEqual(l.names, { Q1: ['BrBa', 'Heisenberg show'] });
  assert.deepEqual(l.not, { Q4: ['youtube.com/dokuzsekiz müzik', 'x.com/@somebody', 'reddit.com'] });
  assert.deepEqual(Object.keys(l), ['names', 'not']);
  assert.deepEqual(cleanLearned(undefined), { names: {}, not: {} });
  assert.equal(cleanNames(Array.from({ length: 30 }, (_, i) => 'Name ' + i)).length, 20);
});

test('learned: export, import, merge unions and replace', () => {
  const cur = { learned: { names: { Q1: ['BrBa'] }, not: { Q2: ['reddit.com'] } } };
  const out = exportFile(cur);
  assert.deepEqual(out.learned, cur.learned);
  const imp = parseImport(file({ learned: { names: { Q1: ['brba', 'Walter show'], Q9: ['Nine'] }, not: { Q2: ['x.com/@a'] }, clips: [{ id: 'c1', work: 'Q3', ts: 2, emb: ['x'] }] } })).data;
  const m = applyImport(cur, imp, { mode: 'merge' }).learned;
  assert.deepEqual(m.names, { Q1: ['BrBa', 'Walter show'], Q9: ['Nine'] });
  assert.deepEqual(m.not, { Q2: ['reddit.com', 'x.com/@a'] });
  assert.equal(m.clips, undefined);
  assert.deepEqual(applyImport(cur, imp, { mode: 'replace' }).learned, imp.learned);
  assert.deepEqual(parseImport(file({})).data.learned, { names: {}, not: {} }); // an older file has none
  assert.deepEqual(mergeLearned(undefined, undefined), { names: {}, not: {} });
});

test('learned names are indexed as aliases of their work, catalog or custom', () => {
  const id = catalog.works.find((w) => w.title === 'Breaking Bad').id;
  const names = { [id]: ['Albuquerque Chemistry Tales', 'BBX'], 'custom:2': ['Rainfall Saga'] };
  assert.deepEqual(withNames([{ id, aliases: ['A'] }, { id: 'Q0' }], names), [{ id, aliases: ['A', 'Albuquerque Chemistry Tales', 'BBX'] }, { id: 'Q0' }]);
  const built = rebuild(bundle, [], CUSTOM, names);
  const m = matcher(built);
  const hit = (t) => m.evaluate(t, () => false).map((g) => built.meta.groups[g].slice(1).map((i) => built.meta.ids[i])).flat();
  assert.deepEqual(hit('Finally finished Albuquerque Chemistry Tales, what an ending'), [id]);
  assert.deepEqual(hit('BBX ending explained'), [id]);
  assert.deepEqual(hit('The Rainfall Saga ending made me cry'), ['custom:2']);
  assert.deepEqual(matcher(rebuild(bundle, [], CUSTOM)).evaluate('Finally finished Albuquerque Chemistry Tales, what an ending', () => false), []); // not without the name
});
