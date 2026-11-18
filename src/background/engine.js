// Local inference engine: image titles (SigLIP 2 vision tower vs precomputed title rows), OCR (PP-OCR) and the
// plot-spoiler text classifier. Runs in a document context: the Firefox event page, or the Chrome offscreen document.
// Everything is loaded from the extension package; no network access besides refetching page images.
import { env, AutoTokenizer } from '../../vendor/transformers.js';
import * as ort from '../../vendor/ort.wasm.bundle.min.mjs'; // the same module instance transformers.js uses
import { recognize } from './ocr.js';

const api = globalThis.browser ?? globalThis.chrome;
const url = (p) => api.runtime.getURL(p);
env.allowRemoteModels = false;
env.allowLocalModels = true;
env.localModelPath = url('models/');
env.useBrowserCache = false;
env.backends.onnx.wasm.wasmPaths = url('vendor/');
// WASM threads need SharedArrayBuffer, i.e. a cross-origin isolated page: the Chrome build is (COEP/COOP in its
// manifest; 4 threads measured fastest), Firefox extension pages cannot be, so they run single-threaded.
env.backends.onnx.wasm.numThreads = globalThis.crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency || 1) : 1;

const once = (fn) => {
  let p;
  return () => (p ??= fn().catch((e) => { p = null; throw e; }));
};
const getJSON = (p) => fetch(url(p)).then((r) => r.json());
const session = (p, extra) => ort.InferenceSession.create(url(p), { executionProviders: ['wasm'], graphOptimizationLevel: 'all', extra });

// ---------- priority queue: lower prio first, FIFO within a prio ----------
// prio: classifier -1; per image: in-viewport title check 0, its OCR 1, off-viewport title check 2, OCR 3.
// Title checks waiting at the same prio run as one batch (up to TITLE_BATCH): the per-run weight dequantisation is
// shared (1 thread: 640 -> 465 ms per image at batch 4).
const queue = [], TITLE_BATCH = 4;
let running = false;
function enqueue(prio, fn, check) {
  return new Promise((res, rej) => { queue.push({ prio, fn, check, res, rej }); pump(); });
}
async function pump() {
  if (running) return;
  running = true;
  while (queue.length) {
    let k = 0;
    for (let i = 1; i < queue.length; i++) if (queue[i].prio < queue[k].prio) k = i;
    const [j] = queue.splice(k, 1);
    if (!j.check) { try { j.res(await j.fn()); } catch (e) { j.rej(e); } continue; }
    const batch = [j];
    for (let i = 0; i < queue.length && batch.length < TITLE_BATCH;) {
      if (queue[i].check && queue[i].prio === j.prio) batch.push(...queue.splice(i, 1)); else i++;
    }
    try { (await titleChecks(batch.map((x) => x.check))).forEach((hits, i) => batch[i].res(hits)); } catch (e) { batch.forEach((x) => x.rej(e)); }
  }
  running = false;
}

// ---------- images ----------
const blobs = new Map(); // key -> Promise<Blob|null>, small LRU so OCR reuses the title check's download
function blob(key, src) {
  if (!blobs.has(key)) {
    blobs.set(key, fetch(src, { credentials: 'omit', cache: 'force-cache' }).then((r) => (r.ok ? r.blob() : null)).catch(() => null));
    if (blobs.size > 24) blobs.delete(blobs.keys().next().value);
  }
  return blobs.get(key);
}
const bitmap = (key, src) => blob(key, src).then((b) => (b ? createImageBitmap(b) : null)).catch(() => null);
// RGBA pixels of the whole image scaled to w x h
function pixels(bmp, w, h) {
  const ctx = new OffscreenCanvas(w, h).getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bmp, 0, 0, w, h);
  return ctx.getImageData(0, 0, w, h);
}

const vision = once(async () => {
  const [meta, bin, sess] = await Promise.all([
    getJSON('data/clip-meta.json'),
    fetch(url('data/clip-text.bin')).then((r) => r.arrayBuffer()),
    // weight-only int8 (tools/quantize-vision.mjs), dequantised on every run. Folding the weights to fp32 at load
    // ({ session: { disable_quant_qdq: '1' } }) is 2.6x faster in Chrome but doubles the process to ~1 GB.
    session('models/vision/model.onnx'),
  ]);
  return { meta, mat: new Int8Array(bin), sess };
});

const verdictCache = new Map(); // key -> hits: [[groupIdx, score]...]
// [{ key, src }] -> [hits] in the same order
async function titleChecks(items) {
  const todo = items.filter((it) => !verdictCache.has(it.key));
  const bmps = await Promise.all(todo.map((it) => bitmap(it.key, it.src)));
  const ok = todo.filter((_, i) => bmps[i]), imgs = bmps.filter(Boolean);
  if (imgs.length) {
    const { meta, mat, sess } = await vision();
    // The whole image squashed to the model's square input (SigLIP's own preprocessing), normalised with mean/std.
    const S = meta.size, P = S * S, x = new Float32Array(imgs.length * 3 * P);
    imgs.forEach((bmp, b) => {
      const px = pixels(bmp, S, S).data;
      for (let i = 0; i < P; i++) for (let c = 0; c < 3; c++) x[(b * 3 + c) * P + i] = (px[i * 4 + c] / 255 - meta.mean[c]) / meta.std[c];
    });
    const out = (await sess.run({ [sess.inputNames[0]]: new ort.Tensor('float32', x, [imgs.length, 3, S, S]) }))[meta.output].data;
    ok.forEach((it, b) => verdictCache.set(it.key, verdict(meta, mat, out.subarray(b * meta.dim, (b + 1) * meta.dim), it.key)));
  }
  for (const it of todo) if (!verdictCache.has(it.key)) verdictCache.set(it.key, []);
  while (verdictCache.size > 2000) verdictCache.delete(verdictCache.keys().next().value);
  return items.map((it) => verdictCache.get(it.key) ?? []);
}
function verdict(meta, mat, v, key) {
  let n2 = 0; for (const a of v) n2 += a * a;
  const inv = 1 / Math.sqrt(n2), D = meta.dim;
  const best = (vs) => { let m = -1; for (const t of vs) { let s = 0; for (let j = 0; j < D; j++) s += t[j] * v[j]; m = Math.max(m, s * inv); } return m; };
  const neg = best(meta.neg), media = best(meta.media) - neg;
  // all title rows (int8): best row, and the best row of an unrelated title family
  const sc = new Float32Array(meta.n);
  let top = 0;
  for (let r = 0; r < meta.n; r++) {
    let s = 0; const o = r * D;
    for (let j = 0; j < D; j++) s += mat[o + j] * v[j];
    sc[r] = (s * inv) / 127;
    if (sc[r] > sc[top]) top = r;
  }
  let second = -1;
  for (let r = 0; r < meta.n; r++) if (meta.rowFamily[r] !== meta.rowFamily[top] && sc[r] > second) second = sc[r];
  const margin = sc[top] - neg, gap = sc[top] - second;
  let hits = [];
  if (sc[top] >= meta.minScore && margin >= meta.margin && gap >= meta.titleGap) {
    // a title: up to 3 groups of the best row's family (rows within the gap) that also clear the margin
    const rows = [];
    for (let r = 0; r < meta.n; r++) if (sc[r] - neg >= meta.margin && sc[top] - sc[r] < gap) rows.push(r);
    rows.sort((a, b) => sc[b] - sc[a]);
    hits = [...new Map(rows.map((r) => [meta.rowGroup[r], +sc[r].toFixed(3)]))].slice(0, 3);
  } else if (media >= meta.mediaGate) {
    hits = [[-1, +sc[top].toFixed(3)]]; // looks like film/show/game media, no certain title (covered only if settings.unknownImages)
  }
  if (hits.length) console.debug('[SpolierBlock] image', key.slice(0, 80), hits, 'margin', margin.toFixed(3), 'gap', gap.toFixed(3));
  return hits;
}

// ---------- OCR ----------
const ocrModels = once(async () => {
  const [det, rec, dict] = await Promise.all([session('models/ocr/det.onnx'), session('models/ocr/rec.onnx'),
    fetch(url('models/ocr/dict.txt')).then((r) => r.text())]);
  return { det, rec, chars: dict.split('\n') };
});
const OCR_SRC_MAX = 1280; // the recogniser crops from the image at this resolution at most
async function ocr(key, src) {
  const bmp = await bitmap(key, src);
  if (!bmp) return '';
  const m = await ocrModels();
  const s = Math.min(1, OCR_SRC_MAX / Math.max(bmp.width, bmp.height));
  const { text } = await recognize(ort, m, pixels(bmp, Math.max(1, Math.round(bmp.width * s)), Math.max(1, Math.round(bmp.height * s))));
  return text;
}

// ---------- spoiler classifier ----------
// all-MiniLM-L6-v2 fine-tuned end to end (tools/train-spoiler.mjs): one logit per sentence.
const classifier = once(async () => {
  const [meta, tok, sess] = await Promise.all([getJSON('models/spoiler/meta.json'), AutoTokenizer.from_pretrained('spoiler'),
    ort.InferenceSession.create(url('models/spoiler/model_int8.onnx'), { executionProviders: ['wasm'] })]);
  return { meta, tok, sess };
});
async function classify(text) {
  const { meta, tok, sess } = await classifier();
  // Per sentence: a single spoiler sentence in a long post must not be diluted by the rest.
  // @handles are absent from the training data; a bare handle line ("@gus") alone scores near the threshold
  const sents = text.split(/(?<=[.!?])\s+|\n+/).map((s) => s.replace(/@\w+/g, '').trim()).filter((s) => s.length > 3).slice(0, 16);
  if (!sents.length) return { spoiler: false, p: 0 };
  // one sentence per run: the int8 model quantizes activations per tensor, so padding/batching would shift scores
  let z = -Infinity;
  for (const s of sents) {
    const x = tok(s, { truncation: true, max_length: 64 });
    const t = (k) => new ort.Tensor('int64', x[k].data, x[k].dims);
    z = Math.max(z, (await sess.run({ input_ids: t('input_ids'), attention_mask: t('attention_mask') })).logit.data[0]);
  }
  const p = 1 / (1 + Math.exp(-z));
  return { spoiler: p >= meta.threshold, p: +p.toFixed(3) };
}

export function handle(msg) {
  const p = msg.prio === 0 ? 0 : 2;
  switch (msg.type) {
    case 'img.check': return enqueue(p, null, { key: msg.key, src: msg.url }).then((hits) => ({ hits }));
    case 'img.ocr': return enqueue(p + 1, () => ocr(msg.key, msg.url)).then((text) => ({ text }));
    case 'text.classify': return enqueue(-1, () => classify(msg.text));
  }
  return null;
}
