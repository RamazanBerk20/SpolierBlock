// Trains the "spoiler" mode classifier: all-MiniLM-L6-v2 fine-tuned end to end (mean pooling + linear head, one logit),
// exported as int8 ONNX to models/spoiler/ (shipped as-is by tools/build.mjs; the build never retrains).
// This script assembles the training items; tools/spoiler-train/finetune.py trains, picks the threshold and exports.
//
// Training data (nothing here is taken from test/fixtures/spoiler-eval.jsonl or test/rdr2-probe.mjs):
//  - test/fixtures/spoiler-train.json: hand-written sentences (original set)
//  - tools/spoiler-train/patterns.mjs: hand-written generic patterns (implied outcomes + hard negatives), filled
//    with titles/characters from the catalog
//  - tools/spoiler-train/extra.mjs: hand-written implied spoilers, media talk and look-alike non-spoilers (death and
//    betrayal words about real life, players and viewers; premises; production and fan talk)
//  - English Wikipedia articles of the 300 most popular films, series, games and anime (CC BY-SA 4.0): late plot
//    sentences as spoilers, the premise and production/reception sentences as non-spoilers (build/spoiler-data/wiki/)
//  - bobotran/spoiler-matching, filtering/handlabeled (CC BY-SA 3.0, Reddit episode-discussion comments hand-labelled
//    "discusses the episode's events" vs "irrelevant"), downloaded into build/spoiler-data/ at train time
// Validation: patterns are split BY PATTERN (a validation pattern's fills are never seen in training), the other
// sources by item. The threshold is chosen on validation only.
// usage: PYTHON=<python with torch, transformers, onnx, onnxruntime> node tools/train-spoiler.mjs [outDir=models/spoiler]
// (about 9 min on 6 CPU cores; the shipped model was trained with torch 2.15 CPU, transformers 5.23, onnx 1.23, onnxruntime 1.32)
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { IMPLIED, NEGATIVE, PLAIN_NEGATIVE } from './spoiler-train/patterns.mjs';
import { IMPLIED2, NEGATIVE2, TRICKY2 } from './spoiler-train/extra.mjs';
const out = process.argv[2] ?? 'models/spoiler';

// deterministic RNG so the build is reproducible
let seed = 12345;
const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
const pick = (a) => a[Math.floor(rnd() * a.length)];

// ---- data ----
const items = []; // { text, y, split: 'train'|'val', src }
const old = JSON.parse(fs.readFileSync('test/fixtures/spoiler-train.json', 'utf8'));
old.forEach(([text, y]) => items.push({ text, y, split: rnd() < 0.8 ? 'train' : 'val', src: 'hand' }));

const catalog = JSON.parse(fs.readFileSync(fs.existsSync('data/catalog.json') ? 'data/catalog.json' : 'test/fixtures/catalog.small.json', 'utf8'));
const withChars = catalog.works.filter((w) => w.characters?.length).slice(0, 600);
const fill = (p) => { const w = pick(withChars); return p.replaceAll('{T}', w.title).replaceAll('{C}', pick(w.characters)); };
const FILLS = 12;
const addPatterns = (pats, y, fills = FILLS) => pats.forEach((p) => {
  const split = rnd() < 0.8 ? 'train' : 'val';
  for (let i = 0; i < fills; i++) items.push({ text: fill(p), y, split, src: 'pattern' });
});
addPatterns(IMPLIED, 1);
addPatterns(NEGATIVE, 0);
addPatterns(PLAIN_NEGATIVE, 0);
// mostly without placeholders, so fewer (identical) copies
addPatterns(IMPLIED2, 1, 4);
addPatterns(NEGATIVE2, 0, 4);
addPatterns(TRICKY2, 0, 4);

async function smFile(name) {
  const p = `build/spoiler-data/sm_${name}.csv`;
  if (!fs.existsSync(p)) {
    fs.mkdirSync('build/spoiler-data', { recursive: true });
    const r = await fetch(`https://huggingface.co/datasets/bobotran/spoiler-matching/resolve/main/filtering/handlabeled/${name}.csv`);
    if (!r.ok) throw new Error(`spoiler-matching ${name}: ${r.status}`);
    fs.writeFileSync(p, await r.text());
  }
  return fs.readFileSync(p, 'utf8');
}
function parseCsv(text) { // minimal RFC 4180 reader
  const rows = []; let row = [], f = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c; }
    else if (c === '"') q = true;
    else if (c === ',') { row.push(f); f = ''; }
    else if (c === '\n') { row.push(f); rows.push(row); row = []; f = ''; }
    else if (c !== '\r') f += c;
  }
  if (f || row.length) { row.push(f); rows.push(row); }
  return rows;
}
const USE_REDDIT = process.env.SB_NO_REDDIT ? false : true; // ablation switch, compared on validation
for (const [name, split] of USE_REDDIT ? [['train', 'train'], ['dev', 'val']] : []) {
  for (const [lab, text] of parseCsv(await smFile(name))) {
    // short comments only: the runtime classifies sentence by sentence
    if (!text || text.length < 15 || text.length > 220 || !/^[01]$/.test(lab)) continue;
    items.push({ text, y: lab === '0' ? 1 : 0, split, src: 'reddit' }); // 0 = discusses the episode's events
  }
}
// English Wikipedia articles of the most popular films, series and games (CC BY-SA 4.0), downloaded into
// build/spoiler-data/wiki/: the last half of the plot section is spoilers, its first quarter (the premise) and the
// production, release and reception sections are not. Split into train/val by work.
const WIKI_WORKS = process.env.SB_NO_WIKI ? 0 : 300; // ablation switch
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function cached(file, url) {
  const p = `build/spoiler-data/wiki/${file}`;
  if (fs.existsSync(p)) return JSON.parse(fs.readFileSync(p, 'utf8'));
  fs.mkdirSync('build/spoiler-data/wiki', { recursive: true });
  for (let i = 1; ; i++) {
    const r = await fetch(url, { headers: { 'user-agent': 'spolierblock-train/1.0 (local training)' } }).catch(() => null);
    if (r?.ok) { const j = await r.json(); fs.writeFileSync(p, JSON.stringify(j)); await sleep(500); return j; }
    if (i === 8) throw new Error(`wikipedia ${url}: ${r?.status ?? "no answer"}`);
    await sleep(5000 * i);
  }
}
const sentencesOf = (t) => t.replace(/\s+/g, ' ').split(/(?<=[.!?])\s+(?=[A-Z"“])/).filter((s) => s.length >= 30 && s.length <= 220);
const NOT_PLOT = /^(production|development|filming|casting|release|reception|critical|box office|accolades|marketing|music|soundtrack|legacy|sales|awards|broadcast|ratings|home media|design|technical)/i;
const wikiWorks = catalog.works.filter((w) => ['movie', 'tv', 'game', 'anime'].includes(w.type)).slice(0, WIKI_WORKS);
for (let i = 0; i < wikiWorks.length; i += 50) {
  const b = wikiWorks.slice(i, i + 50);
  const j = await cached(`links-${i}.json`, `https://www.wikidata.org/w/api.php?action=wbgetentities&props=sitelinks&sitefilter=enwiki&format=json&ids=${b.map((w) => w.id).join('|')}`);
  for (const w of b) w.enwiki = j.entities?.[w.id]?.sitelinks?.enwiki?.title;
}
for (const w of wikiWorks.filter((x) => x.enwiki)) {
  const j = await cached(`${w.id}.json`, `https://en.wikipedia.org/w/api.php?action=query&prop=extracts&explaintext=1&redirects=1&format=json&titles=${encodeURIComponent(w.enwiki)}`);
  const text = Object.values(j.query?.pages ?? {})[0]?.extract ?? '';
  const split = rnd() < 0.8 ? 'train' : 'val';
  const add = (s, y, n) => s.slice(0, n).forEach((t) => items.push({ text: t, y, split, src: 'wiki' }));
  let talk = 8; // at most 8 production/reception sentences per work, 2 per section
  for (const sec of text.split(/\n==+ /).slice(1)) {
    const head = sec.slice(0, sec.indexOf(' ==')), body = sentencesOf(sec.slice(sec.indexOf('\n') + 1));
    if (/^(plot|synopsis|story|summary)/i.test(head)) {
      add(body.slice(0, Math.floor(body.length / 4)), 0, 3);
      add(body.slice(Math.ceil(body.length / 2)).reverse(), 1, 8);
    } else if (NOT_PLOT.test(head) && talk > 0) { add(body, 0, Math.min(2, talk)); talk -= 2; }
  }
}
const count = (f) => items.filter(f).length;
console.log(`items: ${items.length} (train ${count((x) => x.split === 'train')}, val ${count((x) => x.split === 'val')}); ` +
  `hand ${count((x) => x.src === 'hand')}, pattern ${count((x) => x.src === 'pattern')}, reddit ${count((x) => x.src === 'reddit')}, wiki ${count((x) => x.src === 'wiki')}; positives ${count((x) => x.y)}`);
fs.mkdirSync('build', { recursive: true });
fs.writeFileSync('build/spoiler-train-items.jsonl', items.map((x) => JSON.stringify(x)).join('\n'));
execFileSync(process.env.PYTHON ?? 'python3', ['-I', 'tools/spoiler-train/finetune.py', 'build/spoiler-train-items.jsonl', out], { stdio: 'inherit' });
