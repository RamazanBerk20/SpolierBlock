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

test('the sentence says what the work is, or that someone played, watched or finished it', { skip: !has && 'no data/catalog.json' }, () => {
  const labels = (t) => m.evaluate(t).map((g) => built.meta.groups[g][0]);
  for (const [t, l] of [['Portal is a perfect game', 'Portal'], ['Us is such a creepy movie', 'Us'], ['Heat is the best heist movie ever made', 'Heat'],
  ['just beat Portal, GLaDOS is terrifying', 'Portal'], ['Dune is one of the best films ever', 'Dune'], ['Portal harika bir oyun', 'Portal'],
  ['The ending of Portal blew my mind', 'Portal'], ['Frozen is my daughter\'s favourite movie', 'Frozen']]) assert.ok(labels(t).includes(l), `${t} -> ${labels(t)}`);
  for (const t of ['Turkey is a great place to shoot a movie', 'Switch 2 sales are huge', 'My Switch broke again', 'Palestine will be free',
  'Reading Proverbs this morning', 'It was a great movie']) assert.deepEqual(labels(t), [], t);
});

const M = '\u0001';
// the user's phone cases: own text + U+0001 + OCR text; [text, labels expected in order, seen titles (regex)]
const PHONE = [
  ['I Let an AI Teach Another AI for 5 Generations' + M + 'AI COPYING AI 5 GENERATIONS LATER\nGEN 0\nGEN 5', []],
  ['Süzülerek\nGazapizm35' + M + 'ARGO', []],
  ["What if we didn't allow bugs?" + M + '6\'4" 6\'2" 6\'0" 5\'10" 5\'8" 5\'6"\nBugs are\nILLEGAL', []],
  ['[World Record] NEW SKIP! Speedrun Resident evil 4 Remake any% Standa' + M + 'NEW SKIP\nWR\nFASTER THAN THE NG+\nANY STANDARD NO INTRO\n01:22:38', []],
  ['[World Record] NEW SKIP! Speedrun Resident evil 4 Remake any% Standa' + M + 'NEW SKIP\nWR\nFASTER THAN THE NG+\nANY STANDARD NO INTRO\n01:22:38', [], 'Resident Evil'],
  ["If you are a fan of Assassin's Creed, and want to see the games and future conten\nThe Hidden One", [], "Assassin's Creed"],
  ['25 - Resident Evil Village Soundtrack - Yearning For Dark Shadows' + M + 'VILLAGE\nRESIDENT EVIL', [], 'Resident Evil'],
  ['Eurovision Song Contest 2026 results are in, what a night', []],
  ['TÜRKİYE SİNEMASI DEĞİL, TÜRK SİNEMASI YAPALIM | KES #4\nFilmler ve Filmler' + M + 'SEN TÜRK DEĞİLSİN', []],
  ["Grace Ashcroft's Voice Actress Reacts to Thirst Comments\nPARTYCHAT", []],
  ['#39 - Halo Serisi' + M + 'HALO\nTHE MASTER CHIEF COLLECTION\nHALO: REACH\nHALO: COMBAT EVOLVED ANNIVERSARY\nHALO 2: ANNIVERSARY\nHALO 3', ['Halo']],
  ['#59 - Battlefield Serisi 2' + M + 'BATTLEFIELD 3\nBATTLEFIELD 4\nBATTLEFIELD HARDLINE\nBATTLEFIELD 1\nBATTLEFIELD V\nBATTLEFIELD 2042', ['Battlefield']],
  ['Video title' + M + 'RESIDENT EVIL REFERENCES', ['Resident Evil']],
  ['reaction' + M + 'THE LAST OF US PART II ENDING', ['The Last of Us Part II']],
  ['clip' + M + 'BREAKING BAD', ['Breaking Bad']],
  ['clip' + M + 'Elden Ring', ['Elden Ring']],
  ['you need to see this' + M + 'BATTLEFIELD 4', ['Battlefield 4']],
  ['Lost season 6 was a mess', ['Lost']],
  ['Watching 10.5 on TV tonight, a disaster miniseries', ['10.5']],
  ['The height chart said 10.5 feet', []],
  // YouTube titles (Headline Case, ALL CAPS): distinctive single words of popular works are titles however written
  ['Minecraft Speedrunning: A Brief History', ['Minecraft']],
  ['Arcane Is A Masterpiece', ['Arcane']],
  ['Interstellar Docking Scene Reaction', ['Interstellar']],
  ['MINECRAFT BUT EVERYTHING IS LAVA', ['Minecraft']],
  ['Skyrim Is Better Than You Remember', ['The Elder Scrolls V: Skyrim']],
  ['Oppenheimer Review', ['Oppenheimer']],
  ['Midsommar Is A Masterpiece', ['Midsommar']],
  ['Why Lost Failed', []],
  ['Chernobyl Is Terrifying', []],
  ['Nintendo Switch 2 Review', []],
  ['Telefon incelemesi: 6 ay sonra', []],
  ['x' + M + 'MINECRAFT', []],
  ['x' + M + 'OPPENHEIMER REVIEW', []],
];
test('phone cases: text read from pictures, all caps, headline case, seen names, label order', { skip: !has && 'no data/catalog.json' }, () => {
  for (const [text, want, seen] of PHONE) {
    const re = seen && new RegExp(seen), seenW = new Set(built.meta.titles.map((t, i) => (re && re.test(t) ? i : -1)).filter((i) => i >= 0));
    const got = m.evaluate(text, (g) => built.meta.groups[g].slice(1).every((w) => seenW.has(w))).map((g) => built.meta.groups[g][0]);
    if (want.length) assert.deepEqual(got.slice(0, want.length), want, text); // the label first
    else assert.deepEqual(got, [], text);
  }
});
