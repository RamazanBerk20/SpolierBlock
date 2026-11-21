// Embeds every extracted frame (research/data/refframes/frames/<id>/) and the easy-negative images with the product's
// image path: the shipped weight-only int8 SigLIP 2 vision tower (tools/build-clip-text.mjs visionModel), pixels.js
// squashCHW on sharp's decoded pixels (as tools/calibrate-clip.mjs), pooler_output L2-normalised.
// Cache: research/data/refframes/emb/<id>.json ({ files, luma }) + <id>.f32 (n x 768). Existing caches are kept.
// usage (repo root): flock ~/.cache/sb-heavy.lock node research/scripts/refframes/embed.mjs
import fs from 'node:fs';
import sharp from 'sharp';
import * as ort from 'onnxruntime-node';
import { squashCHW } from '../../../src/background/pixels.js';
import { visionModel, VISION } from '../../../tools/build-clip-text.mjs';

const D = 'research/data/refframes', E = `${D}/emb`;
fs.mkdirSync(E, { recursive: true });
const sets = fs.readdirSync(`${D}/frames`).filter((id) => fs.existsSync(`${D}/frames/${id}/.done`))
  .map((id) => [id, fs.readdirSync(`${D}/frames/${id}`).filter((f) => f.endsWith('.jpg')).sort().map((f) => `${D}/frames/${id}/${f}`)]);
// easy negatives: repo fixtures (ordinary photos and other works' media) and the research image sets
const easy = fs.readdirSync('test/fixtures/images').filter((f) => /\.(jpe?g|png|webp)$/i.test(f)).map((f) => `test/fixtures/images/${f}`);
for (const x of JSON.parse(fs.readFileSync('research/results/images.json', 'utf8'))) if (!x.src.startsWith('fixture')) easy.push(x.file);
const o2 = 'research/results/v2/data/ordinary2';
for (const f of fs.readdirSync(o2).filter((f) => f.endsWith('.jpg')).sort()) easy.push(`${o2}/${f}`);
sets.push(['easy', easy]);

const sess = await ort.InferenceSession.create(await visionModel(), { intraOpNumThreads: 6 });
const S = VISION.size, B = 8;
for (const [id, files] of sets) {
  if (fs.existsSync(`${E}/${id}.json`)) continue;
  const ok = [], luma = [], vecs = [];
  for (let i = 0; i < files.length; i += B) {
    const xs = [];
    for (const f of files.slice(i, i + B)) {
      try {
        const { data, info } = await sharp(f).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
        let l = 0, l2 = 0;
        for (let p = 0; p < data.length; p += 4) { const y = 0.299 * data[p] + 0.587 * data[p + 1] + 0.114 * data[p + 2]; l += y; l2 += y * y; }
        const n = data.length / 4;
        xs.push(squashCHW({ data, width: info.width, height: info.height }, S, VISION.mean, VISION.std));
        ok.push(f); luma.push([+(l / n).toFixed(1), +Math.sqrt(Math.max(0, l2 / n - (l / n) ** 2)).toFixed(1)]);
      } catch (e) { console.error('skip', f, e.message); }
    }
    if (!xs.length) continue;
    const x = new Float32Array(xs.length * 3 * S * S);
    xs.forEach((a, k) => x.set(a, k * a.length));
    const v = (await sess.run({ [sess.inputNames[0]]: new ort.Tensor('float32', x, [xs.length, 3, S, S]) }))[VISION.output].data;
    for (let k = 0; k < xs.length; k++) {
      const e = v.slice(k * 768, (k + 1) * 768), n = Math.hypot(...e);
      vecs.push(e.map((a) => a / n));
    }
  }
  const out = new Float32Array(vecs.length * 768);
  vecs.forEach((e, k) => out.set(e, k * 768));
  fs.writeFileSync(`${E}/${id}.f32`, Buffer.from(out.buffer));
  fs.writeFileSync(`${E}/${id}.json`, JSON.stringify({ files: ok, luma }));
  console.log(id, ok.length);
}
