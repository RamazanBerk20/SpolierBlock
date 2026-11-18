// tesseract.js (the shipped OCR, same settings as engine.js: eng, LSTM, confidence >= 60) on data/ocr. Node, single worker.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { score } from './ocr-score.mjs';
const R = path.resolve(import.meta.dirname, '..');
const require = createRequire(R + '/../package.json');
const { createWorker } = require('tesseract.js');
const truth = JSON.parse(fs.readFileSync(R + '/data/ocr/truth.json'));
const w = await createWorker('eng', 1, { langPath: path.dirname(require.resolve('@tesseract.js-data/eng/package.json')) + '/4.0.0_best_int', gzip: true, cacheMethod: 'none' });
const out = {}, ms = [];
for (const f of Object.keys(truth)) { const t = performance.now(); const { data } = await w.recognize(R + '/data/ocr/' + f); ms.push(performance.now() - t); out[f] = data.confidence >= 60 ? data.text : ''; out[f + ':raw'] = data.text; }
await w.terminate();
score('tesseract.js (conf>=60 gate)', truth, out, ms);
score('tesseract.js (no gate)', truth, Object.fromEntries(Object.keys(truth).map((f) => [f, out[f + ':raw']])), ms);
