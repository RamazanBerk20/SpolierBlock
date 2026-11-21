// Test vectors for the Java port of the title-in-context model (extensions/blocker/src/test/.../ContextClassifierTest.java).
// Every expected value comes from the extension's own code on the shipped dist index: the unsure names from the JS
// matcher (matcher.unsure, nothing seen), segments A and B and the pair's ids from src/shared/context-input.js with the
// transformers.js tokenizer of models/context, and the probability from onnxruntime-web (tools/context-train/classify.mjs,
// the Node mirror of engine.js context()).
// Texts: test/fixtures/fp-posts.jsonl, headlines.jsonl, context-val.jsonl (public validation files, never training
// rows), the demo feed's posts and window edge cases. Run it after the model or the index changes.
// usage (from the repo root or android/): node android/tools/context-vectors.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import '../../src/shared/build-index.js'; // globalThis.SBMatcher
import '../../src/shared/context-input.js'; // globalThis.SBContext
import { contextClassifier } from '../../tools/context-train/classify.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const out = path.join(repo, 'android/build/vectors');
fs.mkdirSync(out, { recursive: true });
const { Matcher } = globalThis.SBMatcher, { windowText, workText, pairIds } = globalThis.SBContext;
const dist = path.join(repo, 'dist/firefox/data');
const meta = JSON.parse(fs.readFileSync(path.join(dist, 'index.json'), 'utf8'));
const bin = fs.readFileSync(path.join(dist, 'index.bin'));
const m = new Matcher(bin.buffer.slice(bin.byteOffset, bin.byteOffset + bin.byteLength), meta);
const cx = await contextClassifier(path.join(repo, 'models/context'));

const texts = [];
for (const f of ['fp-posts.jsonl', 'headlines.jsonl', 'context-val.jsonl']) {
  for (const l of fs.readFileSync(path.join(repo, 'test/fixtures', f), 'utf8').split('\n')) if (l.trim()) texts.push(JSON.parse(l).text);
}
// the demo feed (android/demo MainActivity.POSTS) and window edge cases: cuts at both ends, whitespace runs, A longer than maxLength
const demo = fs.readFileSync(path.join(repo, 'android/demo/src/main/java/dev/spoilerblock/demo/MainActivity.java'), 'utf8');
for (const [, t] of demo.matchAll(/^\s*\{"((?:[^"\\]|\\.)*)", (?:true|false|null)/gm)) texts.push(JSON.parse(`"${t}"`));
const pad = (n, w) => Array.from({ length: n }, (_, i) => `${w}${i % 7}`).join(' ');
texts.push(
  `${pad(40, 'xx')} heat still has the best shootout ever put on screen ${pad(40, 'yy')}`,
  `${'z'.repeat(150)} lost was peak tv until the last two seasons ${'q'.repeat(150)}`,
  `honestly\n\n\tlost  was peak tv\r\nfor me`,
  `${pad(120, 'word')} frozen is the only thing my daughter will watch ${pad(120, 'more')}`,
  `${'supercalifragilistic '.repeat(30)}inside ruined me for a week`,
  'heat', ' heat ', 'lost', 'frozen 🙂🙂 still slaps',
  `${'!? '.repeat(40)}heat still has the best shootout ever put on screen ${'?! '.repeat(40)}`, // A over maxLength: cut from its end
  `${'!!!! '.repeat(30)}lost was peak tv until the last two seasons ${'???? '.repeat(30)}`,
  `${'.... '.repeat(30)}frozen is the only thing my daughter will watch ${'.... '.repeat(30)}`,
  `${'。 '.repeat(60)}frozen is the only thing my daughter will watch ${'、 '.repeat(60)}`,
);
// lowercase group labels in everyday templates (seeded): the rules' unsure names on many groups
let seed = 0x5eed;
const rnd = () => ((seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 2 ** 32);
const templates = ['honestly {t} was so good last night', '{t} again today, what a week', 'my sister keeps talking about {t}',
  'is {t} worth it? asking for a friend', 'we finally got to {t} after two hours', '{t}\n\nthat is all i have to say'];
for (let i = 0; i < 600; i++) {
  const label = meta.groups[Math.floor(rnd() * meta.groups.length)][0].toLowerCase();
  texts.push(templates[i % templates.length].replace('{t}', label));
}

const cases = [];
let calls = 0, withNames = 0, yes = 0;
for (const text of [...new Set(texts)]) {
  const unsure = m.unsure(text);
  if (!unsure.length && cases.length - withNames >= 100) continue; // a hundred texts with no unsure name is enough
  const pairs = [];
  for (const u of unsure) {
    const a = windowText(text, u.s, u.e), b = workText(meta, u.g), { ids, types } = cx.encode(a, b);
    const p = await cx.prob(a, b);
    calls++; yes += p >= (u.o ? cx.meta.thresholdOther ?? cx.threshold : cx.threshold);
    pairs.push({ a, b, ids, types, p });
  }
  if (unsure.length) withNames++;
  cases.push({ text, unsure: unsure.map((x) => [x.g, x.s, x.e, x.o]), pairs });
}
// classify.mjs and engine.js assemble the same pair (engine.js through SBContext.pairIds): check it here
const first = cases.find((c) => c.pairs.length).pairs[0], CLS = first.ids[0], SEP = first.ids.at(-1);
for (const c of cases) for (const p of c.pairs) {
  const { ids } = pairIds(p.ids.slice(1, p.types.indexOf(1) - 1), p.ids.slice(p.types.indexOf(1), -1), CLS, SEP, cx.meta.maxLength);
  if (ids.join() !== p.ids.join()) throw new Error(`pairIds differs for ${p.a}`);
}
fs.writeFileSync(path.join(out, 'context-cases.json'), JSON.stringify({ threshold: cx.threshold, thresholdOther: cx.meta.thresholdOther ?? cx.threshold, maxLength: cx.meta.maxLength, cases }));
console.log(`context vectors: ${cases.length} texts (${withNames} with unsure names), ${calls} pairs, ${yes} yes -> ${out}`);
