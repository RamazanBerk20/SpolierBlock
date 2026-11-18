// Benchmarks candidate CLIP models on test/fixtures/images: accuracy (node, onnxruntime-node) and
// vision latency/RAM with onnxruntime-web WASM single-thread (what the extension uses).
// usage: node tools/bench-clip.mjs <hf-model-id> [catalog]
import { env, AutoTokenizer, CLIPTextModelWithProjection, CLIPVisionModelWithProjection, AutoProcessor, RawImage } from '@huggingface/transformers';
import fs from 'node:fs';
import path from 'node:path';
env.cacheDir = 'build/.cache';
const model = process.argv[2] ?? 'Xenova/clip-vit-base-patch32';
const catalog = JSON.parse(fs.readFileSync(process.argv[3] ?? 'test/fixtures/catalog.small.json', 'utf8'));
const { textPrompts, NEGATIVES } = await import('./clip-prompts.mjs');

const tok = await AutoTokenizer.from_pretrained(model);
const textModel = await CLIPTextModelWithProjection.from_pretrained(model, { dtype: 'q8' });
const norm = (v) => { let s = 0; for (const x of v) s += x * x; s = Math.sqrt(s); return v.map((x) => x / s); };
async function embedText(texts) {
  const inp = tok(texts, { padding: 'max_length', truncation: true, max_length: 77 });
  const { text_embeds } = await textModel(inp);
  const d = text_embeds.dims[1];
  return texts.map((_, i) => norm(Array.from(text_embeds.data.slice(i * d, (i + 1) * d))));
}
const avg = (vs) => norm(vs[0].map((_, j) => vs.reduce((a, v) => a + v[j], 0) / vs.length));
const works = [];
for (const w of catalog.works) works.push({ w, e: avg(await embedText(textPrompts(w))) });
const negs = await embedText(NEGATIVES);

const proc = await AutoProcessor.from_pretrained(model);
const vis = await CLIPVisionModelWithProjection.from_pretrained(model, { dtype: 'q8' });
const dot = (a, b) => a.reduce((s, x, i) => s + x * b[i], 0);
const dir = 'test/fixtures/images';
const expect = { starwars: 'Star Wars', got: 'Game of Thrones', pacman: 'Pac-Man', hp: 'Harry Potter', mario: 'Super Mario Bros.', minecraft: 'Minecraft', simpsons: 'The Simpsons', lotr: 'The Lord of the Rings', pokemon: 'Pokémon' };
for (const f of fs.readdirSync(dir).sort()) {
  const img = await RawImage.read(path.join(dir, f));
  const { image_embeds } = await vis(await proc(img));
  const e = norm(Array.from(image_embeds.data));
  const scored = works.map(({ w, e: t }) => [dot(e, t), w.title]).sort((a, b) => b[0] - a[0]);
  const n = Math.max(...negs.map((t) => dot(e, t)));
  const want = f.startsWith('spoiler_') ? expect[f.split(/[_.]/)[1]] : '-';
  const all=[...scored.map(x=>x[0]),...negs.map(t=>dot(e,t))].map(x=>Math.exp(100*x)); const P=all[0]/all.reduce((a,b)=>a+b,0);
  console.log('P',P.toFixed(2), f.padEnd(32), want.padEnd(18), scored[0][1].padEnd(22), scored[0][0].toFixed(3), 'neg', n.toFixed(3), 'margin', (scored[0][0] - n).toFixed(3), '| 2nd', scored[1][1], scored[1][0].toFixed(3));
}
