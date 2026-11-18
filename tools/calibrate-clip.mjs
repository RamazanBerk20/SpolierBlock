// Calibrates the image title verdict (minScore, margin, titleGap, mediaGate) for the shipped vision tower and title rows, on a
// calibration split, and reports it on a held-out split. Media images are split by work (all images of a work fall on
// one side), ordinary photos by file name; then the sides are swapped and both held-out results are added up.
// Images: test/fixtures/images/labels.json, plus the research sets when SB_RESEARCH points at a research/ directory
// (results/images.json: Commons cosplay, posters, ordinary photos; results/v2/data/ordinary2).
// Preprocessing is the engine's own (src/background/pixels.js) on sharp's decoded pixels.
// usage: [SB_RESEARCH=research] node tools/calibrate-clip.mjs [catalog=data/catalog.json] [--clip-n=N]
import fs from 'node:fs';
import sharp from 'sharp';
import * as ort from 'onnxruntime-node';
import { buildIndex } from './build-index.mjs';
import { squashCHW } from '../src/background/pixels.js';
import { buildClipText, clipRows, rowFamilies, visionModel, VISION } from './build-clip-text.mjs';

const args = process.argv.slice(2);
const built = buildIndex(JSON.parse(fs.readFileSync(args.find((a) => !a.startsWith('--')) ?? 'data/catalog.json', 'utf8')));
const N = +(args.find((a) => a.startsWith('--clip-n='))?.split('=')[1] ?? 2000);
const { items, rowGroup } = clipRows(built, N);
const text = await buildClipText(items);
const groups = built.meta.groups, D = text.dim;
const fam = rowFamilies(groups, rowGroup);
const q = text.rows.map((r) => Float32Array.from(r, (x) => Math.max(-127, Math.min(127, Math.round(x * 127))) / 127)); // int8 as shipped

const imgs = Object.entries(JSON.parse(fs.readFileSync('test/fixtures/images/labels.json', 'utf8')))
  .filter(([f]) => fs.existsSync(`test/fixtures/images/${f}`)).map(([f, want]) => ({ file: `test/fixtures/images/${f}`, want }));
const R = process.env.SB_RESEARCH;
if (R) {
  for (const x of JSON.parse(fs.readFileSync(`${R}/results/images.json`, 'utf8'))) if (x.src !== 'fixture' && x.src !== 'fixture-ordinary') imgs.push({ file: x.file, want: x.want });
  const o2 = `${R}/results/v2/data/ordinary2`;
  if (fs.existsSync(o2)) for (const f of fs.readdirSync(o2).filter((f) => f.endsWith('.jpg')).sort()) imgs.push({ file: `${o2}/${f}`, want: null });
}

const sess = await ort.InferenceSession.create(await visionModel(), { intraOpNumThreads: 6 });
const S = VISION.size;
const dot = (a, b, o = 0) => { let s = 0; for (let i = 0; i < D; i++) s += a[o + i] * b[i]; return s; };
const wantCache = new Map();
const wantWorks = (want) => {
  if (!wantCache.has(want)) {
    const ws = new Set();
    groups.forEach((g) => { if (g[0] === want) g.slice(1).forEach((w) => ws.add(w)); });
    built.meta.titles.forEach((t, w) => { if (t === want) ws.add(w); });
    wantCache.set(want, ws);
  }
  return wantCache.get(want);
};
const res = [];
for (const { file, want } of imgs) {
  let img;
  try { const { data, info } = await sharp(file).ensureAlpha().raw().toBuffer({ resolveWithObject: true }); img = { data, width: info.width, height: info.height }; } catch { continue; }
  const x = squashCHW(img, S, VISION.mean, VISION.std);
  const out = await sess.run({ [sess.inputNames[0]]: new ort.Tensor('float32', x, [1, 3, S, S]) });
  const v = out[VISION.output].data, n = Math.hypot(...v), e = Float32Array.from(v, (a) => a / n);
  const sc = q.map((r) => dot(r, e));
  let top = 0;
  sc.forEach((s, r) => { if (s > sc[top]) top = r; });
  let second = -1;
  sc.forEach((s, r) => { if (fam[r] !== fam[top] && s > second) second = s; });
  const neg = Math.max(...text.neg.map((t) => dot(t, e))), media = Math.max(...text.media.map((t) => dot(t, e))) - neg;
  const correct = !!want && groups[rowGroup[top]].slice(1).some((w) => wantWorks(want).has(w));
  res.push({ file, want, score: sc[top], margin: sc[top] - neg, gap: sc[top] - second, media, correct, label: groups[rowGroup[top]][0] });
}
// crc32 of the work (media) or file name (ordinary) -> side 0/1
const crc = (s) => { let c = ~0; for (const b of Buffer.from(s)) { c ^= b; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1)); } return (~c >>> 0) % 2; };
for (const r of res) r.side = crc(r.want ?? r.file.split('/').pop());

const named = (r, c) => r.score >= c.s && r.margin >= c.m && r.gap >= c.g;
const at = (set, c) => {
  let right = 0, wrong = 0, fp = 0;
  for (const r of set) if (named(r, c)) { if (!r.want) fp++; else if (r.correct) right++; else wrong++; }
  return { right, wrong, fp };
};
// candidate cut-offs: quantiles of the media images' values (-9 = unused), gap in steps of 0.0025
const qs = (k, n) => { const v = res.filter((r) => r.want).map((r) => r[k]).sort((a, b) => a - b); return [-9, ...Array.from({ length: n }, (_, i) => +v[Math.floor((i * v.length) / n)].toFixed(4))]; };
const grid = [];
for (const s of qs('score', 25)) for (const m of qs('margin', 40)) for (let g = 0; g <= 0.08; g += 0.0025) grid.push({ s, m, g: +g.toFixed(4) });
// cut-offs on one side: no ordinary photo named, then most right titles with a wrong title costing 3 right ones
const choose = (set) => grid.map((c) => ({ ...c, ...at(set, c) })).filter((x) => x.fp === 0).sort((a, b) => b.right - 3 * b.wrong - (a.right - 3 * a.wrong) || b.s - a.s || b.m - a.m)[0];
// unknown-media gate (settings.unknownImages): the lowest gate that names no ordinary photo on the calibration side
const gate = (set) => Math.max(...set.filter((r) => !r.want).map((r) => r.media)) + 1e-4;
const sides = [0, 1].map((s) => res.filter((r) => r.side === s));
const count = (set) => `${set.filter((r) => r.want).length} media / ${set.filter((r) => !r.want).length} ordinary`;
const tot = { right: 0, wrong: 0, fp: 0, unknownMedia: 0, unknownOrdinary: 0 };
for (const [a, b] of [[0, 1], [1, 0]]) {
  const c = choose(sides[a]), held = at(sides[b], c), mg = gate(sides[a]);
  const unk = sides[b].filter((r) => !named(r, c) && r.media >= mg);
  console.log(`calibrate on side ${a} (${count(sides[a])}): minScore ${c.s} margin ${c.m} titleGap ${c.g} mediaGate ${mg.toFixed(4)} -> fit right ${c.right} wrong ${c.wrong}`);
  console.log(`  held-out side ${b} (${count(sides[b])}): right ${held.right}  wrong ${held.wrong}  ordinary named ${held.fp}  unknown-media verdicts: media ${unk.filter((r) => r.want).length}, ordinary ${unk.filter((r) => !r.want).length}`);
  for (const k of ['right', 'wrong', 'fp']) tot[k] += held[k];
  tot.unknownMedia += unk.filter((r) => r.want).length; tot.unknownOrdinary += unk.filter((r) => !r.want).length;
}
console.log(`held-out total (${count(res)}, N=${N} rows): right ${tot.right}  wrong ${tot.wrong}  ordinary named ${tot.fp}  unknown-media: media ${tot.unknownMedia}, ordinary ${tot.unknownOrdinary}`);
const all = choose(res);
console.log(`cut-offs fitted on all images (what tools/build.mjs ships): minScore ${all.s} margin ${all.m} titleGap ${all.g} mediaGate ${gate(res).toFixed(4)} (fit: right ${all.right} wrong ${all.wrong})`);
const fx = res.filter((r) => r.file.startsWith('test/fixtures'));
const f = at(fx, all);
console.log(`test/fixtures/images with those cut-offs: right ${f.right}/${fx.filter((r) => r.want).length} wrong ${f.wrong} ordinary named ${f.fp}/${fx.filter((r) => !r.want).length}`);
if (process.env.SHOW) for (const r of res.filter((r) => named(r, all))) console.log(`  ${r.want ? (r.correct ? 'RIGHT' : 'WRONG') : 'ORDINARY'} ${r.file.split('/').slice(-2).join('/')} -> ${r.label} (margin ${r.margin.toFixed(3)} gap ${r.gap.toFixed(3)})`);
