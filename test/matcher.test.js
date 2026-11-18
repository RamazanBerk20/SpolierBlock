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
  assert.deepEqual(titles('omg breaking bad season 5 is insane'), []); // all everyday words: Title Case required
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
  assert.deepEqual(titles('my favourite\nMarley and Me movie night'), []);
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
