// OCR comparison on the v2 sets: PP-OCR (src/background/ocr.js, onnxruntime-node) vs tesseract.js as shipped in 0.1.
// Scores: word recall of the caption, the expected work found by the real matcher in the OCR text (only counted where
// the clean caption itself matches), and works falsely found in photos with no caption.
// usage: SB_RESEARCH=<main>/research node research/scripts/v2-ocr-eval.mjs <engine> [set...]
//   engine: tesseract | ppocr:<det.onnx>:<rec.onnx>[:detMax:detMin]   set: v2 (default), synth, clean
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import * as ort from 'onnxruntime-node';
import { recognize, OCR } from '../../src/background/ocr.js';
import { buildIndex } from '../../tools/build-index.mjs';
import '../../src/content/matcher.js';
const R = process.env.SB_RESEARCH, V2 = R + '/results/v2';
const [engine, ...sets0] = process.argv.slice(2);
const sets = sets0.length ? sets0 : ['v2', 'synth', 'clean'];

const built = buildIndex(JSON.parse(fs.readFileSync('data/catalog.json', 'utf8')));
const m = new globalThis.SBMatcher.Matcher(built.bin, built.meta);
const G = built.meta.groups;
const found = (text) => m.evaluate(text, () => false).map((g) => G[g][0]);
const isWant = (text, want) => m.evaluate(text, () => false).some((g) => G[g].slice(1).some((w) => built.meta.titles[w] === want) || G[g][0] === want);

const items = [];
if (sets.includes('v2')) for (const [f, t] of Object.entries(JSON.parse(fs.readFileSync(V2 + '/data/ocr-v2/truth.json')))) items.push({ file: `${V2}/data/ocr-v2/${f}`, text: t.lines.join('\n'), want: t.want, style: t.style });
if (sets.includes('synth')) for (const [f, t] of Object.entries(JSON.parse(fs.readFileSync(R + '/data/ocr/truth.json')))) items.push({ file: `${R}/data/ocr/${f}`, text: t.text, want: null, style: 'synth-' + t.style });
if (sets.includes('clean')) for (const x of JSON.parse(fs.readFileSync(R + '/results/images.json'))) if (!x.want) items.push({ file: x.file, text: '', want: null, style: 'no-caption' });

let run;
if (engine === 'tesseract') {
  const { createRequire } = await import('node:module');
  const require = createRequire(path.resolve('package.json'));
  const { createWorker } = require('tesseract.js');
  const w = await createWorker('eng', 1, { langPath: path.dirname(require.resolve('@tesseract.js-data/eng/package.json')) + '/4.0.0_best_int', gzip: true, cacheMethod: 'none' });
  run = async (file) => { const { data } = await w.recognize(await sharp(file).png().toBuffer()); return data.confidence >= 60 ? data.text.trim() : ''; };
} else {
  const [, detF, recF, dm, dn] = engine.split(':');
  const opt = { executionProviders: ['cpu'], intraOpNumThreads: +(process.env.THREADS ?? 1) };
  const s = { det: await ort.InferenceSession.create(detF, opt), rec: await ort.InferenceSession.create(recF, opt), chars: fs.readFileSync(recF.replace('.onnx', '.dict.txt'), 'utf8').split('\n') };
  const o = { ...OCR, ...(dm ? { detMax: +dm } : {}), ...(dn ? { detMin: +dn } : {}), ...(process.env.OCR_OPT ? JSON.parse(process.env.OCR_OPT) : {}) };
  run = async (file) => {
    const { data, info } = await sharp(file).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    return (await recognize(ort, s, { data, width: info.width, height: info.height }, o)).text;
  };
}

const norm = (s) => (s ?? '').toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9' ]+/g, ' ').split(/\s+/).filter(Boolean);
const by = {}, ms = [], detail = [];
for (const it of items) {
  const t = performance.now();
  let out = '';
  try { out = await run(it.file); } catch (e) { out = ''; console.error(it.file, e.message); }
  ms.push(performance.now() - t);
  const b = (by[it.style] ??= { n: 0, recall: 0, matchable: 0, hit: 0, falseWork: 0 });
  b.n++;
  const want = norm(it.text), got = new Set(norm(out));
  if (want.length) b.recall += want.filter((w) => got.has(w)).length / want.length;
  if (it.want && isWant(it.text, it.want)) { b.matchable++; if (isWant(out, it.want)) b.hit++; }
  const ok = new Set(found(it.text)); // works the clean caption itself names (other characters' works, words in titles)
  const wrong = found(out).filter((x) => !ok.has(x) && !(it.want && isWant(x, it.want)));
  if (wrong.length) b.falseWork++;
  detail.push({ f: path.basename(it.file), style: it.style, truth: it.text, out, wrong });
}
const tot = { n: 0, matchable: 0, hit: 0, falseWork: 0, recall: 0, rn: 0 };
const rowsOut = Object.entries(by).map(([k, b]) => {
  for (const x of ['n', 'matchable', 'hit', 'falseWork']) tot[x] += b[x];
  if (k !== 'no-caption') { tot.recall += b.recall; tot.rn += b.n; }
  return `${k.padEnd(16)} n=${String(b.n).padStart(3)}  word recall ${k === 'no-caption' ? '  - ' : (b.recall / b.n).toFixed(2)}  work found ${b.hit}/${b.matchable}  images with a wrong work ${b.falseWork}`;
});
ms.sort((a, b) => a - b);
const tag = engine.split(':').map((x) => x.split('/').pop().replace('.onnx', '')).join('_') + (process.env.TAG ?? '');
const summary = `${engine}${process.env.OCR_OPT ? ' ' + process.env.OCR_OPT : ''}\n${rowsOut.join('\n')}\nALL captioned: word recall ${(tot.recall / tot.rn).toFixed(3)}  work found ${tot.hit}/${tot.matchable}  wrong-work images ${tot.falseWork}/${tot.n}  median ${Math.round(ms[ms.length >> 1])} ms, p90 ${Math.round(ms[Math.floor(ms.length * 0.9)])} ms (node, ${process.env.THREADS ?? 1} thread)\n`;
console.log(summary);
fs.mkdirSync(V2 + '/ocr', { recursive: true });
fs.appendFileSync(V2 + '/ocr/summary.txt', summary + '\n');
fs.writeFileSync(`${V2}/ocr/${tag}.json`, JSON.stringify(detail, null, 1));
process.exit(0); // tesseract's worker keeps node alive
