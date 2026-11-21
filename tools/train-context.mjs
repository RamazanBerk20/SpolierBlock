// Trains the "title in context" model: given a post window and one catalog work the text matcher found a name of,
// does the name in this post mean that work (or its franchise)? all-MiniLM-L6-v2 fine-tuned as a sentence-pair
// classifier, exported as int8 ONNX to models/context/ (same layout as models/spoiler, plus meta.json with the
// threshold, the window constants and the max length). The input format lives in tools/context-train/window.mjs.
// This script assembles the pairs; tools/context-train/finetune.py trains, picks the threshold and exports.
//
// Every pair comes from a raw matcher hit (Matcher.scanTokens) in a text, labelled automatically:
//  - template fills (tools/context-train/sentences.mjs FAN*, and every {T}/{C} pattern of tools/spoiler-train/*.mjs):
//    a hit on the filled title/character whose group holds the filled work (or shares a catalog series with it) is 1;
//    a hit inside the fill that belongs to an unrelated work ("Us" in "The Last of Us") is 0; a hit on a template word is 0
//  - SLOT_NEG* fills ({T} as a song, a person, a shop...): every hit 0
//  - ordinary prose (build/corpus/: the fp-text corpus of everyday Wikipedia topics and two Gutenberg books) and the
//    EVERYDAY* posts: every hit 0
//  - Reddit episode-discussion comments (bobotran/spoiler-matching, build/spoiler-data/ and research/data/ if present),
//    English Wikipedia articles of popular works (build/spoiler-data/wiki/) and research/data/plots/plots.json: a hit of
//    the discussed work is 1, an everyday-word hit written all in lowercase is 0, other hits are left out
// Augmentation: lowercase, ALL CAPS, Headline Case, media words removed, possessive. Balanced per name (group label)
// and label. Validation holds out whole names: a name whose hash falls in the validation slice is never trained on.
// test/fixtures/fp-posts.jsonl and headlines.jsonl are never read here (tools/eval-context.mjs only).
// usage: PYTHON=<python with torch, transformers, onnx, onnxruntime> node tools/train-context.mjs [outDir=models/context]
// switches: SB_CAP (pairs per name and label, default 10), SB_FILL (popular works filled into templates, default 2500),
// SB_ITEMS (where the pairs go), SB_DATA_ONLY, SB_RETHRESHOLD, SB_SCORES (dump of the validation scores), SB_EPOCHS
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { buildIndex } from './build-index.mjs';
import { windowText, workText, WINDOW, MAX_LEN } from './context-train/window.mjs';
import { FAN, FAN_FOREIGN, SLOT_NEG, SLOT_NEG2, SLOT_NEG_FOREIGN, EVERYDAY, EVERYDAY_FOREIGN, PLAIN_START, COMPOUNDS, PHRASES,
  FOREIGN_LOWER, HEADLINE_NEG, HEADLINE_NEG2, SLOT_NEG3, SHORT_POS, HEADLINE_POS, CHANNELS } from './context-train/sentences.mjs';
import * as P1 from './spoiler-train/patterns.mjs';
import * as P2 from './spoiler-train/extra.mjs';
import * as P3 from './spoiler-train/gaps.mjs';
const { Matcher, tokenize } = globalThis.SBMatcher;
const out = process.argv[2] ?? 'models/context';
const CAP = +(process.env.SB_CAP ?? 10); // pairs per name and label, before augmentation
const VAL_PCT = 15;

let seed = 4242;
const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
const pick = (a) => a[Math.floor(rnd() * a.length)];
const shuffle = (a) => { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
const fnv = (s) => { let h = 2166136261; for (const c of s) h = Math.imul(h ^ c.codePointAt(0), 16777619) >>> 0; return h; };

const catalog = JSON.parse(fs.readFileSync('data/catalog.json', 'utf8'));
const { bin, meta } = buildIndex(catalog);
const m = new Matcher(bin, meta), shift = m.fmt >= 2 ? 9 : m.fmt >= 1 ? 8 : 7, kmask = m.fmt >= 1 ? 7 : 15;
const idx = new Map(meta.ids.map((id, i) => [id, i]));
const seriesOf = meta.ids.map(() => []);
(meta.series ?? []).forEach((l, s) => l.forEach((w) => seriesOf[w].push(s)));
// does group g hold work w or a work of one of w's series?
const related = (g, w) => meta.groups[g].some((x, i) => i > 0 && (x === w || seriesOf[x].some((s) => seriesOf[w].includes(s))));
const holds = (g, w) => meta.groups[g].includes(w, 1);
const nameOf = (g) => meta.groups[g][0].toLowerCase();
const isVal = (g) => fnv(nameOf(g)) % 100 < VAL_PCT;

function hits(text) {
  const tk = tokenize(text);
  return m.scanTokens(tk).map((h) => ({ s: tk.starts[h.i], e: tk.ends[h.i + h.n - 1], g: h.v >>> shift, kind: h.v & kmask,
    word: ((h.v >>> 5) & 1) || ((h.v >>> 4) & 1) }));
}

const raw = []; // { text, s, e, g, y, src, lang }
const add = (text, h, y, src, lang = 'en') => raw.push({ text, s: h.s, e: h.e, g: h.g, y, src, lang });

// ---- template fills ----
// fill a template; returns the text and the [s, e) spans of the filled values
function fill(tpl, w, title) {
  const spans = []; let text = '';
  const chars = catalog.works[w].characters ?? [];
  for (const part of tpl.split(/(\{[TC]\})/)) {
    if (part === '{T}' || part === '{C}') {
      const v = part === '{T}' ? title : pick(chars);
      spans.push([text.length, text.length + v.length]); text += v;
    } else text += part;
  }
  return { text, spans };
}
function labelFill(text, spans, w, positive, src, lang) {
  for (const h of hits(text)) {
    const inSlot = spans.find(([a, b]) => h.s >= a && h.e <= b);
    const cross = spans.some(([a, b]) => h.s < b && h.e > a && !(h.s >= a && h.e <= b));
    if (cross) continue;
    if (!inSlot) { add(text, h, 0, src + '-word', lang); continue; }
    const rel = related(h.g, w);
    if (!positive) { add(text, h, 0, src, lang); continue; }
    if (rel) add(text, h, 1, src, lang);
    // a shorter name inside the title that belongs to an unrelated work ("Us" in "The Last of Us"); left out when it
    // starts the title or covers most of it ("The Hobbit: An Unexpected Journey", "City of God"): there the catalog
    // series often misses the link, and the label would be wrong
    else if ((h.s > inSlot[0] || h.e < inSlot[1]) && !(h.s - inSlot[0] <= 4) && (h.e - h.s) * 2 < inSlot[1] - inSlot[0]) add(text, h, 0, src + '-inner', lang);
  }
}
// language of a sentence known to be non-English (rough: only used to report non-English figures separately)
const LANG = (t) => /[ğış]|İ|\b(bir|ve|bu|çok|için|dizi|dün|adlı|gibi|bugün|yine)\b/i.test(t) ? 'tr' : /[ñ¿¡]|\b(el|que|por|otra|vez|hoy|mi|cenamos|perdí)\b/.test(t) ? 'es' :
  /[ãõ]|\b(de novo|ontem|meu|foi|jogando|hoje|perdi|jantamos|jantar|assistindo|terminei)\b/.test(t) ? 'pt' : /[äßü]|\b(ist|ich|mich|hat|und|der|die|das|von|spiele|schaue|mein|unser|wir|heute|gestern|immer|warum)\b/.test(t) ? 'de' : 'fr';
const FOREIGN = new Set([...FAN_FOREIGN, ...SLOT_NEG_FOREIGN, ...EVERYDAY_FOREIGN, ...FOREIGN_LOWER, ...P3.FOREIGN_POS, ...P3.FOREIGN_NEG]);
const langOf = (t) => (FOREIGN.has(t) ? LANG(t) : 'en');
const pats = [P1, P2, P3].flatMap((P) => Object.values(P).flat()).filter((p) => /\{[TC]\}/.test(p));
const posT = [...FAN, ...pats.filter((p) => !FOREIGN.has(p))], posF = [...FAN_FOREIGN, ...pats.filter((p) => FOREIGN.has(p))];
// works to fill: the FILL most popular, plus every work whose title is an everyday word (the hard cases)
const word1 = (w) => { const t = catalog.works[w].title; return tokenize(t).toks.length === 1 && hits(t).some((h) => h.s === 0 && h.e === t.length && h.word); };
const order = catalog.works.map((_, i) => i).sort((a, b) => (catalog.works[b].pop ?? 0) - (catalog.works[a].pop ?? 0));
const fillWorks = [...new Set([...order.slice(0, +(process.env.SB_FILL ?? 2500)), ...order.filter(word1)])];
for (const w of fillWorks) {
  const W = catalog.works[w], hasC = W.characters?.length > 0;
  const titleFor = () => (W.aliases?.length && rnd() < 0.15 ? pick(W.aliases) : W.title);
  const pickTpl = (arr) => { for (;;) { const t = pick(arr); if (hasC || !t.includes('{C}')) return t; } };
  for (let k = 0; k < 3; k++) {
    const foreign = rnd() < 0.2, tpl = pickTpl(foreign ? posF : posT), { text, spans } = fill(tpl, w, titleFor());
    labelFill(text, spans, w, true, 'fan', langOf(tpl));
  }
  { // one short fan post with no media word, or one video title (with a channel name on the second line)
    const head = rnd() < 0.5, tpl = pickTpl(head ? HEADLINE_POS : SHORT_POS), f = fill(tpl, w, titleFor());
    labelFill(head ? `${f.text}\n${pick(CHANNELS)}` : f.text, f.spans, w, true, head ? 'headline' : 'short', 'en');
  }
  // a title as some other proper name only when that is plausible: one or two words ("Halo", "Chicago", "Coco")
  if (tokenize(W.title).toks.length <= 2) for (let k = 0; k < 2; k++) {
    const foreign = rnd() < 0.2, tpl = pick(foreign ? SLOT_NEG_FOREIGN : rnd() < 0.3 ? SLOT_NEG2 : rnd() < 0.3 ? SLOT_NEG3 : SLOT_NEG), { text, spans } = fill(tpl, w, titleFor());
    labelFill(text, spans, w, false, 'slot', langOf(tpl));
  }
}
for (const t of EVERYDAY) for (const h of hits(t)) add(t, h, 0, 'everyday');
for (const t of EVERYDAY_FOREIGN) for (const h of hits(t)) add(t, h, 0, 'everyday', langOf(t));
// second round: hand-written look-alikes (sentence-initial everyday words, compounds, phrases, foreign words, headlines)
for (const [src, list] of [['plain', PLAIN_START], ['compound', COMPOUNDS], ['phrase', PHRASES], ['foreign-lower', FOREIGN_LOWER], ['headline-neg', [...HEADLINE_NEG, ...HEADLINE_NEG2]]]) {
  for (const t of list) for (const h of hits(t)) add(t, h, 0, src, src === 'foreign-lower' ? langOf(t) : 'en');
}
// hand-written negatives are few: never capped, and every casing variant is kept
const HAND = new Set(['everyday', 'plain', 'compound', 'phrase', 'foreign-lower', 'headline-neg']);

// ---- ordinary prose ----
const sentencesOf = (t) => t.replace(/\s+/g, ' ').split(/(?<=[.!?])\s+(?=[A-Z"“])/).filter((s) => s.length >= 20 && s.length <= 300);
if (fs.existsSync('build/corpus')) {
  for (const f of fs.readdirSync('build/corpus').sort()) {
    const body = f.endsWith('.json') ? Object.values(JSON.parse(fs.readFileSync(`build/corpus/${f}`, 'utf8')).query?.pages ?? {})[0]?.extract ?? ''
      : fs.readFileSync(`build/corpus/${f}`, 'utf8');
    const ss = sentencesOf(body.replace(/\n==+[^=]+==+\n/g, '\n'));
    for (let i = 0; i < ss.length; i++) {
      const t = rnd() < 0.3 && ss[i + 1] ? `${ss[i]} ${ss[i + 1]}` : ss[i];
      for (const h of hits(t)) add(t, h, 0, 'prose');
    }
  }
} else console.log('no build/corpus (run node tools/fp-text.mjs once to download it): no prose negatives');

// ---- texts about a known work: its names are 1, lowercase everyday words 0, the rest left out ----
function about(text, w, src) {
  for (const h of hits(text)) {
    // a franchise name counts only as a name, not as an everyday word ("starfighter" in a Star Wars article)
    if (holds(h.g, w) || (related(h.g, w) && !h.word && /^\p{Lu}/u.test(text.slice(h.s)))) add(text, h, 1, src);
    else if (h.word && !/\p{Lu}/u.test(text.slice(h.s, h.e))) add(text, h, 0, src + '-word'); // "the X-Men" is no everyday word
  }
}
const norm = (s) => s.toLowerCase().normalize('NFD').replace(/[^a-z0-9]+/g, '');
const byNorm = new Map(); order.forEach((w) => { const k = norm(catalog.works[w].title); if (!byNorm.has(k)) byNorm.set(k, w); });
function parseCsv(text) { // minimal RFC 4180 reader (as in tools/train-spoiler.mjs)
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
const showWork = new Map();
const SHOW = { legend_of_korra: 'The Legend of Korra', spy_x_family: 'Spy × Family' }; // slugs whose title differs
const showOf = (slug) => {
  if (!showWork.has(slug)) showWork.set(slug, byNorm.get(norm(SHOW[slug] ?? slug)) ?? [...byNorm].find(([k]) => k.startsWith(norm(slug)))?.[1]);
  return showWork.get(slug);
};
const comments = [];
for (const n of ['train', 'dev', 'test']) {
  const p = fs.existsSync(`build/spoiler-data/sm_${n}.csv`) ? `build/spoiler-data/sm_${n}.csv` : `research/data/spoiler-matching/filtering/handlabeled/${n}.csv`;
  if (fs.existsSync(p)) for (const r of parseCsv(fs.readFileSync(p, 'utf8'))) if (r.length >= 3) comments.push([r[1], r[2]]);
}
for (const n of ['train', 'test']) {
  const p = `research/data/spoiler-matching/matching/handlabeled_only/${n}.json`;
  if (fs.existsSync(p)) for (const r of JSON.parse(fs.readFileSync(p, 'utf8'))) comments.push([r[2], r[0]]);
}
const seenC = new Set();
for (const [text, slug] of comments) {
  if (!text || text.length < 15 || text.length > 400 || seenC.has(text)) continue;
  seenC.add(text);
  const w = showOf(slug);
  if (w !== undefined) about(text, w, 'reddit');
}
console.log('reddit shows:', [...showWork].map(([k, w]) => `${k}=${w === undefined ? '?' : catalog.works[w].title}`).join(', '));
if (fs.existsSync('build/spoiler-data/wiki')) {
  for (const f of fs.readdirSync('build/spoiler-data/wiki').filter((x) => /^Q\d+\.json$/.test(x)).sort()) {
    const w = idx.get(f.slice(0, -5)); if (w === undefined) continue;
    const text = Object.values(JSON.parse(fs.readFileSync(`build/spoiler-data/wiki/${f}`, 'utf8')).query?.pages ?? {})[0]?.extract ?? '';
    for (const s of sentencesOf(text.replace(/\n==+[^=]+==+\n/g, '\n'))) about(s, w, 'wiki');
  }
}
if (fs.existsSync('research/data/plots/plots.json')) {
  for (const r of Object.values(JSON.parse(fs.readFileSync('research/data/plots/plots.json', 'utf8')))) {
    const w = idx.get(r.qid); if (w === undefined) continue;
    for (const s of sentencesOf(r.text)) about(s, w, 'plot');
  }
}

// ---- balance per name and label, split by name, augment ----
const MEDIA = /\b(movie|movies|film|films|show|shows|series|season|seasons|episode|episodes|game|games|book|books|novel|manga|anime|comic|comics|trailer|chapter|playing|played|watched|watching|rewatching|reading|dizi|dizisi|filmi|película|serie|filme|jogo|Film|Serie|Spiel|film|série|jeu)\b ?/gi;
function augment(r, kind) {
  let { text, s, e } = r;
  const same = (f) => { const t = f(text); return t.length === text.length ? t : null; };
  let t = null;
  if (kind === 'lower') t = same((x) => x.toLowerCase());
  else if (kind === 'upper') t = same((x) => x.toUpperCase());
  else if (kind === 'headline') t = same((x) => x.replace(/(^|\s)(\p{Ll})/gu, (_, a, b) => a + b.toUpperCase()));
  else if (kind === 'nomedia') {
    let o = '', last = 0, ns = s, ne = e;
    for (const x of text.matchAll(MEDIA)) {
      const a = x.index, b = a + x[0].length;
      if (b > s && a < e) continue;
      o += text.slice(last, a); last = b;
      if (b <= s) { ns -= b - a; ne -= b - a; }
    }
    o += text.slice(last);
    if (o === text) return null;
    return { ...r, text: o, s: ns, e: ne, aug: kind };
  } else if (kind === 'poss') {
    if (!/^(\s|[,.!?]|$)/.test(text.slice(e, e + 1)) || /['’]/.test(text.slice(s, e))) return null;
    return { ...r, text: text.slice(0, e) + (/s$/i.test(text.slice(s, e)) ? '’' : "'s") + text.slice(e), aug: kind };
  }
  return t && t !== text ? { ...r, text: t, aug: kind } : null;
}
const AUG = ['lower', 'upper', 'headline', 'nomedia', 'poss'];
const buckets = new Map();
for (const r of shuffle(raw)) {
  const k = `${nameOf(r.g)}\u0000${r.y}`;
  (buckets.get(k) ?? buckets.set(k, []).get(k)).push(r);
}
const pairs = [];
for (const rs of buckets.values()) {
  // keep sources mixed within a name: round robin over sources
  const bySrc = new Map(); for (const r of rs) (bySrc.get(r.src) ?? bySrc.set(r.src, []).get(r.src)).push(r);
  const lists = [...bySrc].filter(([k]) => !HAND.has(k)).map(([, l]) => l), kept = [];
  for (const k of HAND) for (const r of bySrc.get(k) ?? []) {
    const split = isVal(r.g) ? 'val' : 'train';
    pairs.push({ ...r, split, aug: 'none' });
    for (const x of ['lower', 'upper', 'headline']) { const a = augment(r, x); if (a) pairs.push({ ...a, split }); }
  }
  for (let i = 0; kept.length < CAP && lists.some((l) => i < l.length); i++) for (const l of lists) if (i < l.length && kept.length < CAP) kept.push(l[i]);
  for (const r of kept) {
    const split = isVal(r.g) ? 'val' : 'train';
    pairs.push({ ...r, split, aug: 'none' });
    const a = augment(r, pick(r.y ? AUG : AUG.filter((x) => x !== 'poss' || r.src === 'slot')));
    if (a) pairs.push({ ...a, split });
  }
}
const seen = new Set(), items = [];
for (const r of pairs) {
  const a = windowText(r.text, r.s, r.e), b = workText(meta, r.g), key = `${a}\u0000${b}`;
  if (seen.has(key)) continue;
  seen.add(key);
  items.push({ a, b, y: r.y, split: r.split, src: r.src, lang: r.lang, aug: r.aug, name: nameOf(r.g) });
  if (HAND.has(r.src) && r.split === 'train') items.push(items.at(-1)); // the look-alikes count twice in training
}
const count = (f) => items.filter(f).length;
const srcs = [...new Set(items.map((x) => x.src))].sort();
console.log(`pairs: ${items.length} (train ${count((x) => x.split === 'train')}, val ${count((x) => x.split === 'val')}), positives ${count((x) => x.y)}; ` +
  `names ${new Set(items.map((x) => x.name)).size} (val ${new Set(items.filter((x) => x.split === 'val').map((x) => x.name)).size})`);
console.log('by source (pos/neg):', srcs.map((s) => `${s} ${count((x) => x.src === s && x.y)}/${count((x) => x.src === s && !x.y)}`).join(', '));
console.log('fill works', fillWorks.length, '; non-English:', count((x) => x.lang !== 'en'), '; raw candidates', raw.length);
const itemsPath = process.env.SB_ITEMS ?? 'build/context-train-items.jsonl'; // SB_ITEMS: write the pairs elsewhere
fs.mkdirSync(itemsPath.replace(/[^/]*$/, '') || '.', { recursive: true });
fs.writeFileSync(itemsPath, items.map((x) => JSON.stringify(x)).join('\n'));
if (process.env.SB_DATA_ONLY) process.exit(0);
// SB_RETHRESHOLD=1: keep the model in outDir, only choose the threshold again
if (!process.env.SB_RETHRESHOLD) execFileSync(process.env.PYTHON ?? 'python3', ['-I', 'tools/context-train/finetune.py', itemsPath, out, String(WINDOW), String(MAX_LEN)], { stdio: 'inherit' });

// ---- threshold: on the held-out names, scored with the shipped runtime (onnxruntime-web, one pair per run) ----
// the lowest threshold whose false-yes rate is at most MAX_FALSE_YES (a false cover is worse than a miss)
const MAX_FALSE_YES = 0.02;
const { contextClassifier } = await import('./context-train/classify.mjs');
const { prob } = await contextClassifier(out);
const val = items.filter((x) => x.split === 'val');
for (const x of val) x.p = await prob(x.a, x.b);
if (process.env.SB_SCORES) fs.writeFileSync(process.env.SB_SCORES, JSON.stringify(val)); // optional dump for inspection
const rates = (zs, t) => { const P = zs.filter((z) => z.y), N = zs.filter((z) => !z.y); return [P.filter((z) => z.p >= t).length / (P.length || 1), N.filter((z) => z.p >= t).length / (N.length || 1)]; };
const ths = [...Array(99)].map((_, i) => (i + 1) / 100).concat([0.995, 0.999]);
const thr = ths.find((t) => rates(val, t)[1] <= MAX_FALSE_YES) ?? 0.999;
const en = val.filter((z) => z.lang === 'en'), ne = val.filter((z) => z.lang !== 'en');
console.log(`held-out names: ${new Set(val.map((z) => z.name)).size} names, ${val.length} pairs (${val.filter((z) => z.y).length} positive; non-English ${ne.length})`);
console.log('threshold  recall / false-yes:  all  |  English  |  non-English');
for (const t of [...new Set([0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.85, 0.9, 0.95, 0.98, 0.99, thr])].sort((a, b) => a - b)) {
  console.log(`  ${t.toFixed(3)}  ${[val, en, ne].map((s) => rates(s, t).map((v) => v.toFixed(3)).join(' / ')).join('  |  ')}${t === thr ? '   <- chosen' : ''}`);
}
console.log('yes rate per source at the chosen threshold:');
for (const s of [...new Set(val.map((z) => z.src))].sort()) {
  const zs = val.filter((z) => z.src === s);
  console.log(`  ${s.padEnd(12)} n=${String(zs.length).padStart(5)}  yes ${(zs.filter((z) => z.p >= thr).length / zs.length).toFixed(3)}`);
}
const mf = `${out}/meta.json`;
fs.writeFileSync(mf, JSON.stringify({ ...JSON.parse(fs.readFileSync(mf, 'utf8')), threshold: thr }));
