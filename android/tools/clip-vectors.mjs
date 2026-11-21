// Test vectors for the Java port of the image checks (ClipTest, OcrTest and the demo app's on-device ImageEval).
// For every image of test/fixtures/images/labels.json:
//  - <file>.src.rgba: the decoded image (sharp; over 2048 px scaled down first, as the engine does), from which Java's
//    own resize (Images.visionPixels) is checked
//  - <file>.rgb: the 256x256 RGB pixels the engine's src/background/pixels.js makes of it, and the verdict and embedding
//    of src/background/engine.js's title check on them (shipped model, onnxruntime-web WASM 1 thread as in the browser,
//    shipped clip-text.bin + clip-meta.json) -> clip-cases.json
// For the ocr* images: <file>.rgba at <= 1280 px (the extension's OCR input size) and the text of the extension's own
// src/background/ocr.js recognize() on it -> ocr-cases.json.
// usage (repo root): node android/tools/clip-vectors.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import * as ort from 'onnxruntime-web';
import { recognize } from '../../src/background/ocr.js';
import { squashCHW } from '../../src/background/pixels.js';
import { scores, verdict as verdictOf } from '../../src/background/image-verdict.js';

ort.env.wasm.numThreads = 1;
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const out = path.join(repo, 'android/build/vectors/clip');
fs.mkdirSync(out, { recursive: true });
const dist = path.join(repo, 'dist/firefox');
const meta = JSON.parse(fs.readFileSync(path.join(dist, 'data/clip-meta.json'), 'utf8'));
const mat = new Int8Array(fs.readFileSync(path.join(dist, 'data/clip-text.bin')).buffer.slice(0));
const index = JSON.parse(fs.readFileSync(path.join(dist, 'data/index.json'), 'utf8'));
const session = (f) => ort.InferenceSession.create(fs.readFileSync(path.join(dist, f)), { executionProviders: ['wasm'], graphOptimizationLevel: 'all' });
const sess = await session('models/vision/model.onnx');
const S = meta.size;

// engine.js titleChecks() for one image, from the pixels on
async function embed(px) {
  const P = S * S, x = new Float32Array(3 * P);
  for (let i = 0; i < P; i++) for (let c = 0; c < 3; c++) x[c * P + i] = (px[i * 3 + c] / 255 - meta.mean[c]) / meta.std[c];
  return (await sess.run({ [sess.inputNames[0]]: new ort.Tensor('float32', x, [1, 3, S, S]) }))[meta.output].data;
}
// the shipped verdict (src/background/image-verdict.js), without its debug log line
console.debug = () => {};
// (and the verdict without the footage head, the rule before it: how many fixtures the head changes)
const noFoot = { ...meta, foot: undefined };
function verdict(v, file) {
  const s = scores(meta, mat, v);
  return { hits: verdictOf(meta, s, file), old: verdictOf(noFoot, s, file), top: s.sc[s.top], neg: s.neg, media: s.media, foot: s.foot, margin: s.margin, gap: s.gap };
}

const fit = async (file, max, alpha) => {
  const img = sharp(file);
  const { width, height } = await img.metadata();
  const s = Math.min(1, max / Math.max(width, height));
  const w = Math.max(1, Math.round(width * s)), h = Math.max(1, Math.round(height * s));
  const raw = await (alpha ? img.ensureAlpha() : img.removeAlpha()).resize(w, h, { fit: 'fill' }).raw().toBuffer();
  return { raw, w, h };
};

const DIR = path.join(repo, 'test/fixtures/images');
const labels = JSON.parse(fs.readFileSync(path.join(DIR, 'labels.json'), 'utf8'));
const cases = [], ocrCases = [];
const tally = { titled: 0, generic: 0, wrong: 0, missed: 0, ordinaryBlocked: 0 };
const byHead = [];
const det = await session('models/ocr/det.onnx'), rec = await session('models/ocr/rec.onnx');
const chars = fs.readFileSync(path.join(dist, 'models/ocr/dict.txt'), 'utf8').split('\n');
for (const [file, want] of Object.entries(labels)) {
  const f = path.join(DIR, file);
  if (!fs.existsSync(f)) continue;
  const src = await fit(f, 2048, true);
  fs.writeFileSync(path.join(out, file + '.src.rgba'), src.raw);
  // pixels.js with mean 0 and std 1/255 gives the 8-bit values it rounds to, before the engine's normalisation
  const u8 = squashCHW({ data: src.raw, width: src.w, height: src.h }, S, [0, 0, 0], [1 / 255, 1 / 255, 1 / 255]);
  const px = Buffer.alloc(S * S * 3);
  for (let i = 0; i < S * S; i++) for (let c = 0; c < 3; c++) px[i * 3 + c] = Math.round(u8[c * S * S + i]);
  fs.writeFileSync(path.join(out, file + '.rgb'), px);
  const v = await embed(px);
  const { hits, old, top, neg, media, foot, margin, gap } = verdict(v, file);
  if (JSON.stringify(old) !== JSON.stringify(hits)) byHead.push(`${file} (${want ? 'media' : 'ordinary'}, foot ${foot.toFixed(3)})`);
  let n2 = 0; for (const a of v) n2 += a * a;
  let kind = 'missed';
  if (hits.length) kind = hits[0][0] === -1 ? 'generic' : index.groups[hits[0][0]][0].toLowerCase() === String(want).toLowerCase() || index.groups[hits[0][0]].slice(1).some((w) => index.titles[w] === want) ? 'titled' : 'wrong';
  if (!want) { if (hits.length) tally.ordinaryBlocked++; } else tally[kind]++;
  cases.push({ file, want, hits, kind: want ? kind : hits.length ? 'blocked' : 'ok', srcW: src.w, srcH: src.h, top, neg, media, foot, margin, gap,
    embed: Array.from(v, (a) => a / Math.sqrt(n2)) });
}
// OCR: the text fixtures (not all of them are labelled) and the labelled spoiler pictures
for (const file of fs.readdirSync(DIR).sort()) {
  if (!/^(ocr|spoiler_)/.test(file)) continue;
  const o = await fit(path.join(DIR, file), 1280, true); // engine.js OCR_SRC_MAX
  fs.writeFileSync(path.join(out, file + '.rgba'), o.raw);
  const r = await recognize(ort, { det, rec, chars }, { data: o.raw, width: o.w, height: o.h });
  ocrCases.push({ file, width: o.w, height: o.h, text: r.text, lines: r.lines });
}
fs.writeFileSync(path.join(out, 'clip-cases.json'), JSON.stringify(cases));
fs.writeFileSync(path.join(out, 'ocr-cases.json'), JSON.stringify(ocrCases));
const media = cases.filter((c) => c.want).length;
console.log(`image vectors: ${media} media: ${tally.titled} titled / ${tally.generic} generic / ${tally.wrong} wrong / ${tally.missed} missed; ` +
  `${tally.ordinaryBlocked} of ${cases.length - media} ordinary blocked; ${ocrCases.length} OCR images; ` +
  `footage head${meta.foot ? ` (cut ${meta.foot.cut})` : ' absent'} changes ${byHead.length} verdicts -> ${out}`);
for (const b of byHead) console.log(`  footage head: ${b}`);
for (const c of cases) if (c.hits.length) console.log(`  ${c.kind.padEnd(8)} ${c.file} -> ${c.hits.map(([g, s]) => `${g === -1 ? '(unrecognised)' : index.groups[g][0]} ${s}`).join(', ')}`);
for (const o of ocrCases) console.log(`  ocr ${o.file}: ${JSON.stringify(o.text)}`);
