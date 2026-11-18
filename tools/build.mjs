// Builds dist/firefox and dist/chrome from one source tree.
// usage: node tools/build.mjs [catalog.json=data/catalog.json] [--clip-n=2000]
import fs from 'node:fs';
import path from 'node:path';
import { buildIndex } from './build-index.mjs';
import { createHash } from 'node:crypto';
import { TYPES, EXCLUDE, qid, subclassQuery } from '../src/shared/catalog-rules.js';
import { buildClipText, packClipText, clipRows, rowFamilies, pinned, visionModel, VISION } from './build-clip-text.mjs';

const args = process.argv.slice(2);
const catalogPath = args.find((a) => !a.startsWith('--')) ?? 'data/catalog.json';
const clipN = +(args.find((a) => a.startsWith('--clip-n='))?.split('=')[1] ?? 2000); // chosen with tools/calibrate-clip.mjs
// Image verdict cut-offs from tools/calibrate-clip.mjs (SB_RESEARCH=research, real catalog): an image is named after its
// best title row when that row scores at least `minScore`, beats the best generic "ordinary photo" prompt by `margin`
// and the best row of an unrelated title family by `titleGap`; otherwise it is "unidentified media" when the media
// prompts beat the generic ones by `mediaGate`.
// Held out (two-fold, 397 media / 466 ordinary images, N=2000): 28 right, 4 wrong titles, 0 ordinary photos named.
const CUT = { minScore: 0.1161, margin: 0.061, titleGap: 0.0275, mediaGate: 0.0514 };
// PP-OCR v5 mobile (Apache-2.0, PaddleOCR) as converted to ONNX by RapidOCR, pinned by release and sha256.
const OCR_BASE = 'https://www.modelscope.cn/models/RapidAI/RapidOCR/resolve/v3.10.0/onnx/PP-OCRv5';
const OCR_MODELS = {
  'det.onnx': [`${OCR_BASE}/det/ch_PP-OCRv5_det_mobile.onnx`, '4d97c44a20d30a81aad087d6a396b08f786c4635742afc391f6621f5c6ae78ae'],
  'rec.onnx': [`${OCR_BASE}/rec/en_PP-OCRv5_rec_mobile.onnx`, 'c3461add59bb4323ecba96a492ab75e06dda42467c9e3d0c18db5d1d21924be8'],
};

if (!fs.existsSync(catalogPath)) {
  console.error(`catalog not found: ${catalogPath} (use \`npm run build:fixture\` for the test catalog)`);
  process.exit(1);
}
const catalog = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));
console.log(`catalog ${catalogPath}: ${catalog.works.length} works`);

// ---- generated data (shared by both targets) ----
const data = 'build/data';
fs.rmSync(data, { recursive: true, force: true });
fs.mkdirSync(data, { recursive: true });
const built = buildIndex(catalog);
const { bin, meta, keys } = built;
fs.writeFileSync(`${data}/index.bin`, Buffer.from(bin));
fs.writeFileSync(`${data}/index.json`, JSON.stringify(meta));
console.log(`index: ${keys} keys, ${meta.groups.length} groups, ${(bin.byteLength / 1e6).toFixed(1)} MB bin`);

// the N most popular title rows (embedded once, cached in build/, shared with tools/calibrate-clip.mjs)
const { items, rowGroup } = clipRows(built, clipN);
const clip = packClipText(await buildClipText(items), rowGroup, rowFamilies(meta.groups, rowGroup),
  { ...CUT, size: VISION.size, mean: VISION.mean, std: VISION.std, output: VISION.output });
fs.writeFileSync(`${data}/clip-text.bin`, Buffer.from(clip.bin.buffer));
fs.writeFileSync(`${data}/clip-meta.json`, JSON.stringify(clip.meta));
console.log(`image title matrix: ${clip.meta.n} names`);

// Inputs of the opt-in catalog update (src/background/catalog-update.js): the bundled catalog it merges into, the
// common-word list of the ambiguity rules, the class list of the seven work types (same roots/subclasses as
// tools/catalog/build.mjs), and the bundled catalog's date, from which the update's delta window is computed.
fs.copyFileSync(catalogPath, `${data}/catalog.json`);
fs.copyFileSync('tools/catalog/20k.txt', `${data}/common-words.txt`);
fs.writeFileSync(`${data}/catalog-classes.json`, JSON.stringify(await catalogClasses()));
fs.writeFileSync(`${data}/catalog-info.json`, JSON.stringify({ builtAt: fs.statSync(catalogPath).mtime.toISOString(), works: catalog.works.length }));

// runtime model files, pinned (the spoiler classifier ships from models/spoiler, see tools/train-spoiler.mjs)
const visionFile = await visionModel();
for (const [name, [src, sha]] of Object.entries(OCR_MODELS)) await pinned(src, `build/.cache/ocr/${sha.slice(0, 16)}-${name}`, sha);

// ---- assemble ----
const cp = (from, to) => { fs.mkdirSync(path.dirname(to), { recursive: true }); fs.cpSync(from, to, { recursive: true }); };
const nm = 'node_modules';
const transformers = fs.readFileSync(`${nm}/@huggingface/transformers/dist/transformers.web.min.js`, 'utf8')
  .replace(/from\s*"onnxruntime-(web|common)"/g, 'from"./ort.wasm.bundle.min.mjs"');

for (const target of ['firefox', 'chrome']) {
  const out = `dist/${target}`;
  fs.rmSync(out, { recursive: true, force: true });
  cp('src', `${out}/src`);
  cp(data, `${out}/data`);
  cp(`${nm}/onnxruntime-web/dist/ort.wasm.bundle.min.mjs`, `${out}/vendor/ort.wasm.bundle.min.mjs`);
  cp(`${nm}/onnxruntime-web/dist/ort-wasm-simd-threaded.wasm`, `${out}/vendor/ort-wasm-simd-threaded.wasm`);
  cp(`${nm}/onnxruntime-web/dist/ort-wasm-simd-threaded.mjs`, `${out}/vendor/ort-wasm-simd-threaded.mjs`);
  fs.writeFileSync(`${out}/vendor/transformers.js`, transformers);
  cp(visionFile, `${out}/models/vision/model.onnx`);
  for (const [name, [, sha]] of Object.entries(OCR_MODELS)) cp(`build/.cache/ocr/${sha.slice(0, 16)}-${name}`, `${out}/models/ocr/${name}`);
  cp('models/ocr/dict.txt', `${out}/models/ocr/dict.txt`);
  cp('models/spoiler', `${out}/models/spoiler`);

  const manifest = JSON.parse(fs.readFileSync('manifest.json', 'utf8'));
  if (target === 'chrome') {
    delete manifest.browser_specific_settings;
    manifest.background = { service_worker: 'src/background/background.js', type: 'module' };
    manifest.permissions.push('offscreen');
    // cross-origin isolation gives the offscreen document SharedArrayBuffer, i.e. multi-threaded WASM inference
    manifest.cross_origin_embedder_policy = { value: 'require-corp' };
    manifest.cross_origin_opener_policy = { value: 'same-origin' };
    // popup.js uses the promise-based `browser.*` namespace; alias it to chrome.* (promise-returning in MV3)
    fs.writeFileSync(`${out}/src/popup/browser-shim.js`, 'globalThis.browser ??= chrome;\n');
    const html = fs.readFileSync(`${out}/src/popup/popup.html`, 'utf8');
    fs.writeFileSync(`${out}/src/popup/popup.html`, html.replace(/<script\b/, '<script src="browser-shim.js"></script>\n  <script'));
  } else {
    fs.rmSync(`${out}/src/background/offscreen.html`);
    fs.rmSync(`${out}/src/background/offscreen.js`);
  }
  fs.writeFileSync(`${out}/manifest.json`, JSON.stringify(manifest, null, 2));
  console.log(`built ${out}`);
}

// type -> class QIDs (roots + P279+ subclasses of the deep roots, minus excluded), from the catalog build's query cache
async function catalogClasses() {
  const out = {};
  for (const [type, { roots, deep }] of Object.entries(TYPES)) {
    const set = new Set(roots);
    for (const root of deep) {
      const q = subclassQuery(root), f = `tools/catalog/cache/${createHash('sha1').update(q).digest('hex')}.json`;
      let rows;
      if (fs.existsSync(f)) rows = JSON.parse(fs.readFileSync(f, 'utf8'));
      else {
        const r = await fetch('https://query.wikidata.org/sparql', { method: 'POST', body: new URLSearchParams({ query: q }),
          headers: { 'User-Agent': 'spolierblock-build/1.0', Accept: 'application/sparql-results+json' } });
        rows = (await r.json()).results.bindings;
      }
      for (const r of rows) set.add(qid(r.c.value));
    }
    for (const x of EXCLUDE) set.delete(x);
    out[type] = [...set];
  }
  return out;
}
