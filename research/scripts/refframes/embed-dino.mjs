// The same frames as embed.mjs (the file lists of research/data/refframes/emb/<id>.json), embedded with DINOv2 base
// (onnx-community/dinov2-base, fp32, research/models/dinov2-base/model.onnx) instead of the product's SigLIP 2 tower:
// is a self-supervised model better at telling works apart? Whole frame, no crop: short side 224, long side the
// nearest multiple of 14 up to 392 (16:9 -> 224 x 392), bicubic, ImageNet mean/std.
// Writes emb-dino-cls/ (CLS token) and emb-dino-mean/ (mean of the patch tokens), both L2-normalised, n x 768,
// with the json of emb/ copied so analyze.mjs and upper.mjs read them through EMB=.
// usage (repo root): flock ~/.cache/sb-heavy.lock node research/scripts/refframes/embed-dino.mjs
import fs from 'node:fs';
import sharp from 'sharp';
import * as ort from 'onnxruntime-node';

const D = 'research/data/refframes', E = `${D}/emb`, OUT = { cls: `${D}/emb-dino-cls`, mean: `${D}/emb-dino-mean` };
for (const d of Object.values(OUT)) fs.mkdirSync(d, { recursive: true });
const sess = await ort.InferenceSession.create('research/models/dinov2-base/model.onnx', { intraOpNumThreads: 6 });
const MEAN = [0.485, 0.456, 0.406], STD = [0.229, 0.224, 0.225], DIM = 768;
const side = (r) => Math.max(224, Math.min(392, Math.round(224 * r / 14) * 14));
const norm = (v) => { const n = Math.hypot(...v); return v.map((a) => a / n); };

for (const j of fs.readdirSync(E).filter((f) => f.endsWith('.json'))) {
  const id = j.slice(0, -5);
  if (fs.existsSync(`${OUT.mean}/${id}.json`)) continue;
  const { files } = JSON.parse(fs.readFileSync(`${E}/${j}`, 'utf8'));
  const cls = new Float32Array(files.length * DIM), mean = new Float32Array(files.length * DIM);
  for (const [k, f] of files.entries()) {
    const m = await sharp(f).metadata();
    const w = m.width >= m.height ? side(m.width / m.height) : 224, h = m.width >= m.height ? 224 : side(m.height / m.width);
    const px = await sharp(f).removeAlpha().toColourspace('srgb').resize(w, h, { fit: 'fill', kernel: 'cubic' }).raw().toBuffer();
    const x = new Float32Array(3 * h * w);
    for (let p = 0; p < h * w; p++) for (let c = 0; c < 3; c++) x[c * h * w + p] = (px[p * 3 + c] / 255 - MEAN[c]) / STD[c];
    const o = (await sess.run({ pixel_values: new ort.Tensor('float32', x, [1, 3, h, w]) })).last_hidden_state;
    const n = o.dims[1], a = new Float32Array(DIM);
    for (let t = 1; t < n; t++) for (let i = 0; i < DIM; i++) a[i] += o.data[t * DIM + i];
    cls.set(norm(o.data.slice(0, DIM)), k * DIM);
    mean.set(norm(a), k * DIM);
  }
  for (const [d, v] of [[OUT.cls, cls], [OUT.mean, mean]]) {
    fs.writeFileSync(`${d}/${id}.f32`, Buffer.from(v.buffer));
    fs.copyFileSync(`${E}/${j}`, `${d}/${j}`);
  }
  console.log(id, files.length);
}
