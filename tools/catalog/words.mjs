// Builds tools/catalog/common-words.txt: the English list tools/catalog/20k.txt (most frequent first), then the most
// frequent words of film and TV subtitles in English, Turkish, Spanish, Portuguese, German, French and Italian, so a
// title that is an everyday word in one of those languages ("Kes", "Thirst") counts as one in text of any language.
// The order matters: the index rules use the first 1,000 / 3,000 / 10,000 lines, which stay the English 20k list.
// Source: hermitdave/FrequencyWords, OpenSubtitles 2018 lists, content CC BY-SA 4.0 (attribution in the README).
// Downloads once into tools/catalog/cache/. usage: node tools/catalog/words.mjs
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import '../../src/content/matcher.js';
const { normTok } = globalThis.SBMatcher;

const here = dirname(fileURLToPath(import.meta.url));
const TOP = { en: 5000, other: 5000 }; // per language: everyday words; deeper, subtitle lists fill with character names
const LANGS = ['en', 'tr', 'es', 'pt', 'de', 'fr', 'it'];
mkdirSync(join(here, 'cache'), { recursive: true });

const out = readFileSync(join(here, '20k.txt'), 'utf8').split('\n').map((w) => w.trim().toLowerCase()).filter(Boolean);
const seen = new Set(out);
for (const l of LANGS) {
  const f = join(here, 'cache', `words-${l}-50k.txt`);
  if (!existsSync(f)) {
    const r = await fetch(`https://raw.githubusercontent.com/hermitdave/FrequencyWords/master/content/2018/${l}/${l}_50k.txt`);
    if (!r.ok) throw new Error(`${l}: HTTP ${r.status}`);
    writeFileSync(f, await r.text());
  }
  let n = 0;
  for (const line of readFileSync(f, 'utf8').split('\n')) {
    if (n >= (TOP[l] ?? TOP.other)) break;
    const w = line.split(' ')[0];
    if (!w || !/^\p{L}+$/u.test(w)) continue; // words only: no numbers, no clitics
    n++;
    const t = normTok(w);
    if (t.length >= 2 && !seen.has(t)) { seen.add(t); out.push(t); }
  }
}
writeFileSync(join(here, 'common-words.txt'), out.join('\n') + '\n');
console.log('common words', out.length);
