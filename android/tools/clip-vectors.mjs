// Test vectors for the Java port of the image verdict (extensions/blocker/src/test/.../ClipTest.java and the on-device
// run in the demo app). For every image of test/fixtures/images/labels.json it writes the 224x224 RGB pixels the
// extension's preprocessing gives (centre-square crop, resize, as tools/calibrate-clip.mjs does with sharp) and the
// verdict of src/background/engine.js clipCheck() on them, run with the shipped model (onnxruntime-web WASM, 1 thread,
// as in the browser) and the shipped dist/firefox/data/clip-text.bin + clip-meta.json.
// usage (from the repo root or android/): node android/tools/clip-vectors.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import * as ort from 'onnxruntime-web';

ort.env.wasm.numThreads = 1;
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const out = path.join(repo, 'android/build/vectors/clip');
fs.mkdirSync(out, { recursive: true });
const data = path.join(repo, 'dist/firefox/data');
const meta = JSON.parse(fs.readFileSync(path.join(data, 'clip-meta.json'), 'utf8'));
const mat = new Int8Array(fs.readFileSync(path.join(data, 'clip-text.bin')).buffer.slice(0));
const index = JSON.parse(fs.readFileSync(path.join(data, 'index.json'), 'utf8'));
const sess = await ort.InferenceSession.create(fs.readFileSync(path.join(repo, 'dist/firefox/models/clip/onnx/vision_model_quantized.onnx')),
  { executionProviders: ['wasm'] });

const MEAN = [0.48145466, 0.4578275, 0.40821073], STD = [0.26862954, 0.26130258, 0.27577711];
const S = 224;
async function pixels(file) {
  const img = sharp(file).removeAlpha();
  const { width, height } = await img.metadata();
  const side = Math.min(width, height);
  return img.extract({ left: (width - side) >> 1, top: (height - side) >> 1, width: side, height: side })
    .resize(S, S, { kernel: 'linear' }).raw().toBuffer();
}

// engine.js clipCheck() from the pixels on
async function verdict(px) {
  const x = new Float32Array(3 * S * S);
  for (let i = 0; i < S * S; i++) for (let c = 0; c < 3; c++) x[c * S * S + i] = (px[i * 3 + c] / 255 - MEAN[c]) / STD[c];
  const r = await sess.run({ pixel_values: new ort.Tensor('float32', x, [1, 3, S, S]) });
  const v = r.image_embeds.data;
  let n2 = 0; for (const a of v) n2 += a * a;
  const inv = 1 / Math.sqrt(n2), D = meta.dim;
  let neg = -1;
  for (const t of meta.neg) { let s = 0; for (let j = 0; j < D; j++) s += t[j] * v[j]; neg = Math.max(neg, s * inv); }
  let media = -1;
  for (const t of meta.media) { let s = 0; for (let j = 0; j < D; j++) s += t[j] * v[j]; media = Math.max(media, s * inv); }
  const scores = [];
  for (let r = 0; r < meta.n && media - neg >= meta.mediaGate; r++) {
    let s = 0; const o = r * D;
    for (let j = 0; j < D; j++) s += mat[o + j] * v[j];
    s *= inv / 127;
    if (s >= meta.minScore && s - neg >= meta.margin) scores.push([r, +s.toFixed(3)]);
  }
  scores.sort((a, b) => b[1] - a[1]);
  let hits = [];
  if (scores.length) {
    const [top, best] = scores[0], fam = meta.rowFamily[top];
    let second = -1;
    for (let r = 0; r < meta.n; r++) {
      if (meta.rowFamily[r] === fam) continue;
      let s = 0; const o = r * D;
      for (let j = 0; j < D; j++) s += mat[o + j] * v[j];
      second = Math.max(second, s * inv / 127);
    }
    hits = best - second >= meta.titleGap ? scores.slice(0, 3).map(([r, s]) => [meta.rowGroup[r], s]) : [[-1, best]];
  }
  return { hits, media: media - neg, embed: Array.from(v, (a) => a * inv) };
}

const DIR = path.join(repo, 'test/fixtures/images');
const labels = JSON.parse(fs.readFileSync(path.join(DIR, 'labels.json'), 'utf8'));
const wantWorks = (want) => {
  const ws = new Set();
  index.groups.forEach((g) => { if (g[0] === want) g.slice(1).forEach((w) => ws.add(w)); });
  index.titles.forEach((t, w) => { if (t === want) ws.add(w); });
  return ws;
};
const cases = [];
const tally = { titled: 0, generic: 0, wrong: 0, missed: 0, ordinaryBlocked: 0 };
for (const [file, want] of Object.entries(labels)) {
  if (!fs.existsSync(path.join(DIR, file))) continue;
  const px = await pixels(path.join(DIR, file));
  fs.writeFileSync(path.join(out, file + '.rgb'), px);
  const { hits, media, embed } = await verdict(px);
  let kind = 'missed';
  if (hits.length) kind = hits[0][0] === -1 ? 'generic' : index.groups[hits[0][0]].slice(1).some((w) => want && wantWorks(want).has(w)) ? 'titled' : 'wrong';
  if (!want) { if (hits.length) tally.ordinaryBlocked++; } else tally[kind]++;
  cases.push({ file, want, hits, kind: want ? kind : hits.length ? 'blocked' : 'ok', media, embed });
}
fs.writeFileSync(path.join(out, 'clip-cases.json'), JSON.stringify(cases));
const media = cases.filter((c) => c.want).length;
console.log(`clip vectors: ${media} media: ${tally.titled} titled / ${tally.generic} generic / ${tally.wrong} wrong / ${tally.missed} missed; ` +
  `${tally.ordinaryBlocked} of ${cases.length - media} ordinary blocked -> ${out}`);
for (const c of cases) if (c.hits.length) console.log(`  ${c.kind.padEnd(8)} ${c.file} -> ${c.hits.map(([g, s]) => `${g === -1 ? '(unrecognised)' : index.groups[g][0]} ${s}`).join(', ')}`);
