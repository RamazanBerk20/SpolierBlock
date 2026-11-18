import fs from 'node:fs';
import { score } from './ocr-score.mjs';
const truth = JSON.parse(fs.readFileSync(new URL('../data/ocr/truth.json', import.meta.url)));
const { out, ms } = JSON.parse(fs.readFileSync(new URL('../results/ocr-rapid.json', import.meta.url)));
score('RapidOCR (PP-OCR mobile, ORT CPU)', truth, out, ms);
