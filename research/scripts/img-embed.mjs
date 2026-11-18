// Embeds (1) text prompts for title rows and (2) all eval images with one image-text model; caches to results/emb/<tag>.json
// usage: node scripts/img-embed.mjs <model-id under models/hf> [rowsN=2000]
import fs from 'node:fs';
import path from 'node:path';
import { env, AutoTokenizer, AutoProcessor, RawImage, CLIPTextModelWithProjection, CLIPVisionModelWithProjection, SiglipTextModel, SiglipVisionModel } from '@huggingface/transformers';
import { textPrompts, NEGATIVES, MEDIA } from '../../tools/clip-prompts.mjs';
const R = path.resolve(import.meta.dirname, '..');
env.allowRemoteModels = false; env.localModelPath = R + '/models/hf/';
const [id, N0 = 2000] = process.argv.slice(2);
const t00 = performance.now();
const sig = /siglip/i.test(id);
const tag = id.split('/').pop() + (process.env.TAG ?? '');
const { rows } = JSON.parse(fs.readFileSync(R + '/results/rows.json'));
const imgs = JSON.parse(fs.readFileSync(R + '/results/images.json')); // [{file, want}]
const wants = new Set(imgs.map((x) => x.want).filter(Boolean));
const use = rows.map((r, i) => i).filter((i) => i < +N0 || wants.has(rows[i].title));
const norm = (v) => { let s = 0; for (const x of v) s += x * x; s = Math.sqrt(s) || 1; return Array.from(v, (x) => x / s); };
const rss = () => Math.round(process.memoryUsage().rss / 1e6);
const tok = await AutoTokenizer.from_pretrained(id);
const tm = await (sig ? SiglipTextModel : CLIPTextModelWithProjection).from_pretrained(id, { dtype: process.env.TD ?? 'q8' });
async function embT(texts) {
  const out = [];
  for (let i = 0; i < texts.length; i += 32) {
    const b = texts.slice(i, i + 32);
    const o = await tm(tok(sig ? b.map((x) => x.toLowerCase()) : b, sig ? { padding: 'max_length', max_length: 64, truncation: true } : (/mobileclip/i.test(id) ? { padding: 'max_length', truncation: true, max_length: 77 } : { padding: true, truncation: true, max_length: 77 })));
    const e = sig ? o.pooler_output : o.text_embeds, d = e.dims[1];
    b.forEach((_, j) => out.push(norm(e.data.slice(j * d, (j + 1) * d))));
  }
  return out;
}
let t = performance.now();
const rowEmb = [];
for (const i of use) { const vs = await embT(textPrompts(rows[i])); rowEmb.push(norm(vs[0].map((_, j) => vs.reduce((a, v) => a + v[j], 0)))); }
const neg = await embT(NEGATIVES), media = await embT(MEDIA);
console.log(tag, 'text rows', use.length, 'ms', Math.round(performance.now() - t), 'rss', rss());
await tm.dispose?.();
const proc = await AutoProcessor.from_pretrained(id);
const vm = await (sig ? SiglipVisionModel : CLIPVisionModelWithProjection).from_pretrained(id, { dtype: process.env.VD ?? 'q8' });
const imgEmb = {}; const times = [];
for (const { file } of imgs) {
  let img; try { img = await RawImage.read(file); } catch { console.log('skip unreadable', file); continue; }
  const x = await proc(img);
  t = performance.now();
  const o = await vm(x);
  times.push(performance.now() - t);
  imgEmb[file] = norm((sig ? o.pooler_output : o.image_embeds).data);
}
times.sort((a, b) => a - b);
console.log(tag, 'images', imgs.length, 'median vision ms (onnxruntime-node, all cores)', Math.round(times[times.length >> 1]), 'rss', rss());
fs.mkdirSync(R + '/results/emb', { recursive: true });
fs.writeFileSync(`${R}/results/emb/${tag}.json`, JSON.stringify({ id, rowIdx: use, rowEmb, neg, media, imgEmb }));
