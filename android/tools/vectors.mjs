// Shared test vectors for the Java matcher port (extensions/blocker/src/test/.../MatcherTest.java).
// Every expected value is produced by the extension's own JS matcher (src/content/matcher.js), so the Java port is
// checked against the real implementation, not against a re-statement of it:
//   1. the hand-written cases of test/matcher.test.js and test/catalog.test.js (also asserted against their literal
//      expected values here, so a drift of the JS side is caught too);
//   2. a seeded random corpus of sentences built from catalog names (casing, quotes, hashtags, years, context words,
//      random seen sets) on both the fixture catalog and the shipped dist index.
// usage (from the repo root or android/): node android/tools/vectors.mjs
import fs from 'node:fs';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const out = path.join(repo, 'android/build/vectors');
const { buildIndex } = await import(path.join(repo, 'tools/build-index.mjs'));
const { Matcher } = globalThis.SBMatcher;
fs.mkdirSync(out, { recursive: true });

function vectorsFor(m, meta) {
  const v = [];
  const run = (text, seen = []) => {
    const s = new Set(seen);
    const labels = m.evaluate(text, (g) => meta.groups[g].slice(1).every((w) => s.has(w))).map((g) => meta.groups[g][0]);
    v.push({ text, seen, expect: labels });
    return labels;
  };
  return { v, run };
}

// ---------- fixture catalog: test/matcher.test.js ----------
const small = buildIndex(JSON.parse(fs.readFileSync(path.join(repo, 'test/fixtures/catalog.small.json'), 'utf8')));
fs.writeFileSync(path.join(out, 'fixture.bin'), Buffer.from(small.bin));
fs.writeFileSync(path.join(out, 'fixture.json'), JSON.stringify(small.meta));
const fm = new Matcher(small.bin, small.meta);
const F = vectorsFor(fm, small.meta);
const idx = (title, type) => small.meta.titles.findIndex((t, i) => t === title && (!type || small.meta.types[i] === type));
const cases = [
  ['omg Breaking Bad season 5 is insane', ['Breaking Bad']],
  ['omg game of thrones season 5 is insane', ['Game of Thrones']],
  ['omg breaking bad season 5 is insane', []],
  ['Walter White is the best', ['Breaking Bad']],
  ['Pokemon and Pokémon', ['Pokémon']],
  ['Pac-Man fever', ['Pac-Man']],
  ['Marley and Me (2008) made me cry', ['Marley & Me']],
  ['#BreakingBad finale tonight', ['Breaking Bad']],
  ['Harry Potter and the Philosopher’s Stone', ['Harry Potter']],
  ['Breaking Badminton records', []],
  ['the matrixes of linear algebra', []],
  ['breakingbad without a hashtag', []],
  ['Had a lovely walk in the park with my dog today.', []],
  ['I lost my keys again', []],
  ['It was a great movie', []],
  ['Pick me up at 5', []],
  ['Lost and found office', []],
  ['my favourite\nMarley and Me movie night', []], // a line break starts a new text, as the text start does
  ['my friends are coming over to watch the game', []],
  ['He lost the game last season', []],
  ['Lost season 6 was a mess', ['Lost']],
  ['I watched It last night and the movie was terrifying', ['It']],
  ['#Lost rewatch thread', ['Lost']],
  ['Have you seen "Up"?', ['Up']],
  ['Carl Fredricksen in Up broke me', ['Up']],
  ['Pennywise is so creepy, It is the scariest', ['It']],
  ['Lost (2004) is great', ['Lost']],
  ['The Office finale made me cry', ['The Office']],
  ['marley and me went for a walk', []],
  ['Marley and Me went for a walk', []],
  ['#MarleyAndMe made me cry', ['Marley & Me']],
  ['Breaking Bad is overrated', ['Breaking Bad']],
  ['Eleven people came to the party', []],
  ['Steve went to the store', []],
  ['Eleven and Jim Hopper in season 4', ['Stranger Things']],
  ['Snape kills Dumbledore at the end of the sixth book.', ['Harry Potter']],
  ['a snape and a dumbledore walk into a bar', []],
  ['Snape was here', []],
  ['Dune was amazing', ['Dune']],
  ['Star Wars vs Breaking Bad', ['Star Wars', 'Breaking Bad']],
  // sequel numerals (Roman <-> Arabic) and joined short forms
  ...['Grand Theft Auto VI delayed', 'grand theft auto 6 gameplay', 'GTA 6 leak', 'GTA VI trailer', 'gta6 map leaked', '#GTA6',
    '#GTAVI', 'gta 6 is coming', 'Lucia dies in GTA VI', '#GrandTheftAutoVI', '#GrandTheftAuto6'].map((t) => [t, ['Grand Theft Auto VI']]),
  ['GTA V online is still popular', ['Grand Theft Auto V']],
  ['Rocky 2 is underrated', ['Rocky II']],
  ['Final Fantasy 7 remake looks great', ['Final Fantasy VII']],
  ['TLOU2 broke me', ['The Last of Us Part II']],
  ['I think 6 is enough', []],
];
for (const [text, expected] of cases) assert.deepEqual(F.run(text), expected, text);
const movie = idx('Dune', 'movie'), book = idx('Dune', 'book');
assert.deepEqual(F.run('Dune was amazing', [movie]), ['Dune']);
assert.deepEqual(F.run('Dune was amazing', [movie, book]), []);

// ---------- real catalog (the shipped dist index): test/catalog.test.js ----------
const distDir = path.join(repo, 'dist/firefox/data');
const dbin = fs.readFileSync(path.join(distDir, 'index.bin'));
const dmeta = JSON.parse(fs.readFileSync(path.join(distDir, 'index.json'), 'utf8'));
const catalogFile = path.join(repo, 'data/catalog.json');
if (fs.existsSync(catalogFile)) { // the shipped index must be the one data/catalog.json builds
  const fresh = buildIndex(JSON.parse(fs.readFileSync(catalogFile, 'utf8')));
  assert.ok(Buffer.from(fresh.bin).equals(dbin), 'dist/firefox/data/index.bin is stale: run `npm run build`');
}
const dm = new Matcher(dbin.buffer.slice(dbin.byteOffset, dbin.byteOffset + dbin.byteLength), dmeta);
const D = vectorsFor(dm, dmeta);
const groups = []; // { text, label, members: [title], types: [type] }: group membership as the overlay sees it
const series = {
  'Star Wars': ['Star Wars: Episode IV – A New Hope', 'Star Wars: Episode V – The Empire Strikes Back'],
  'Harry Potter': ['Harry Potter', 'Harry Potter: Wizards Unite'],
  'The Lord of the Rings': ['The Lord of the Rings', 'The Lord of the Rings: The Two Towers', 'The Lord of the Rings: The Rings of Power'],
  'The Witcher': ['The Witcher', 'The Witcher: Blood Origin', 'The Witcher: Nightmare of the Wolf'],
};
const groupOf = (text) => { const gs = dm.evaluate(text); assert.ok(gs.length, text); return dmeta.groups[gs[0]]; };
for (const [name, members] of Object.entries(series)) {
  const text = `Talking about ${name} tonight`;
  const g = groupOf(text);
  assert.equal(g[0], name);
  for (const t of members) assert.ok(g.slice(1).some((w) => dmeta.titles[w] === t), `${name} lacks ${t}`);
  groups.push({ text, label: name, members, types: [] });
  D.run(text);
  assert.ok(!D.run(text, g.slice(1)).includes(name)); // "I've seen {label}" writes every work of the group
}
groups.push({ text: 'The Witcher is great', label: 'The Witcher', members: [], types: ['tv', 'book', 'game'] });
const tlou = groupOf('The Last of Us finale was brutal');
assert.equal(tlou[0], 'The Last of Us');
groups.push({ text: 'The Last of Us finale was brutal', label: 'The Last of Us', members: [], types: ['game', 'tv'] });
const tv = tlou.slice(1).find((w) => dmeta.types[w] === 'tv');
assert.ok(D.run('The Last of Us finale was brutal', [tv]).length > 0); // partially seen group still blocks
assert.deepEqual(D.run('I love it when it rains'), []);
// YouTube's accessibility labels arrive as separate lines: "Go" (the film) must not take "TV" from a channel name
assert.deepEqual(D.run('Dexter: Resurrection 2x04 Promo (HD) - 31 seconds - play video\nGo to channel TV Promos\nAction menu'), []);
// sequel numbers and joined short forms (test/catalog.test.js) plus the phrasings the Android demo shows
for (const t of ['Grand Theft Auto VI delayed', 'grand theft auto 6 gameplay', 'GTA 6 leak', 'GTA VI trailer', 'gta6 map leaked', '#GTA6',
  '#GTAVI', 'Lucia dies in GTA VI', 'GTA 6', 'gta6', 'grand theft auto 6', 'GTA 6 leak shows the ending']) {
  assert.ok(D.run(t).includes('Grand Theft Auto VI'), t);
}
assert.deepEqual(D.run('GTA V online'), ['Grand Theft Auto V']);
assert.ok(D.run('TLOU2 broke me').some((l) => l.startsWith('The Last of Us')));
assert.ok(D.run('Rocky 2 is underrated').includes('Rocky II'));
assert.ok(D.run('Final Fantasy 7 remake').some((l) => l.startsWith('Final Fantasy VII')));
for (const t of ['Chapter 6 of my thesis', 'Windows 11 update', 'top 5 tips', 'iPhone 16']) assert.deepEqual(D.run(t), [], t);

// ---------- seeded random corpus ----------
let seed = 0x5eed;
const rnd = () => ((seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 2 ** 32);
const pick = (a) => a[Math.floor(rnd() * a.length)];
const CTX = ['season 2', 'the finale', 'episode', 'movie', 'trailer', 'the ending', 'S02E05', 'netflix', 'book', 'game'];
const FILL = ['honestly', 'I think', 'my friend said', 'lol', 'today', 'again', 'the best', 'not sure', 'Wow.', 'ok so'];
function corpus(R, catalog, meta, n) {
  const names = [];
  for (const w of catalog.works) { names.push(w.title, ...(w.aliases ?? []), ...(w.characters ?? [])); }
  const shape = (s) => [s, s.toLowerCase(), s.toUpperCase(), `"${s}"`, `#${s.replace(/[^\p{L}\p{N}]/gu, '')}`, `*${s}*`, `${s}'s`][Math.floor(rnd() * 7)];
  for (let k = 0; k < n; k++) {
    const parts = [];
    const m = 1 + Math.floor(rnd() * 3);
    for (let j = 0; j < m; j++) {
      if (rnd() < 0.5) parts.push(pick(FILL));
      parts.push(shape(pick(names)));
      if (rnd() < 0.4) parts.push(pick(CTX));
      if (rnd() < 0.15) parts.push(`(${1950 + Math.floor(rnd() * 75)})`);
      if (rnd() < 0.2) parts.push(pick(['.', '!', '?', ':', '-', '\n', '•']));
    }
    const seen = [];
    if (rnd() < 0.3) for (let j = 0; j < 3; j++) seen.push(Math.floor(rnd() * meta.ids.length));
    R.run(parts.join(' '), seen);
  }
}
corpus(F, JSON.parse(fs.readFileSync(path.join(repo, 'test/fixtures/catalog.small.json'), 'utf8')), small.meta, 3000);
if (fs.existsSync(catalogFile)) corpus(D, JSON.parse(fs.readFileSync(catalogFile, 'utf8')), dmeta, 5000);

fs.writeFileSync(path.join(out, 'fixture-cases.json'), JSON.stringify(F.v));
fs.writeFileSync(path.join(out, 'dist-cases.json'), JSON.stringify({ cases: D.v, groups }));
const nonEmpty = (v) => v.filter((x) => x.expect.length).length;
console.log(`vectors: fixture ${F.v.length} (${nonEmpty(F.v)} matching), dist ${D.v.length} (${nonEmpty(D.v)} matching) -> ${out}`);
