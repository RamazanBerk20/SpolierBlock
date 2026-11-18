// Name groups and derived series against the real catalog (skipped until data/catalog.json exists).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { buildIndex } from '../tools/build-index.mjs';
const { Matcher } = globalThis.SBMatcher;

const file = new URL('../data/catalog.json', import.meta.url);
const has = fs.existsSync(file);
const built = has ? buildIndex(JSON.parse(fs.readFileSync(file, 'utf8'))) : null;
const m = has ? new Matcher(built.bin, built.meta) : null;
const groupOf = (text) => { const gs = m.evaluate(text); assert.ok(gs.length, `no match in "${text}"`); return built.meta.groups[gs[0]]; };
const titlesOf = (g) => g.slice(1).map((w) => built.meta.titles[w]);
// what the overlay's "I've seen {label}" writes: every work of the group
const seeAll = (g) => new Set(g.slice(1));

test('derived series groups from the real catalog', { skip: !has && 'no data/catalog.json' }, () => {
  const cases = {
    'Star Wars': ['Star Wars: Episode IV – A New Hope', 'Star Wars: Episode V – The Empire Strikes Back'],
    'Harry Potter': ['Harry Potter', 'Harry Potter: Wizards Unite'],
    'The Lord of the Rings': ['The Lord of the Rings', 'The Lord of the Rings: The Two Towers', 'The Lord of the Rings: The Rings of Power'],
    'The Witcher': ['The Witcher', 'The Witcher: Blood Origin', 'The Witcher: Nightmare of the Wolf'],
  };
  for (const [name, members] of Object.entries(cases)) {
    const g = groupOf(`Talking about ${name} tonight`);
    assert.equal(g[0], name);
    const ts = titlesOf(g);
    for (const t of members) assert.ok(ts.includes(t), `${name} group lacks ${t}`);
    // marking the group seen in one write unblocks the name everywhere
    const seen = seeAll(g);
    assert.deepEqual(m.evaluate(`Talking about ${name} tonight`, (x) => built.meta.groups[x].slice(1).every((w) => seen.has(w)))
      .map((x) => built.meta.groups[x][0]).filter((l) => l === name), []);
  }
  // the witcher group carries the tv show, book and game that share the exact title
  const types = groupOf('The Witcher is great').slice(1).map((w) => built.meta.types[w]);
  for (const t of ['tv', 'book', 'game']) assert.ok(types.includes(t));
});

test('shared exact titles form one group; partially seen group still blocks', { skip: !has && 'no data/catalog.json' }, () => {
  const g = groupOf('The Last of Us finale was brutal');
  assert.equal(g[0], 'The Last of Us');
  const types = g.slice(1).map((w) => built.meta.types[w]);
  assert.ok(types.includes('game') && types.includes('tv'));
  const tv = g.slice(1).find((w) => built.meta.types[w] === 'tv');
  const seenOne = (x) => built.meta.groups[x].slice(1).every((w) => w === tv);
  assert.ok(m.evaluate('The Last of Us finale was brutal', seenOne).length > 0);
});

test('ambiguous single common words are not derived as series', { skip: !has && 'no data/catalog.json' }, () => {
  assert.deepEqual(m.evaluate('I love it when it rains'), []);
});

test('sequel numbers and joined short forms on the real catalog', { skip: !has && 'no data/catalog.json' }, () => {
  const labels = (t) => m.evaluate(t).map((g) => built.meta.groups[g][0]);
  const gta6 = built.meta.titles.indexOf('Grand Theft Auto VI');
  const names6 = (t) => m.evaluate(t).some((g) => built.meta.groups[g].includes(gta6, 1));
  for (const s of ['Grand Theft Auto VI delayed', 'grand theft auto 6 gameplay', 'GTA 6 leak', 'GTA VI trailer',
    'gta6 map leaked', '#GTA6', '#GTAVI', 'Lucia dies in GTA VI']) assert.ok(names6(s), s);
  const gta5 = built.meta.titles.indexOf('Grand Theft Auto V');
  const online = m.evaluate('GTA V online');
  assert.ok(online.some((g) => built.meta.groups[g].includes(gta5, 1)) && !online.some((g) => built.meta.groups[g].includes(gta6, 1)));
  assert.ok(labels('TLOU2 broke me').some((l) => l.startsWith('The Last of Us')), 'TLOU2');
  assert.ok(labels('Rocky 2 is underrated').includes('Rocky II'));
  assert.ok(labels('Final Fantasy 7 remake').some((l) => l.startsWith('Final Fantasy VII')));
  for (const s of ['Chapter 6 of my thesis', 'Windows 11 update', 'top 5 tips', 'iPhone 16']) assert.deepEqual(labels(s), [], s);
});

test('posts that are not about a work stay uncovered on the real catalog', { skip: !has && 'no data/catalog.json' }, () => {
  const labels = (t) => m.evaluate(t).map((g) => built.meta.groups[g][0]);
  for (const s of ['The Palestine debate on campus last night was civil. Both speakers took questions for an hour, what a show.',
    'Reading Proverbs 31 with my daughter, one chapter a day', 'Nintendo Switch Online price hike is coming? Please no.',
    'Why is the line at Paris Charles de Gaulle always the longest at 6am?', 'Chernobyl exclusion zone hit by a drone overnight',
    'Tesla stock is up 6% on no news. Markets are vibes now.']) assert.deepEqual(labels(s), [], s);
  for (const [s, l] of [['Dune: Part Two was incredible in IMAX', 'Dune: Part Two'], ['Rewatched Titanic last night, still crying', 'Titanic'],
    ['just finished Chernobyl on HBO, harrowing', 'Chernobyl'], ['Bloodborne is the best game FromSoftware has made', 'Bloodborne']]) {
    assert.ok(labels(s).includes(l), `${s} -> ${labels(s)}`);
  }
});
