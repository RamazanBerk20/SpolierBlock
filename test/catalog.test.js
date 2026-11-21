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
    'Harry Potter': ['Harry Potter'],
    'The Lord of the Rings': ['The Lord of the Rings'],
    'The Witcher': ['The Witcher'],
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
  // a lowercase "evil" with a game word near it: Resident Evil 4 (rule for lowercase typing, after 0.2.3)
  ['[World Record] NEW SKIP! Speedrun Resident evil 4 Remake any% Standa' + M + 'NEW SKIP\nWR\nFASTER THAN THE NG+\nANY STANDARD NO INTRO\n01:22:38', ['Resident Evil 4']],
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
  // 0.2.3 phone cases: a bare name is the closest works; a type word narrows; a line's media word; music titles
  ['Minecraft Easy Survival Base....🤔', [], '^Minecraft$'],
  ['Minecraft Easy Survival Base....🤔', ['Minecraft']],
  ['the Minecraft movie was fun', ['A Minecraft Movie']],
  ['Is it Possible to Beat Half Life without Standing?' + M + 'HALF LIFE\nSTANDINGLESS%!!!!!', [], '^Half-Life$|^Half-Life 2'],
  ['Is it Possible to Beat Half Life without Standing?' + M + 'HALF LIFE\nSTANDINGLESS%!!!!!', ['Half-Life']],
  ["Assassin's Creed oyunu çok iyi", ["Assassin's Creed"]],
  ['DmC: Devil May Cry - All Boss Fights & Ending (No Damage - Dante Must' + M + 'ALL BOSSES', ['DmC: Devil May Cry']],
  ['Joker ft. Defkhan, Kurşun - Son Kale | official video\nJoker Resmi' + M + 'son kale (ft. Defkhan, Kurşun) official video', []],
  ['Watching Cars For The First Time', ['The First Time', 'Cars']],
];
test('phone cases: text read from pictures, all caps, headline case, seen names, label order', { skip: !has && 'no data/catalog.json' }, () => {
  for (const [text, want, seen] of PHONE) {
    const re = seen && new RegExp(seen), seenW = new Set(built.meta.titles.map((t, i) => (re && re.test(t) ? i : -1)).filter((i) => i >= 0));
    const got = m.evaluate(text, (g) => built.meta.groups[g].slice(1).every((w) => seenW.has(w))).map((g) => built.meta.groups[g][0]);
    if (want.length) assert.deepEqual(got.slice(0, want.length), want, text); // the label first
    else assert.deepEqual(got, [], text);
  }
});

test('a bare franchise name refers to its closest works; a type word narrows the group', { skip: !has && 'no data/catalog.json' }, () => {
  // reviewed by hand: test/fixtures/franchises.json (title|type|year of each work the bare name refers to)
  const want = JSON.parse(fs.readFileSync(new URL('./fixtures/franchises.json', import.meta.url), 'utf8'));
  const members = (t) => { const g = m.evaluate(t)[0]; return g === undefined ? null : built.meta.groups[g].slice(1)
    .map((w) => `${built.meta.titles[w]}|${built.meta.types[w]}|${built.meta.years[w]}`).sort(); };
  for (const [name, works] of Object.entries(want)) assert.deepEqual(members(`${name} is great, the whole ${name} franchise`), works, name);
  assert.deepEqual(members("Assassin's Creed game is great"), ["Assassin's Creed|game|2007"]);
  assert.deepEqual(members("the Assassin's Creed film was bad"), ["Assassin's Creed|movie|2016"]);
  assert.deepEqual(members('the Minecraft movie was fun'), ['A Minecraft Movie|movie|2025']);
  assert.deepEqual(members('Dune book club tonight'), ['Dune|book|0', 'Dune|book|1965']);
});

test('"More from this series": a late entry lists the rest of its franchise, oldest first', { skip: !has && 'no data/catalog.json' }, () => {
  // test/fixtures/series.json: every catalog work titled with the franchise's name (42, 13 and 9 works)
  const want = JSON.parse(fs.readFileSync(new URL('./fixtures/series.json', import.meta.url), 'utf8'));
  const row = (w) => `${built.meta.titles[w]}|${built.meta.types[w]}|${built.meta.years[w]}`;
  for (const [name, late, text] of [['Resident Evil', 'Resident Evil Requiem', 'Resident Evil Requiem ending'],
    ['Silent Hill', 'Silent Hill f', 'Silent Hill f ending'], ['God of War', 'God of War Ragnarök', 'God of War Ragnarök ending']]) {
    const gs = m.evaluate(text);
    assert.deepEqual(gs.map((g) => built.meta.groups[g][0]), [late], text);
    const own = built.meta.groups[gs[0]].slice(1), more = m.moreFromSeries(gs);
    const all = new Set([...own, ...more].map(row));
    for (const r of want[name]) assert.ok(all.has(r), `${name}: ${r} missing`);
    assert.ok(!more.some((w) => own.includes(w)), 'the first section is not repeated');
    const ys = more.map((w) => built.meta.years[w] || 1e4);
    assert.deepEqual(ys, [...ys].sort((a, b) => a - b), 'oldest first');
  }
  // the bare franchise name: its works first, the rest of the series below (films, games, anime and shows together)
  const gs = m.evaluate('Resident Evil ending'), own = built.meta.groups[gs[0]].slice(1);
  assert.equal(new Set([...own, ...m.moreFromSeries(gs)].map(row).filter((r) => r.includes('Resident Evil'))).size, want['Resident Evil'].length);
  assert.deepEqual(m.moreFromSeries(m.evaluate('Breaking Bad finale')).map(row), ['Better Call Saul|tv|2015', 'El Camino: A Breaking Bad Movie|movie|2019']);
  assert.deepEqual(m.moreFromSeries(m.evaluate('Inception ending')), []); // in no series: nothing more
});

test('plain sentences name the best-known works and franchises (top 300 names of 2+ words)', { skip: !has && 'no data/catalog.json' }, () => {
  for (const [text, label] of [['Resident Evil is scary', 'Resident Evil'], ['The new Resident Evil looks great', 'Resident Evil'],
    ['I love Resident Evil', 'Resident Evil'], ['Dark Souls is hard', 'Dark Souls'], ['God of War is great', 'God of War'],
    ['Silent Hill is terrifying', 'Silent Hill'], ['Breaking Bad is overrated', 'Breaking Bad'], ['Star Wars is overrated', 'Star Wars']]) {
    assert.deepEqual(m.evaluate(text).map((g) => built.meta.groups[g][0]), [label], text);
  }
  // test/fixtures/top-names.json: the 300 titles of two words or more with the most sitelinks, counting the works of
  // the catalog series of that name (2026-11-19). Each, in four plain sentences, must find a work of that title.
  // Known misses (46 of 1200; 367 before names took their franchise's fame, 76 before Title-Case names of 3+ words), and why:
  const known = new Set([
    // a catalog entry for a list or a series item: nobody writes the name; the short name matches instead
    'Foundation series', 'Oz book series', 'Platonic dialogue', 'Spider-Man in film', 'Mortal Engines Quartet', 'The Inheritance Cycle',
    'Space Odyssey', 'The Human Comedy',
    // "The" and one word stays everyday English ("THE FALL OF CONSTANTINOPLE"): needs a media word
    'The Ring', 'The Thing', 'The Flash', 'The Transporter', 'The Office',
    // everyday words, no work at COMMON_POP and no numbered or subtitled entries of that name: needs a media word
    '28 Days Later', 'Dirty Harry', 'Friday the 13th', 'Gone with the Wind', 'Ip Man', 'Johnny English', "JoJo's Bizarre Adventure",
    'Knives Out', 'Mario & Sonic at the Olympic Games', 'Medal of Honor', 'Metal Gear', 'Power Rangers', 'Pretty Cure', 'Super Smash Bros.',
    'The Land Before Time', 'The Wolf Man',
  ]);
  const names = JSON.parse(fs.readFileSync(new URL('./fixtures/top-names.json', import.meta.url), 'utf8'));
  let misses = 0;
  for (const n of names) for (const t of ['{X} is great', 'I finally finished {X}', 'the ending of {X} surprised me', 'honestly {X} is great']) {
    const text = t.replace('{X}', n);
    const ok = m.evaluate(text).some((g) => built.meta.groups[g].slice(1).some((w) => built.meta.titles[w].toLowerCase() === n.toLowerCase()));
    if (!ok) { misses++; assert.ok(known.has(n), `no match: ${text}`); }
  }
  assert.ok(misses <= 46, `${misses} misses`);
});

test('rows the Android Scanner passed on YouTube search results (0.2.2 logs): labels as reviewed',{ skip: !has && 'no data/catalog.json' }, () => {
  const rows = fs.readFileSync(new URL('./fixtures/yt-rows.jsonl', import.meta.url), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  for (const r of rows) assert.deepEqual(m.evaluate(r.text).map((g) => built.meta.groups[g][0]), r.expect, r.text.slice(0, 80));
});

test('real X and Reddit pages: franchise inside a longer name, lowercase typing, handles, "No spoilers"', { skip: !has && 'no data/catalog.json' }, () => {
  const labels = (t) => m.evaluate(t).map((g) => built.meta.groups[g][0]);
  for (const [text, label] of [
    // a weak longer name holding a strong franchise name is vouched for by it
    ["I used to stab people on Assassin's Creed Brotherhood", "Assassin's Creed: Brotherhood"],
    ['co działo się po premierze Assassin’s Creed Unity.', "Assassin's Creed Unity"],
    ["¡Assassin's Creed: Odyssey está disponible", "Assassin's Creed Odyssey"],
    ['time to enter feudal Japan with Assassin’s Creed Shadows! Join me', "Assassin's Creed Shadows"],
    // lowercase typing: a media word near it, "is the best game", a consumption verb before it
    ['day 3 of playing resident evil 4', 'Resident Evil 4'], ['Replaying all the resident evil games', 'Resident Evil'],
    ['i finally finished breaking bad and the ending destroyed me', 'Breaking Bad'], ['just finished the last of us part 2', 'The Last of Us Part II'],
    ['elden ring is the best game ever', 'Elden Ring'], ['arcane season 2 was great', 'Arcane'], ['playing minecraft', 'Minecraft'],
  ]) assert.deepEqual(labels(text), [label], text);
  for (const text of ['the boys were watching tv all night', 'stranger things have happened in this game', 'Is this a resident evil oc',
    'bro assassin\'s creed had that', // no media word: an accepted miss
    // handles and names glued by "_" are not text
    'u/Altruistic_Mud_8425', 'Posted by @Mud_Lover99 about movies', 'u/Wonder-Lad-2Mad movie review',
    'Altruistic_Mud_8425 movie', 'Jane Doe@Mud_Lover·3s that movie',
    // a determiner takes nothing from the media word right after it
    'No spoilers please!', '8 No Spoilers', 'No spoilers, but the ending was great.']) assert.deepEqual(labels(text), [], text);
  assert.deepEqual(labels('Watching Mud tonight, great movie'), ['Mud']); // the same name outside a handle still counts
  // a media word inside a handle is no evidence either (Reddit's user-flair line); a real one still is
  assert.deepEqual(labels('u/Comic_Book_Reader r/movies Veteran • 20 hr. ago'), []);
  assert.deepEqual(labels('Watched the movie Veteran last night'), ['Veteran']);
  assert.deepEqual(labels('Watched the film No last night'), ['No']); // a media word before it still counts
});

test('acronyms in capitals, a lowercase entry of a series, names of short words', { skip: !has && 'no data/catalog.json' }, () => {
  const labels = (t) => m.evaluate(t).map((g) => built.meta.groups[g][0]);
  for (const [text, label] of [
    // an everyday word written in capitals as an alias ("GTA", "GOT"): an acronym, with a media word near it
    ['GTA is the best game series', 'Grand Theft Auto'], ['Playing GTA all night', 'Grand Theft Auto'],
    ['Ee oynayanlar nasıl buldunuz GTA’yı', 'Grand Theft Auto'], ['I watched GOT last night', 'Game of Thrones'],
    // a lowercase everyday name of 3+ words holding a name of the same catalog series
    ['dune part two was a great movie', 'Dune: Part Two'], ['just finished the last of us part 2', 'The Last of Us Part II'],
    // a name of short words takes a media word right next to it, or its year
    ['the film Q & A', 'Q & A'], ['Q&A (1990)', 'Q & A'],
  ]) assert.deepEqual(labels(text), [label], text);
  for (const text of ['I GOT THE GAME YESTERDAY', 'got the game yesterday', 'I got it', 'GTA', 'gta is the best game series',
    'the whole nine yards was a great movie', 'smiley face',
    'Want to promote your film via community AMA/Q&A? Message the mods to set one up!']) assert.deepEqual(labels(text), [], text);
  // an acronym names what its work's title names: "GTA" is the franchise group of "Grand Theft Auto"
  const gta5 = built.meta.titles.indexOf('Grand Theft Auto V');
  assert.ok(m.evaluate('GTA is the best game series').some((g) => built.meta.groups[g].includes(gta5, 1)));
  assert.deepEqual(m.evaluate('GTA is the best game series'), m.evaluate('Grand Theft Auto is the best game series'));
});

test('Title-Case names, subtitles, songs, companies, sport, pairs of names, Turkish suffixes, the next sentence', { skip: !has && 'no data/catalog.json' }, () => {
  const labels = (t) => m.evaluate(t).map((g) => built.meta.groups[g][0]);
  for (const [text, label] of [
    // a Title-Case name of 3+ words, or of 2 before a possessive or a copula
    ["Horizon Zero Dawn's first Thunderjaw fight made me yell", 'Horizon Zero Dawn'], ['Your Lie in April made me cry on the train', 'Your Lie in April'],
    ['Fall Guys is silly joy', 'Fall Guys'], ["Tears of the Kingdom's Ultrahand lets people build", 'The Legend of Zelda: Tears of the Kingdom'],
    ['Love, Death & Robots is the best show in years', 'Love, Death & Robots'], ['Gone with the Wind is great', 'Gone with the Wind'],
    // a possessive reaches one word further; a sentence that says what it is beats the line's other name
    ["Succession's final season was bleak", 'Succession'], ['Coco is a gorgeous film about family. "Remember Me" at the end.', 'Coco'],
    // a Turkish suffix marks a proper name; Portuguese consumption verbs
    ["Succession'ı baştan sona bitirdim", 'Succession'], ['Terminei Succession e não consigo parar', 'Succession'], ['Zerei Control no PS5', 'Control'],
    // a name that is no everyday word, starting its sentence, takes a media word of the next one
    ['Deltarune chapter 2 had me grinning. Toby Fox gave us the best boss fight of the year.', 'Deltarune'],
    // a subtitle names its work, with a media word near it
    ['playing Napoleonic Wars this week', 'Cossacks II: Napoleonic Wars'],
  ]) assert.ok(labels(text).includes(label), `${text} -> ${labels(text)}`);
  for (const text of [
    // inside a longer name or a list of names; a subtitle alone
    'The Royal Air Force\'s flights', 'the Department of Parks and Recreation is open', 'the Old and New Worlds',
    'Then he wrote On the Origin of Species.', 'Chinese people in New York City ran laundries.',
    // songs in quotes next to music words; music words make weak names need a media word right next to them
    'If you only know "Hound Dog" and "Jailhouse Rock," go listen to his gospel albums.', 'She sings "Respect" like she owns it.',
    'Dylan made the best breakup album ever. "Simple Twist of Fate" is perfect.', 'a punk gig in a converted garage in Bushwick, a scene',
    // a company, a sport's season, a pair of names in capitals, a compound with "scene"
    'Roblox stock jumped after earnings.', 'Le jeu collectif au Groupama Stadium est enfin reparti. Belle saison en vue pour Lyon.',
    'KHONTKAR & JOKER YAYINI GENİŞ ÖZET', 'Music scene in Lagos is incredible right now.',
    // an acronym nobody writes for its work
    'BIOS update failed again', 'PRO tips for beginners',
  ]) assert.deepEqual(labels(text), [], text);
});

test('unsure names on the real catalog (asked to the title-in-context model)', { skip: !has && 'no data/catalog.json' }, () => {
  const unsure = (text, seen = new Set()) => m.unsure(text, (g) => built.meta.groups[g].slice(1).every((w) => seen.has(w)))
    .map((x) => [built.meta.groups[x.g][0], text.slice(x.s, x.e)]);
  const labelsOf = (text) => m.evaluate(text).map((g) => built.meta.groups[g][0]);
  assert.deepEqual(unsure('heat still has the best shootout ever put on screen'), [['Heat', 'heat']]);
  assert.deepEqual(unsure('lost was peak tv until the last two seasons'), [['Lost', 'lost']]);
  // "lost" is no top-1000 word and Lost is popular: asked, and the model says no
  assert.deepEqual(unsure('i lost my keys again'), [['Lost', 'lost']]);
  assert.ok(!unsure('it was dark inside').some(([, w]) => w === 'it'));
  assert.deepEqual([...labelsOf('Split Is A Masterpiece'), ...unsure('Split Is A Masterpiece').map(([l]) => l)], ['Split']);
  assert.deepEqual(unsure('u/Altruistic_Mud_8425'), []);
  // a seen group is not asked
  const lost = m.unsure('lost was peak tv')[0].g;
  assert.deepEqual(unsure('lost was peak tv', new Set(built.meta.groups[lost].slice(1))), []);
  // the names inside an accepted name are not asked ("Dune" in "Dune: Part Two")
  assert.deepEqual(labelsOf('Dune: Part Two had the best sound design'), ['Dune: Part Two']);
  assert.deepEqual(unsure('Dune: Part Two had the best sound design'), []);
  // ordinary everyday words naming a less popular work are not asked
  for (const t of ['the species of animals in the forest', 'it was bad near the airport, the police said']) assert.deepEqual(unsure(t), [], t);
});

test('unsure names on the real catalog: other flag, songs, non-ASCII posts', { skip: !has && 'no data/catalog.json' }, () => {
  const full = (text) => m.unsure(text).map((x) => [built.meta.groups[x.g][0], text.slice(x.s, x.e), x.o]);
  assert.deepEqual(full('Siberia is cold this year'), [['Siberia', 'Siberia', 1]]);
  assert.deepEqual(full('She sings "Respect" like she owns it.'), []);
  assert.deepEqual(full('Joker ft. Defkhan - Son Kale | official video'), []);
  assert.deepEqual(full('heat dalgası çok kötü'), []); // Turkish "heat wave" typed in lowercase
  assert.deepEqual(full('heat bom demais, ótimo filme'), []);
  assert.deepEqual(full('road trip çok güzeldi'), []); // no English function word: not asked (the model is English-only)
});
