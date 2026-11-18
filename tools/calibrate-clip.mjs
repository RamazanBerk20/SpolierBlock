// Calibrates the CLIP image verdict (minScore, margin) and the number of title rows (--clip-n) against the real
// catalog using test/fixtures/images/labels.json (file -> expected name, null = ordinary photo).
// Image preprocessing mirrors src/background/engine.js (center square crop, 224 px, CLIP mean/std) via sharp.
// usage: node tools/calibrate-clip.mjs [catalog=data/catalog.json]
import fs from 'node:fs';
import sharp from 'sharp';
import { env, CLIPVisionModelWithProjection, Tensor } from '@huggingface/transformers';
import { buildIndex } from './build-index.mjs';
import { buildClipText, clipRows, rowFamilies, CLIP_MODEL } from './build-clip-text.mjs';
import { NEGATIVES } from './clip-prompts.mjs';
env.cacheDir = 'build/.cache';

const built = buildIndex(JSON.parse(fs.readFileSync(process.argv[2] ?? 'data/catalog.json', 'utf8')));
const { items, rowGroup } = clipRows(built, Infinity);
console.log(`title rows available: ${items.length}`);
const text = await buildClipText(items);
const groups = built.meta.groups;

const DIR = 'test/fixtures/images';
const labels = JSON.parse(fs.readFileSync(`${DIR}/labels.json`, 'utf8'));
const vision = await CLIPVisionModelWithProjection.from_pretrained(CLIP_MODEL, { dtype: 'q8' });
const MEAN = [0.48145466, 0.4578275, 0.40821073], STD = [0.26862954, 0.26130258, 0.27577711];
async function embed(file) {
  const img = sharp(file).removeAlpha();
  const { width, height } = await img.metadata();
  const side = Math.min(width, height);
  const px = await img.extract({ left: (width - side) >> 1, top: (height - side) >> 1, width: side, height: side })
    .resize(224, 224, { kernel: 'linear' }).raw().toBuffer();
  const S = 224, x = new Float32Array(3 * S * S);
  for (let i = 0; i < S * S; i++) for (let c = 0; c < 3; c++) x[c * S * S + i] = (px[i * 3 + c] / 255 - MEAN[c]) / STD[c];
  const { image_embeds } = await vision({ pixel_values: new Tensor('float32', x, [1, 3, S, S]) });
  const v = Array.from(image_embeds.data), n = Math.hypot(...v);
  return v.map((a) => a / n);
}
// int8 like the shipped matrix
const q = text.rows.map((r) => r.map((x) => Math.max(-127, Math.min(127, Math.round(x * 127))) / 127));
const dot = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; };

const res = [];
for (const [f, want] of Object.entries(labels)) {
  if (!fs.existsSync(`${DIR}/${f}`)) continue;
  const e = await embed(`${DIR}/${f}`);
  const scores = q.map((r) => dot(r, e));
  const neg = Math.max(...text.neg.map((t) => dot(t, e)));
  const media = Math.max(...text.media.map((t) => dot(t, e))) - neg;
  res.push({ f, want, scores, neg, media });
}
const posN = res.filter((r) => r.want).length, negN = res.length - posN;
console.log(`images: ${posN} media, ${negN} ordinary; negatives prompts: ${NEGATIVES.length}`);

// works the expected name stands for: every group labelled with it plus works titled with it
const wantCache = new Map();
function wantWorks(want) {
  if (!wantCache.has(want)) {
    const ws = new Set();
    groups.forEach((g) => { if (g[0] === want) g.slice(1).forEach((w) => ws.add(w)); });
    built.meta.titles.forEach((t, w) => { if (t === want) ws.add(w); });
    wantCache.set(want, ws);
  }
  return wantCache.get(want);
}
function evalAt(N, minScore, margin, gate = -1) {
  let tp = 0, wrong = 0, fp = 0;
  const fps = [], wrongs = [];
  for (const r of res) {
    let best = -1, bi = -1;
    for (let i = 0; i < N; i++) if (r.scores[i] > best) { best = r.scores[i]; bi = i; }
    const hit = r.media >= gate && best >= minScore && best - r.neg >= margin;
    if (!hit) continue;
    const label = groups[rowGroup[bi]][0];
    if (!r.want) { fp++; fps.push(`${r.f}->${label}(${best.toFixed(3)},${(best - r.neg).toFixed(3)})`); }
    else if (groups[rowGroup[bi]].slice(1).some((w) => wantWorks(r.want).has(w))) tp++;
    else { wrong++; wrongs.push(`${r.f}->${label}`); }
  }
  return { tp, wrong, fp, fps, wrongs };
}

const Ns = [500, 1000, 2000, 5000, 10000, items.length];
console.log('\nhighest ordinary-photo (score, margin) per N, i.e. how far the noise floor rises with more rows:');
for (const N of Ns) {
  const worst = res.filter((r) => !r.want).map((r) => {
    let best = -1, bi = -1;
    for (let i = 0; i < N; i++) if (r.scores[i] > best) { best = r.scores[i]; bi = i; }
    return [best - r.neg, best, r.f, groups[rowGroup[bi]][0]];
  }).sort((a, b) => b[0] - a[0]).slice(0, 3);
  console.log(`N=${String(N).padStart(5)}  ` + worst.map(([m, s, f, l]) => `${f}->${l} s=${s.toFixed(3)} m=${m.toFixed(3)}`).join(' | '));
}
console.log('\nmedia gate (max media-prompt cos - max generic cos): ordinary vs media images');
const ms = (w) => res.filter((r) => !!r.want === w).map((r) => r.media).sort((a, b) => b - a);
console.log('ordinary top:', ms(false).slice(0, 6).map((x) => x.toFixed(3)).join(' '), '\nmedia (desc):', ms(true).map((x) => x.toFixed(3)).join(' '));
console.log('\nN      gate   minScore margin   correct-title  other-title  false-blocks(ordinary)');
for (const N of Ns) for (const gate of [0.0, 0.01, 0.02, 0.03]) for (const minScore of [0.22, 0.24]) for (const margin of [0.0, 0.01, 0.02, 0.03, 0.04]) {
  const r = evalAt(N, minScore, margin, gate);
  console.log(`${String(N).padStart(5)}  ${gate.toFixed(2)}   ${minScore.toFixed(2)}     ${margin.toFixed(3)}    ${String(r.tp).padStart(2)}/${posN}              ${String(r.wrong).padStart(2)}           ${r.fp}/${negN} ${r.fps.slice(0, 2).join(' ')}`);
}
const [N, ms0, mg, gt] = (process.env.SHOW ?? '').split(',').map(Number);
if (N) { const r = evalAt(N, ms0, mg, gt); console.log('\ndetail', JSON.stringify(r, null, 1)); }

// Title confidence for purely visual matches: a hit keeps its title only when its margin over the generic prompts
// and its gap to the best unrelated title are both large; otherwise it is a generic "unrecognised" block.
let fam = null;
function hitDetail(r, N) {
  let best = -1, bi = -1;
  for (let i = 0; i < N; i++) if (r.scores[i] > best) { best = r.scores[i]; bi = i; }
  const g = groups[rowGroup[bi]];
  fam ??= rowFamilies(groups, rowGroup.slice(0, N));
  let second = -1;
  for (let i = 0; i < N; i++) if (fam[i] !== fam[bi] && r.scores[i] > second) second = r.scores[i];
  return { best, bi, label: g[0], margin: best - r.neg, gap: best - second, correct: !!r.want && g.slice(1).some((w) => wantWorks(r.want).has(w)) };
}
const [CN, CMS, CMG, CGT] = [2000, 0.22, 0.02, 0.015]; // titleGap shipped: 0.02 // the shipped verdict settings (tools/build.mjs)
const hits = res.filter((r) => r.media >= CGT).map((r) => ({ r, d: hitDetail(r, CN) })).filter(({ d }) => d.best >= CMS && d.margin >= CMG);
console.log(`\nhits at N=${CN} minScore=${CMS} margin=${CMG} gate=${CGT} (title margin / gap to best unrelated title):`);
for (const { r, d } of hits.sort((a, b) => b.d.gap - a.d.gap)) console.log(`  ${(r.want ? (d.correct ? 'RIGHT' : 'WRONG') : 'ORDINARY').padEnd(8)} gap ${d.gap.toFixed(3)} margin ${d.margin.toFixed(3)}  ${r.f} -> ${d.label}`);
console.log('\ntitleGap titleMargin  right  generic  wrong  missed  ordinary-blocked');
for (const tg of [0, 0.005, 0.01, 0.015, 0.02, 0.03]) for (const tm of [0.02, 0.03, 0.04, 0.05]) {
  let right = 0, generic = 0, wrong = 0, fp = 0;
  for (const { r, d } of hits) {
    if (!r.want) { fp++; continue; }
    if (d.gap >= tg && d.margin >= tm) { if (d.correct) right++; else wrong++; } else generic++;
  }
  console.log(`  ${tg.toFixed(3)}    ${tm.toFixed(3)}        ${right}      ${generic}       ${wrong}      ${posN - right - generic - wrong}       ${fp}/${negN}`);
}
