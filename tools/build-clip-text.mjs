// Precomputes the title rows for the image verdict with the SigLIP 2 text tower (build time only): int8 rows, one per
// distinct title/series name (row -> group via meta.rowGroup), plus the generic "ordinary photo" and "media" prompts
// (float). Cached in build/ keyed by a hash of the prompts and the model.
import { env, AutoTokenizer, SiglipTextModel } from '@huggingface/transformers';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { textPrompts, NEGATIVES, MEDIA } from './clip-prompts.mjs';
import { weightOnlyInt8 } from './quantize-vision.mjs';
env.cacheDir = 'build/.cache';
// Vision tower shipped in the extension (tools/build.mjs fetches it pinned); the text tower runs here only.
export const IMAGE_MODEL = 'onnx-community/siglip2-base-patch32-256-ONNX';
export const IMAGE_MODEL_REV = '7efccb86b5b6601bfe9e14326e1c11b40b68d44c';

// The shipped vision tower: the fp32 file of that repo (sha256), converted here to weight-only int8
// (tools/quantize-vision.mjs), and the preprocessing src/background/engine.js applies (whole image squashed to
// size x size, (v / 255 - mean) / std, embedding = output `pooler_output`).
export const VISION = { file: 'onnx/vision_model.onnx', sha256: '0ddb7507cfcb54c2cd503029949add9dc6586de67164bb69c2c09588cdcc9719',
  size: 256, mean: [0.5, 0.5, 0.5], std: [0.5, 0.5, 0.5], output: 'pooler_output' };

// Downloads a pinned file once into build/.cache and checks its sha256. -> local path
export async function pinned(src, file, sha256) {
  if (!fs.existsSync(file) || crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') !== sha256) {
    console.log(`downloading ${src}`);
    const r = await fetch(src);
    if (!r.ok) throw new Error(`${src}: HTTP ${r.status}`);
    const buf = Buffer.from(await r.arrayBuffer());
    const got = crypto.createHash('sha256').update(buf).digest('hex');
    if (got !== sha256) throw new Error(`${src}: sha256 ${got}, want ${sha256}`);
    fs.mkdirSync(file.slice(0, file.lastIndexOf('/')), { recursive: true });
    fs.writeFileSync(file, buf);
  }
  return file;
}
// -> path of the weight-only int8 vision tower (converted once, cached next to the fp32 download)
export async function visionModel() {
  const dir = `build/.cache/${IMAGE_MODEL}/${IMAGE_MODEL_REV}`, out = `${dir}/onnx/vision_model_wo8.onnx`;
  const fp32 = await pinned(`https://huggingface.co/${IMAGE_MODEL}/resolve/${IMAGE_MODEL_REV}/${VISION.file}`, `${dir}/${VISION.file}`, VISION.sha256);
  if (!fs.existsSync(out) || fs.statSync(out).mtimeMs < fs.statSync('tools/quantize-vision.mjs').mtimeMs) {
    fs.writeFileSync(out, weightOnlyInt8(new Uint8Array(fs.readFileSync(fp32))));
  }
  return out;
}

const norm = (v) => { let s = 0; for (const x of v) s += x * x; s = Math.sqrt(s) || 1; return v.map((x) => x / s); };

// items: [{ title, type, characters }] in row order
export async function buildClipText(items) {
  const prompts = items.map(textPrompts);
  const hash = crypto.createHash('sha1').update(JSON.stringify([IMAGE_MODEL, prompts, NEGATIVES, MEDIA])).digest('hex').slice(0, 16);
  const cache = `build/clip-text-${hash}.json`;
  if (fs.existsSync(cache)) return JSON.parse(fs.readFileSync(cache, 'utf8'));
  const tok = await AutoTokenizer.from_pretrained(IMAGE_MODEL, { revision: IMAGE_MODEL_REV });
  const model = await SiglipTextModel.from_pretrained(IMAGE_MODEL, { revision: IMAGE_MODEL_REV, dtype: 'fp16' });
  // SigLIP's text tower was trained on lowercase text padded to 64 tokens
  const embed = async (texts) => {
    const out = [];
    for (let i = 0; i < texts.length; i += 64) {
      const batch = texts.slice(i, i + 64).map((t) => t.toLowerCase());
      const { pooler_output: e } = await model(tok(batch, { padding: 'max_length', truncation: true, max_length: 64 }));
      const d = e.dims[1];
      batch.forEach((_, j) => out.push(norm(Array.from(e.data.slice(j * d, (j + 1) * d)))));
      if (i % 6400 === 0) console.log(`title text ${i}/${texts.length}`);
    }
    return out;
  };
  const embs = await embed(prompts.flat());
  let k = 0;
  const rows = prompts.map((p) => { const vs = embs.slice(k, k += p.length); return norm(vs[0].map((_, j) => vs.reduce((a, v) => a + v[j], 0))); });
  const r5 = (v) => v.map((x) => +x.toFixed(5));
  const out = { dim: rows[0].length, rows, neg: (await embed(NEGATIVES)).map(r5), media: (await embed(MEDIA)).map(r5) };
  fs.mkdirSync('build', { recursive: true });
  fs.writeFileSync(cache, JSON.stringify(out));
  return out;
}

// -> { bin: Int8Array (n*dim), meta }
export function packClipText({ dim, rows, neg, media }, rowGroup, rowFamily, cut) {
  const bin = new Int8Array(rows.length * dim);
  rows.forEach((r, i) => r.forEach((x, j) => { bin[i * dim + j] = Math.max(-127, Math.min(127, Math.round(x * 127))); }));
  return { bin, meta: { n: rows.length, dim, neg, media, rowGroup, rowFamily, ...cut } };
}

// One row per distinct title/series name, most popular first. Prompt type/characters from its most popular work.
export function clipRows({ meta, titleGroups, works }, n) {
  const items = [], rowGroup = [], labels = new Set();
  for (const g of titleGroups) {
    const [label, w0] = meta.groups[g];
    if (labels.has(label)) continue;
    labels.add(label);
    items.push({ title: label, type: works[w0].type, characters: works[w0].characters });
    rowGroup.push(g);
    if (items.length >= n) break;
  }
  return { items, rowGroup };
}

// Rows whose groups share a work (directly or transitively: "Star Wars" series row and the Episode IV row) form
// one family; the title-confidence gap is measured against the best row of a different family.
export function rowFamilies(groups, rowGroup) {
  const parent = rowGroup.map((_, i) => i);
  const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const byWork = new Map();
  rowGroup.forEach((g, r) => {
    for (const w of groups[g].slice(1)) {
      if (byWork.has(w)) parent[find(r)] = find(byWork.get(w));
      else byWork.set(w, r);
    }
  });
  return rowGroup.map((_, r) => find(r));
}
