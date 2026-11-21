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
    const isSeen = (g) => meta.groups[g].slice(1).every((w) => s.has(w));
    const gs = m.evaluate(text, isSeen), labels = gs.map((g) => meta.groups[g][0]);
    // more: "More from this series" (work indices); unsure: the names the matcher is unsure about, [group, start, end, other]
    v.push({ text, seen, expect: labels, more: m.moreFromSeries(gs), unsure: m.unsure(text, isSeen).map((x) => [x.g, x.s, x.e, x.o]) });
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
  ['omg breaking bad season 5 is insane', ['Breaking Bad']], // lowercase: a media word near it
  ['omg breaking bad news today', []],
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
  ['my favourite\nMarley and Me with a movie', []], // a line break starts a new text, as the text start does
  ['my favourite\nMarley and Me movie night', ['Marley & Me']], // a media word right next to it
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
  // names that mostly mean something else, type-fitting context, sentences, apostrophes, other languages
  ...['The Palestine debate on campus was civil.', 'Free Palestine! #Palestine', 'Watching the news, Palestine again. What a season',
    'Napoleon lost at Waterloo in 1815 and the film of my life goes on', 'Chernobyl exclusion zone hit by a drone overnight',
    'Palestine (2001) was on the reading list', 'The new Nintendo Switch costs too much',
    'Severance pay is due in March. We binged a show on the weekend.', 'Bloodborne. That was the name of the band. Great game though'].map((t) => [t, []]),
  ['I read Palestine last week', ['Palestine']],
  ['Chernobyl on HBO was harrowing', ['Chernobyl']],
  ['Ridley Scott made Napoleon into a film', ['Napoleon']],
  ['"Napoleon" was too long', []],
  ['Valery Legasov in Chernobyl', ['Chernobyl']],
  ['The Switch movie night with the kids', ['The Switch']],
  ['Bloodborne is the best game ever', ['Bloodborne']],
  ["Interstellar's docking scene is peak cinema", ['Interstellar']],
  ["Breaking Bad'i 4. kez izliyorum", ['Breaking Bad']],
  ['Severance 2. sezon finali beynimi yaktı', ['Severance']],
  ["J'ai fini Interstellar hier soir", ['Interstellar']],
  ['Die letzte Staffel von Severance war genial', ['Severance']],
];
for (const [text, expected] of cases) assert.deepEqual(F.run(text), expected, text);
const movie = idx('Dune', 'movie'), book = idx('Dune', 'book');
assert.deepEqual(F.run('Dune was amazing', [movie]), ['Dune']);
assert.deepEqual(F.run('Dune was amazing', [movie, book]), []);
// the uploader's name (contract rule 9; test/matcher.test.js): own text + U+0002 + uploader [+ U+0001 + OCR text]
for (const [t, want] of [['Look at this\u0002Minecraft', []], ['Minecraft\u0002Minecraft', []], ['Minecraft\u0002Some Channel', ['Minecraft']],
  ['Minecraft - Official Trailer\u0002Minecraft', ['Minecraft']], ['Minecraft game night\u0002Minecraft Official', ['Minecraft']],
  ['#Minecraft\u0002MinecraftVEVO', []], ['Breaking Bad\u0002Minecraft - Topic', ['Breaking Bad']], ['lost was peak tv\u0002Lost', []],
  ['lost was peak tv\u0002Some Channel', []], ['nice\u0002Dune\u0001BREAKING BAD SEASON 5', ['Breaking Bad']]]) assert.deepEqual(F.run(t), want, t);

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
  'Harry Potter': ['Harry Potter'],
  'The Lord of the Rings': ['The Lord of the Rings'],
  'The Witcher': ['The Witcher'],
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
const M = '\u0001';
// the user's phone cases: own text + U+0001 + OCR text; [text, labels expected in order, seen titles (regex)]
const PHONE = [
  ['I Let an AI Teach Another AI for 5 Generations' + M + 'AI COPYING AI 5 GENERATIONS LATER\nGEN 0\nGEN 5', []],
  ['Süzülerek\nGazapizm35' + M + 'ARGO', []],
  ["What if we didn't allow bugs?" + M + '6\'4" 6\'2" 6\'0" 5\'10" 5\'8" 5\'6"\nBugs are\nILLEGAL', []],
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
for (const [text, want, seen] of PHONE) {
  const re = seen && new RegExp(seen), seenW = dmeta.titles.map((t, i) => (re && re.test(t) ? i : -1)).filter((i) => i >= 0);
  const got = D.run(text, seenW);
  if (want.length) assert.deepEqual(got.slice(0, want.length), want, text);
  else assert.deepEqual(got, [], text);
}
// the uploader's name and music words on the real catalog (test/matcher.test.js): a rapper called Joker is not the film;
// every case also carries its unsure names
for (const t of ['Joker - Element (Official Video)', 'Joker - Mikrofon Şov', 'Element - Joker', 'Joker & Allame - Rapstar', 'JOKER - ŞİFA',
  'Joker yeni albüm çıkardı', 'Joker freestyle']) {
  for (const up of ['Joker', 'Joker Official', 'JokerVEVO', 'Joker - Topic', 'joker müzik']) assert.deepEqual(D.run(`${t}\u0002${up}`), [], `${t} / ${up}`);
  D.run(t);
}
for (const t of ['Joker - Mikrofon Şov', 'Element - Joker', 'Joker & Allame - Rapstar', 'JOKER - ŞİFA']) assert.deepEqual(D.run(t), ['Joker'], t);
for (const t of ['Joker review', 'Joker (2019) ending explained', 'Joker is the best movie', 'Joker trailer reaction']) assert.deepEqual(D.run(`${t}\u0002Joker`), ['Joker'], t);
assert.deepEqual(D.run('Minecraft - Official Trailer\u0002Minecraft'), ['Minecraft']);
assert.deepEqual(D.run('Joker soundtrack album, haunting'), ['Joker']);
for (const t of ['JOKER - ŞARKI', 'Joker - yeni şarkım', 'Joker remix', 'Joker diss track']) D.run(t);
// unsure names need an English function word outside the name (test/matcher.test.js)
assert.deepEqual(D.run('Gezinmeyi atla'), []);
for (const t of ['Gezinmeyi atla', 'atla is still the best show ever made', 'rewatching atla with my kids', 'lost was peak tv', 'lost peak tv',
  'Lost çok iyiydi', 'Lost was great, çok iyiydi', 'stranger things çok iyiydi', 'road trip çok güzeldi', 'lost lost lost', 'lost lost lost and lost', 'Lost peak tv', 'Halo Lore Stanley Plays', 'Doom 100% Completion Guide']) D.run(t);
// rows the Android Scanner passed on YouTube search results (test/fixtures/yt-rows.jsonl)
for (const l of fs.readFileSync(path.join(repo, 'test/fixtures/yt-rows.jsonl'), 'utf8').split('\n').filter(Boolean)) D.run(JSON.parse(l).text);
// plain sentences naming the best-known works (test/fixtures/top-names.json, see test/catalog.test.js)
for (const n of JSON.parse(fs.readFileSync(path.join(repo, 'test/fixtures/top-names.json'), 'utf8'))) {
  for (const t of ['{X} is great', 'I finally finished {X}', 'the ending of {X} surprised me', 'honestly {X} is great']) D.run(t.replace('{X}', n));
}
// "<name> is a ... game", "beat <name>" (test/catalog.test.js)
for (const [t, l] of [['Portal is a perfect game', 'Portal'], ['Us is such a creepy movie', 'Us'], ['Heat is the best heist movie ever made', 'Heat'],
  ['just beat Portal, GLaDOS is terrifying', 'Portal'], ['Dune is one of the best films ever', 'Dune'], ['Portal harika bir oyun', 'Portal'],
  ['The ending of Portal blew my mind', 'Portal'], ['Frozen is my daughter\'s favourite movie', 'Frozen']]) assert.ok(D.run(t).includes(l), t);
for (const t of ['Turkey is a great place to shoot a movie', 'Switch 2 sales are huge', 'My Switch broke again', 'Palestine will be free',
  'Reading Proverbs this morning', 'It was a great movie']) assert.deepEqual(D.run(t), [], t);
// real X and Reddit pages (test/catalog.test.js): a franchise vouches for its entry, lowercase typing, handles, "No spoilers"
for (const [t, l] of [["I used to stab people on Assassin's Creed Brotherhood", "Assassin's Creed: Brotherhood"],
  ['co działo się po premierze Assassin’s Creed Unity.', "Assassin's Creed Unity"], ["¡Assassin's Creed: Odyssey está disponible", "Assassin's Creed Odyssey"],
  ['time to enter feudal Japan with Assassin’s Creed Shadows! Join me', "Assassin's Creed Shadows"],
  ['day 3 of playing resident evil 4', 'Resident Evil 4'], ['Replaying all the resident evil games', 'Resident Evil'],
  ['i finally finished breaking bad and the ending destroyed me', 'Breaking Bad'], ['just finished the last of us part 2', 'The Last of Us Part II'],
  ['elden ring is the best game ever', 'Elden Ring'], ['arcane season 2 was great', 'Arcane'], ['playing minecraft', 'Minecraft'],
  ['Watching Mud tonight, great movie', 'Mud'], ['Watched the film No last night', 'No'], ['Watched the movie Veteran last night', 'Veteran']]) assert.deepEqual(D.run(t), [l], t);
// acronyms in capitals, a lowercase entry of a series, names of short words (test/catalog.test.js)
for (const [t, l] of [['GTA is the best game series', 'Grand Theft Auto'], ['Playing GTA all night', 'Grand Theft Auto'],
  ['Ee oynayanlar nasıl buldunuz GTA’yı', 'Grand Theft Auto'], ['I watched GOT last night', 'Game of Thrones'],
  ['dune part two was a great movie', 'Dune: Part Two'], ['the film Q & A', 'Q & A'], ['Q&A (1990)', 'Q & A']]) assert.deepEqual(D.run(t), [l], t);
for (const t of ['I GOT THE GAME YESTERDAY', 'got the game yesterday', 'I got it', 'GTA', 'gta is the best game series',
  'the whole nine yards was a great movie', 'smiley face', 'Want to promote your film via community AMA/Q&A? Message the mods to set one up!']) assert.deepEqual(D.run(t), [], t);
// an acronym names what its work's title names: "GTA" is the franchise group of "Grand Theft Auto"
assert.ok(dm.evaluate('GTA is the best game series').some((g) => dmeta.groups[g].includes(dmeta.titles.indexOf('Grand Theft Auto V'), 1)));
D.run('Grand Theft Auto is the best game series');
for (const t of ['the boys were watching tv all night', 'stranger things have happened in this game', 'Is this a resident evil oc',
  "bro assassin's creed had that", 'u/Altruistic_Mud_8425', 'Posted by @Mud_Lover99 about movies',
  'u/Wonder-Lad-2Mad movie review', 'Altruistic_Mud_8425 movie', 'Jane Doe@Mud_Lover·3s that movie', 'No spoilers please!', '8 No Spoilers',
  'No spoilers, but the ending was great.', 'NO MOVIE TONIGHT', 'u/Comic_Book_Reader r/movies Veteran • 20 hr. ago', 'Veteran r/movies']) assert.deepEqual(D.run(t), [], t);
// Title-Case names, subtitles, songs, companies, sport, pairs of names, Turkish suffixes, the next sentence (test/catalog.test.js)
for (const [t, l] of [["Horizon Zero Dawn's first Thunderjaw fight made me yell", 'Horizon Zero Dawn'], ['Your Lie in April made me cry on the train', 'Your Lie in April'],
  ['Fall Guys is silly joy', 'Fall Guys'], ["Tears of the Kingdom's Ultrahand lets people build", 'The Legend of Zelda: Tears of the Kingdom'],
  ['Love, Death & Robots is the best show in years', 'Love, Death & Robots'], ['Gone with the Wind is great', 'Gone with the Wind'],
  ["Succession's final season was bleak", 'Succession'], ['Coco is a gorgeous film about family. "Remember Me" at the end.', 'Coco'],
  ["Succession'ı baştan sona bitirdim", 'Succession'], ['Terminei Succession e não consigo parar', 'Succession'], ['Zerei Control no PS5', 'Control'],
  ['Deltarune chapter 2 had me grinning. Toby Fox gave us the best boss fight of the year.', 'Deltarune'],
  ['playing Napoleonic Wars this week', 'Cossacks II: Napoleonic Wars']]) assert.ok(D.run(t).includes(l), t);
for (const t of ["The Royal Air Force's flights", 'the Department of Parks and Recreation is open', 'the Old and New Worlds',
  'Then he wrote On the Origin of Species.', 'Chinese people in New York City ran laundries.',
  'If you only know "Hound Dog" and "Jailhouse Rock," go listen to his gospel albums.', 'She sings "Respect" like she owns it.',
  'Dylan made the best breakup album ever. "Simple Twist of Fate" is perfect.', 'a punk gig in a converted garage in Bushwick, a scene',
  'Roblox stock jumped after earnings.', 'Le jeu collectif au Groupama Stadium est enfin reparti. Belle saison en vue pour Lyon.',
  'KHONTKAR & JOKER YAYINI GENİŞ ÖZET', 'Music scene in Lagos is incredible right now.', 'BIOS update failed again', 'PRO tips for beginners']) assert.deepEqual(D.run(t), [], t);
// unsure names (test/catalog.test.js), as parity inputs: every case also carries its unsure names
for (const t of ['heat still has the best shootout ever put on screen', 'lost was peak tv until the last two seasons', 'i lost my keys again',
  'it was dark inside', 'Split Is A Masterpiece', 'u/Altruistic_Mud_8425', 'Dune: Part Two had the best sound design',
  'I read Siberia in Siberia', 'She sings "Respect" like she owns it.', 'Joker ft. Defkhan - Son Kale | official video',
  'heat dalgası çok kötü', 'heat bom demais, ótimo filme', 'Heat dalgası çok kötü', 'road trip çok güzeldi']) D.run(t);
// the tuning benchmarks' posts and video titles, as parity inputs (tools/fp-posts.mjs)
for (const f of ['fp-posts', 'headlines']) for (const l of fs.readFileSync(path.join(repo, `test/fixtures/${f}.jsonl`), 'utf8').split('\n').filter(Boolean)) D.run(JSON.parse(l).text);

// ---------- seeded random corpus ----------
let seed = 0x5eed;
const rnd = () => ((seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 2 ** 32);
const pick = (a) => a[Math.floor(rnd() * a.length)];
const CTX = ['season 2', 'the finale', 'episode', 'movie', 'trailer', 'the ending', 'S02E05', 'netflix', 'book', 'game', '2. sezon', 'fragmanı', 'bölümünü', 'oyunu', 'Staffel', 'read it'];
const FILL = ['honestly', 'I think', 'my friend said', 'lol', 'today', 'again', 'the best', 'not sure', 'Wow.', 'ok so', 'Nintendo Switch', 'in 2019', 'yesterday.\n', 'No spoilers', 'u/'];
function corpus(R, catalog, meta, n) {
  const names = [];
  for (const w of catalog.works) { names.push(w.title, ...(w.aliases ?? []), ...(w.characters ?? [])); }
  const shape = (s) => [s, s.toLowerCase(), s.toUpperCase(), `"${s}"`, `#${s.replace(/[^\p{L}\p{N}]/gu, '')}`, `*${s}*`, `${s}'s`,
    `@${s.replace(/\s+/g, '_')}`, `${s}_x`][Math.floor(rnd() * 9)];
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
