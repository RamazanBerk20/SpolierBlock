// Precomputes CLIP text embeddings for name groups (int8 rows, one per distinct title/series name; row -> group via
// meta.rowGroup) plus the generic negative prompts (float32). Cached in build/ keyed by the prompt list hash.
import { env, AutoTokenizer, CLIPTextModelWithProjection } from '@huggingface/transformers';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { textPrompts, NEGATIVES, MEDIA } from './clip-prompts.mjs';
env.cacheDir = 'build/.cache';
export const CLIP_MODEL = 'Xenova/clip-vit-base-patch32';

const norm = (v) => { let s = 0; for (const x of v) s += x * x; s = Math.sqrt(s) || 1; return v.map((x) => x / s); };

// items: [{ title, type, characters }] in row order
export async function buildClipText(items) {
  const prompts = items.map(textPrompts);
  const hash = crypto.createHash('sha1').update(JSON.stringify([CLIP_MODEL, prompts, NEGATIVES])).digest('hex').slice(0, 16);
  const cache = `build/clip-text-${hash}.json`;
  const tok = await AutoTokenizer.from_pretrained(CLIP_MODEL);
  const model = await CLIPTextModelWithProjection.from_pretrained(CLIP_MODEL, { dtype: 'q8' });
  const media = async () => {
    const { text_embeds } = await model(tok(MEDIA, { padding: true, truncation: true, max_length: 77 }));
    const d = text_embeds.dims[1];
    return MEDIA.map((_, j) => norm(Array.from(text_embeds.data.slice(j * d, (j + 1) * d))).map((x) => +x.toFixed(5)));
  };
  if (fs.existsSync(cache)) return { ...JSON.parse(fs.readFileSync(cache, 'utf8')), media: await media() };
  const flat = prompts.flat().concat(NEGATIVES);
  const embs = [];
  for (let i = 0; i < flat.length; i += 64) {
    const batch = flat.slice(i, i + 64);
    const { text_embeds } = await model(tok(batch, { padding: true, truncation: true, max_length: 77 }));
    const d = text_embeds.dims[1];
    batch.forEach((_, j) => embs.push(norm(Array.from(text_embeds.data.slice(j * d, (j + 1) * d)))));
    if (i % 6400 === 0) console.log(`clip text ${i}/${flat.length}`);
  }
  let k = 0;
  const rows = prompts.map((p) => { const vs = embs.slice(k, k += p.length); return norm(vs[0].map((_, j) => vs.reduce((a, v) => a + v[j], 0))); });
  const out = { dim: rows[0].length, rows, neg: embs.slice(k).map((v) => v.map((x) => +x.toFixed(5))) };
  fs.mkdirSync('build', { recursive: true });
  fs.writeFileSync(cache, JSON.stringify(out));
  return { ...out, media: await media() };
}

// -> { bin: Int8Array (n*dim), meta }
export function packClipText({ dim, rows, neg, media }, rowGroup, rowFamily, minScore, margin, mediaGate, titleGap) {
  const bin = new Int8Array(rows.length * dim);
  rows.forEach((r, i) => r.forEach((x, j) => { bin[i * dim + j] = Math.max(-127, Math.min(127, Math.round(x * 127))); }));
  // minScore/margin: cosine of the best row must exceed minScore and beat the best generic negative prompt by
  // margin; calibrated by tools/calibrate-clip.mjs against the real catalog.
  return { bin, meta: { n: rows.length, dim, neg, media, rowGroup, rowFamily, minScore, margin, mediaGate, titleGap } };
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
