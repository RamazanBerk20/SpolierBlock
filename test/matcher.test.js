import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { buildIndex } from '../tools/build-index.mjs';
const { Matcher } = globalThis.SBMatcher;

const catalog = JSON.parse(fs.readFileSync(new URL('./fixtures/catalog.small.json', import.meta.url)));
const { bin, meta } = buildIndex(catalog);
const m = new Matcher(bin, meta);
const groupSeen = (seen) => (g) => meta.groups[g].slice(1).every((w) => seen.has(w));
const titles = (text, seen = new Set()) => m.evaluate(text, groupSeen(seen)).map((g) => meta.groups[g][0]);
const idx = (title, type) => meta.titles.findIndex((t, i) => t === title && (!type || meta.types[i] === type));

test('plain title, alias, character, case-insensitive, punctuation', () => {
  assert.deepEqual(titles('omg Breaking Bad season 5 is insane'), ['Breaking Bad']);
  assert.deepEqual(titles('omg game of thrones season 5 is insane'), ['Game of Thrones']); // popular + distinctive word: any case
  assert.deepEqual(titles('omg breaking bad season 5 is insane'), ['Breaking Bad']); // lowercase: a media word near it
  assert.deepEqual(titles('omg breaking bad news today'), []); // lowercase and no media word
  assert.deepEqual(titles('Walter White is the best'), ['Breaking Bad']);
  assert.deepEqual(titles('Pokemon and Pokémon'), ['Pokémon']);
  assert.deepEqual(titles('Pac-Man fever'), ['Pac-Man']);
  assert.deepEqual(titles('Marley and Me (2008) made me cry'), ['Marley & Me']);
  assert.deepEqual(titles('#BreakingBad finale tonight'), ['Breaking Bad']);
  assert.deepEqual(titles('Harry Potter and the Philosopher’s Stone'), ['Harry Potter']);
});

test('word boundaries: no substring matches', () => {
  assert.deepEqual(titles('Breaking Badminton records'), []);
  assert.deepEqual(titles('the matrixes of linear algebra'), []);
  assert.deepEqual(titles('breakingbad without a hashtag'), []);
});

test('clean text yields nothing', () => {
  assert.deepEqual(titles('Had a lovely walk in the park with my dog today.'), []);
});

test('ambiguous title needs corroboration', () => {
  // bare common words: never
  assert.deepEqual(titles('I lost my keys again'), []);
  assert.deepEqual(titles('It was a great movie'), []); // sentence-initial "It", context too far
  assert.deepEqual(titles('Pick me up at 5'), []);
  assert.deepEqual(titles('Lost and found office'), []);
  // a line break starts a new text: an everyday-word title opening a line is treated as at the start of a text
  assert.deepEqual(titles('my favourite\nMarley and Me with a movie'), []);
  assert.deepEqual(titles('my favourite\nMarley and Me movie night'), ['Marley & Me']); // a media word right next to it
  assert.deepEqual(titles('my friends are coming over to watch the game'), []); // lowercase
  assert.deepEqual(titles('He lost the game last season'), []); // context words but lowercase
  // corroborated
  assert.deepEqual(titles('Lost season 6 was a mess'), ['Lost']); // capitalized + adjacent context
  assert.deepEqual(titles('I watched It last night and the movie was terrifying'), ['It']); // mid-sentence + context
  assert.deepEqual(titles('#Lost rewatch thread'), ['Lost']); // hashtag
  assert.deepEqual(titles('Have you seen "Up"?'), ['Up']); // quoted
  assert.deepEqual(titles('Carl Fredricksen in Up broke me'), ['Up']); // strong character signal
  assert.deepEqual(titles('Pennywise is so creepy, It is the scariest'), ['It']); // single-token char + title
  assert.deepEqual(titles('Lost (2004) is great'), ['Lost']); // year
  assert.deepEqual(titles('The Office finale made me cry'), ['The Office']);
});

test('low-popularity names made of everyday words need Title Case and corroboration', () => {
  assert.deepEqual(titles('marley and me went for a walk'), []); // lowercase
  assert.deepEqual(titles('Marley and Me went for a walk'), []); // Title Case but nothing else about the film
  assert.deepEqual(titles('Marley and Me (2008) made me cry'), ['Marley & Me']); // year
  assert.deepEqual(titles('#MarleyAndMe made me cry'), ['Marley & Me']); // hashtag
  assert.deepEqual(titles('Breaking Bad is overrated'), ['Breaking Bad']); // popular names are unaffected
});

test('single-token character names are weak signals', () => {
  assert.deepEqual(titles('Eleven people came to the party'), []);
  assert.deepEqual(titles('Steve went to the store'), []);
  assert.deepEqual(titles('Eleven and Jim Hopper in season 4'), ['Stranger Things']);
  // parts of full names corroborate each other, but only when capitalized
  assert.deepEqual(titles('Snape kills Dumbledore at the end of the sixth book.'), ['Harry Potter']);
  assert.deepEqual(titles('a snape and a dumbledore walk into a bar'), []);
  assert.deepEqual(titles('Snape was here'), []);
});

test('shared names: the block stays until every work carrying the name is seen', () => {
  const movie = idx('Dune', 'movie'), book = idx('Dune', 'book');
  const [g] = m.evaluate('Dune was amazing');
  assert.equal(meta.groups[g][0], 'Dune');
  assert.deepEqual(meta.groups[g].slice(1).sort(), [movie, book].sort());
  assert.deepEqual(titles('Dune was amazing', new Set([movie])), ['Dune']);
  assert.deepEqual(titles('Dune was amazing', new Set([movie, book])), []);
});

test('multiple works in one block, sorted by popularity', () => {
  assert.deepEqual(titles('Star Wars vs Breaking Bad'), ['Star Wars', 'Breaking Bad']);
});

test('sequel numerals (Roman <-> Arabic) and joined short forms', () => {
  const gta6 = ['Grand Theft Auto VI'];
  for (const s of ['Grand Theft Auto VI delayed', 'grand theft auto 6 gameplay', 'GTA 6 leak', 'GTA VI trailer',
    'gta6 map leaked', '#GTA6', '#GTAVI', 'gta 6 is coming', 'Lucia dies in GTA VI', '#GrandTheftAutoVI', '#GrandTheftAuto6']) {
    assert.deepEqual(titles(s), gta6, s);
  }
  assert.deepEqual(titles('GTA V online is still popular'), ['Grand Theft Auto V']);
  assert.deepEqual(titles('Rocky 2 is underrated'), ['Rocky II']);
  assert.deepEqual(titles('Final Fantasy 7 remake looks great'), ['Final Fantasy VII']);
  assert.deepEqual(titles('TLOU2 broke me'), ['The Last of Us Part II']);
  // "I" is not a numeral and a lone numeral never becomes a name
  assert.deepEqual(titles('I think 6 is enough'), []);
});

test('names that mostly mean something else need a media word next to them', () => {
  for (const t of ['The Palestine debate on campus was civil.', 'Free Palestine! #Palestine', 'Watching the news, Palestine again. What a season',
    'Napoleon lost at Waterloo in 1815 and the film of my life goes on', 'Chernobyl exclusion zone hit by a drone overnight',
    'Palestine (2001) was on the reading list']) {
    assert.deepEqual(titles(t), [], t);
  }
  assert.deepEqual(titles('I read Palestine last week'), ['Palestine']);
  assert.deepEqual(titles('Chernobyl on HBO was harrowing'), ['Chernobyl']);
  assert.deepEqual(titles('Ridley Scott made Napoleon into a film'), ['Napoleon']);
  assert.deepEqual(titles('"Napoleon" was too long'), []); // quotes are no evidence either (a song, a book)
  assert.deepEqual(titles('Valery Legasov in Chernobyl'), ['Chernobyl']); // another name of the work
});

test('media words must fit the type of the work', () => {
  assert.deepEqual(titles('The new Nintendo Switch costs too much'), []); // a game word says nothing about a film
  assert.deepEqual(titles('The Switch movie night with the kids'), ['The Switch']);
});

test('context counts only in the same sentence', () => {
  assert.deepEqual(titles('Severance pay is due in March. We binged a show on the weekend.'), []);
  assert.deepEqual(titles('Bloodborne is the best game ever'), ['Bloodborne']); // a rare word: a media word in its sentence
  assert.deepEqual(titles('Bloodborne. That was the name of the band. Great game though'), []);
});

test('apostrophes, Turkish suffixes and other languages', () => {
  assert.deepEqual(titles("Interstellar's docking scene is peak cinema"), ['Interstellar']);
  assert.deepEqual(titles("Breaking Bad'i 4. kez izliyorum"), ['Breaking Bad']);
  assert.deepEqual(titles('Severance 2. sezon finali beynimi yaktı'), ['Severance']);
  assert.deepEqual(titles("J'ai fini Interstellar hier soir"), ['Interstellar']);
  assert.deepEqual(titles('Die letzte Staffel von Severance war genial'), ['Severance']);
});

// Names the matcher is unsure about (docs/agents/contract.md): [label, name as written]
const unsure = (text, seen = new Set()) => m.unsure(text, groupSeen(seen)).map((x) => [meta.groups[x.g][0], text.slice(x.s, x.e)]);

test('unsure names: titles the rules do not confirm, for the title-in-context model', () => {
  assert.deepEqual(titles('lost was peak tv until the last two seasons'), []);
  assert.deepEqual(unsure('lost was peak tv until the last two seasons'), [['Lost', 'lost']]);
  assert.deepEqual(unsure('Interstellar was on and lost was on too'), [['Lost', 'lost']]); // the accepted group is not asked
  assert.deepEqual(unsure('lost lost lost'), []); // the name's own words are no English function word
  assert.deepEqual(unsure('lost lost lost and lost'), [['Lost', 'lost']]); // one name per group
  assert.deepEqual(unsure('lost peak tv'), []); // no English function word
  // never: a lowercase determiner or pronoun, a top-1000 word, a handle, text read from pictures, a seen group
  assert.deepEqual(unsure('it was dark inside'), []);
  assert.deepEqual(unsure('u/Lost_Interstellar_99'), []);
  assert.deepEqual(unsure('nice pic\u0001lost dune interstellar'), []);
  assert.deepEqual(unsure('lost was peak tv', new Set([idx('Lost')])), []);
  // the names inside an accepted name are not asked
  assert.deepEqual(titles('The Last of Us Part II was a great game'), ['The Last of Us Part II']);
  assert.deepEqual(unsure('The Last of Us Part II was a great game'), []);
  // at most 4, most popular group first
  const u = m.unsure('lost, dune, friends, cars, titanic, inception, interstellar and severance all came up');
  assert.deepEqual(u.map((x) => meta.groups[x.g][0]), ['Titanic', 'Inception', 'Dune', 'Lost']);
  assert.deepEqual(u.map((x) => x.g), [...u.map((x) => x.g)].sort((a, b) => a - b));
});

test('unsure() reuses the scan of evaluate() for the same text', () => {
  const text = 'lost was peak tv', seen = () => false;
  let scans = 0;
  const scan = m.scanTokens;
  m.scanTokens = function (tk) { scans++; return scan.call(this, tk); };
  try {
    m.evaluate(text, seen);
    assert.equal(m.unsure(text, seen).length, 1);
    assert.equal(scans, 1);
    m.unsure('dune was on', seen); // another text: scanned
    assert.equal(scans, 2);
  } finally { m.scanTokens = scan; }
});

test('unsure names: the "other" flag, songs, and lowercase words in posts with non-ASCII letters', () => {
  const full = (text) => m.unsure(text).map((x) => [meta.groups[x.g][0], text.slice(x.s, x.e), x.o]);
  // o = 1: the name mostly means something else (a place); the caller asks with a stricter threshold
  assert.deepEqual(full('Chernobyl exclusion zone hit by a drone overnight'), [['Chernobyl', 'Chernobyl', 1]]);
  assert.deepEqual(full('lost was peak tv'), [['Lost', 'lost', 0]]);
  // a quoted name next to music words is a song, and a music title names no work
  assert.deepEqual(unsure('I keep listening to that album. "Interstellar" is the best song.'), []);
  assert.deepEqual(unsure('lost ft. Dune - official video'), []);
  // the context model is English-only: a lowercase single word of a post with a non-ASCII letter is not asked;
  // capitalised and multi-word names still are
  assert.deepEqual(unsure('lost was peak tv ö'), []);
  assert.deepEqual(unsure('Lost çok iyiydi'), [['Lost', 'Lost']]);
  // a name typed all in lowercase only in a post with an English function word outside the name
  assert.deepEqual(unsure('stranger things was great, çok iyiydi'), [['Stranger Things', 'stranger things']]);
  assert.deepEqual(unsure('stranger things çok iyiydi'), []);
  assert.deepEqual(unsure('Lost peak tv'), [['Lost', 'Lost']]); // a capital: not held to it
});

// The uploader's name (contract rule 9): own text + U+0002 + uploader [+ U+0001 + OCR text]
test('uploader: names no work, and the same name in the text needs media evidence', () => {
  assert.deepEqual(titles('Look at this\u0002Minecraft'), []); // the uploader part itself
  assert.deepEqual(titles('Minecraft\u0002Minecraft'), []); // a clean title from a channel named like the work: lost
  assert.deepEqual(titles('Minecraft\u0002Some Channel'), ['Minecraft']); // another uploader: today's rule
  assert.deepEqual(titles('Minecraft - Official Trailer\u0002Minecraft'), ['Minecraft']); // a media word within 3 words
  assert.deepEqual(titles('Minecraft game night\u0002Minecraft Official'), ['Minecraft']); // a type word; suffix stripped
  assert.deepEqual(titles('#Minecraft\u0002MinecraftVEVO'), []); // a hashtag is no evidence for it
  assert.deepEqual(titles('Breaking Bad\u0002Minecraft - Topic'), ['Breaking Bad']); // other names are unaffected
  // offsets stay those of the own text, and the uploader's name is never unsure
  const t = 'lost was peak tv\u0002Lost';
  assert.deepEqual(m.unsure(t).map((x) => t.slice(x.s, x.e)), []);
  assert.deepEqual(unsure('lost was peak tv\u0002Some Channel'), [['Lost', 'lost']]);
  assert.deepEqual(titles('nice\u0002Dune\u0001BREAKING BAD SEASON 5'), ['Breaking Bad']); // the OCR part still follows
});

const realFile = new URL('../data/catalog.json', import.meta.url);
test('uploader and music words on the real catalog: a rapper called Joker is not the film', { skip: !fs.existsSync(realFile) && 'no data/catalog.json' }, () => {
  const real = buildIndex(JSON.parse(fs.readFileSync(realFile, 'utf8'))), rm = new Matcher(real.bin, real.meta);
  const names = (text) => rm.evaluate(text).map((g) => real.meta.groups[g][0]);
  const unsureOf = (text) => rm.unsure(text).map((u) => real.meta.groups[u.g][0]);
  // with the channel: none of these is the film, and none is an unsure name
  for (const t of ['Joker - Element (Official Video)', 'Joker - Mikrofon Şov', 'Element - Joker', 'Joker & Allame - Rapstar', 'JOKER - ŞİFA',
    'Joker yeni albüm çıkardı', 'Joker freestyle']) {
    for (const up of ['Joker', 'Joker Official', 'JokerVEVO', 'Joker - Topic', 'joker müzik']) {
      assert.deepEqual(names(`${t}\u0002${up}`), [], `${t} / ${up}`);
      assert.deepEqual(unsureOf(`${t}\u0002${up}`), [], `${t} / ${up}`);
    }
  }
  // unsure names need an English function word outside the name: Turkish typed in ASCII ("Skip navigation") is not asked
  assert.deepEqual(unsureOf('Gezinmeyi atla'), []);
  for (const t of ['atla is still the best show ever made', 'rewatching atla with my kids']) assert.deepEqual(unsureOf(t), ['Avatar: The Last Airbender'], t);
  assert.deepEqual(unsureOf('lost was peak tv'), ['Lost']);
  // without it: music words keep the song lines off; the bare "Artist - Song" shapes still match (no uploader known)
  for (const t of ['Joker - Element (Official Video)', 'Joker yeni albüm çıkardı', 'Joker freestyle']) assert.deepEqual(names(t), [], t);
  for (const t of ['Joker - Mikrofon Şov', 'Element - Joker', 'Joker & Allame - Rapstar', 'JOKER - ŞİFA']) assert.deepEqual(names(t), ['Joker'], t);
  // media evidence still names the film from the channel Joker; an official channel's trailer still matches
  for (const t of ['Joker review', 'Joker (2019) ending explained', 'Joker is the best movie', 'Joker trailer reaction']) assert.deepEqual(names(`${t}\u0002Joker`), ['Joker'], t);
  assert.deepEqual(names('Minecraft - Official Trailer\u0002Minecraft'), ['Minecraft']);
  // music words do not turn a post about a work into a song: soundtrack and OST are media words
  assert.deepEqual(names('Joker soundtrack album, haunting'), ['Joker']);
});
