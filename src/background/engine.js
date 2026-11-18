// Local inference engine: CLIP image matching, OCR and the plot-spoiler text classifier.
// Runs in a document context: the Firefox event page, or the Chrome offscreen document.
// Everything is loaded from the extension package; no network access besides refetching page images.
import { env, AutoTokenizer, CLIPVisionModelWithProjection, Tensor } from '../../vendor/transformers.js';
import * as ort from '../../vendor/ort.wasm.bundle.min.mjs'; // the same module instance transformers.js uses

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
  const get = () => (p ??= fn().catch((e) => { p = null; throw e; }));
  get.reset = () => { const old = p; p = null; return old; };
  return get;
};
const getJSON = (p) => fetch(url(p)).then((r) => r.json());

// ---------- priority queue: lower prio first, FIFO within a prio ----------
// prio: classifier -1; per image: in-viewport CLIP 0, its OCR 1, off-viewport CLIP 2, OCR 3.
const queue = [];
let running = false;
function enqueue(prio, fn) {
  return new Promise((res, rej) => { queue.push({ prio, fn, res, rej }); pump(); });
}
async function pump() {
  if (running) return;
  running = true;
  while (queue.length) {
    let k = 0;
    for (let i = 1; i < queue.length; i++) if (queue[i].prio < queue[k].prio) k = i;
    const [j] = queue.splice(k, 1);
    try { j.res(await j.fn()); } catch (e) { j.rej(e); }
  }
  running = false;
}

// ---------- images ----------
const blobs = new Map(); // key -> Promise<Blob|null>, small LRU so OCR reuses CLIP's download
function blob(key, src) {
  if (!blobs.has(key)) {
    blobs.set(key, fetch(src, { credentials: 'omit', cache: 'force-cache' }).then((r) => (r.ok ? r.blob() : null)).catch(() => null));
    if (blobs.size > 24) blobs.delete(blobs.keys().next().value);
  }
  return blobs.get(key);
}
const bitmap = (key, src) => blob(key, src).then((b) => (b ? createImageBitmap(b) : null)).catch(() => null);

const clip = once(async () => {
  const [meta, bin, vision] = await Promise.all([
    getJSON('data/clip-meta.json'),
    fetch(url('data/clip-text.bin')).then((r) => r.arrayBuffer()),
    CLIPVisionModelWithProjection.from_pretrained('clip', { dtype: 'q8' }),
  ]);
  return { meta, mat: new Int8Array(bin), vision };
});

const MEAN = [0.48145466, 0.4578275, 0.40821073], STD = [0.26862954, 0.26130258, 0.27577711];
const verdictCache = new Map(); // key -> hits: [[groupIdx, score]...]
async function clipCheck(key, src) {
  if (verdictCache.has(key)) return verdictCache.get(key);
  const bmp = await bitmap(key, src);
  let hits = [];
  if (bmp) {
    const { meta, mat, vision } = await clip();
    // CLIP preprocessing: center square crop, resize to 224, normalize.
    const S = 224, side = Math.min(bmp.width, bmp.height);
    const ctx = new OffscreenCanvas(S, S).getContext('2d', { willReadFrequently: true });
    ctx.drawImage(bmp, (bmp.width - side) / 2, (bmp.height - side) / 2, side, side, 0, 0, S, S);
    const px = ctx.getImageData(0, 0, S, S).data, x = new Float32Array(3 * S * S);
    for (let i = 0; i < S * S; i++) for (let c = 0; c < 3; c++) x[c * S * S + i] = (px[i * 4 + c] / 255 - MEAN[c]) / STD[c];
    const { image_embeds: e } = await vision({ pixel_values: new Tensor('float32', x, [1, 3, S, S]) });
    const v = e.data;
    let n2 = 0; for (const a of v) n2 += a * a;
    const inv = 1 / Math.sqrt(n2), D = meta.dim;
    let neg = -1;
    for (const t of meta.neg) { let s = 0; for (let j = 0; j < D; j++) s += t[j] * v[j]; neg = Math.max(neg, s * inv); }
    // media gate: the image must look like a poster/still/screenshot/cosplay more than like an everyday photo
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
    if (scores.length) {
      // Title confidence: best row vs the best row of an unrelated title family (all rows, not only passing ones).
      const [top, best] = scores[0], fam = meta.rowFamily[top];
      let second = -1;
      for (let r = 0; r < meta.n; r++) {
        if (meta.rowFamily[r] === fam) continue;
        let s = 0; const o = r * D;
        for (let j = 0; j < D; j++) s += mat[o + j] * v[j];
        second = Math.max(second, s * inv / 127);
      }
      // group -1 = media image whose title is not certain: blocked as "unrecognised", never offered as "I've seen"
      hits = best - second >= meta.titleGap ? scores.slice(0, 3).map(([r, s]) => [meta.rowGroup[r], s]) : [[-1, best]];
    }
    if (hits.length) console.debug('[SpolierBlocker] clip', key.slice(0, 80), hits, 'neg', neg.toFixed(3));
  }
  verdictCache.set(key, hits);
  if (verdictCache.size > 2000) verdictCache.delete(verdictCache.keys().next().value);
  return hits;
}

// ---------- OCR ----------
const ocrWorker = once(async () => {
  const { createWorker } = (await import('../../vendor/tesseract/tesseract.esm.min.js')).default;
  return createWorker('eng', 1, {
    workerPath: url('vendor/tesseract/worker.min.js'),
    corePath: url('vendor/tesseract/tesseract-core-simd-lstm.wasm.js'),
    langPath: url('vendor/tesseract'),
    workerBlobURL: false,
    cacheMethod: 'none',
    gzip: true,
  });
});
async function ocr(key, src) {
  const b = await blob(key, src);
  if (!b) return '';
  const w = await ocrWorker();
  let data;
  // The fetched bytes go to tesseract as-is. Re-encoding through OffscreenCanvas.convertToBlob() cost ~+1 s per
  // image in Chrome's offscreen document whenever no extension page was in the foreground (async encode task
  // throttled in the hidden document; measured in test/e2e logs), which pushed OCR verdicts past 20 s.
  try { ({ data } = await w.recognize(b)); } catch {
    const bmp = await createImageBitmap(b); // formats tesseract cannot decode (e.g. webp): re-encode as PNG
    const c = new OffscreenCanvas(bmp.width, bmp.height);
    c.getContext('2d').drawImage(bmp, 0, 0);
    ({ data } = await w.recognize(await c.convertToBlob()));
  }
  return data.confidence >= 60 ? data.text.trim() : ''; // photos without text yield low-confidence garbage
}

// A stuck recognition must not block the queue: give up after OCR_RUN_MS and start a fresh worker next time.
const OCR_RUN_MS = 10000;
function ocrWithTimeout(key, src) {
  let timer;
  return Promise.race([ocr(key, src), new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('ocr timeout')), OCR_RUN_MS); })])
    .catch(async (e) => {
      if (e.message === 'ocr timeout') { const w = ocrWorker.reset(); w?.then((x) => x.terminate()).catch(() => {}); }
      throw e;
    })
    .finally(() => clearTimeout(timer));
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
    case 'img.check': return enqueue(p, () => clipCheck(msg.key, msg.url)).then((hits) => ({ hits }));
    case 'img.ocr': return enqueue(p + 1, () => ocrWithTimeout(msg.key, msg.url)).then((text) => ({ text }));
    case 'text.classify': return enqueue(-1, () => classify(msg.text));
  }
  return null;
}
