// Scores the shipped frozen-MiniLM + cues head (snapshot in results/snap/) on the 300-item eval -> results/text-baseline.json
import fs from 'node:fs';
import path from 'node:path';
import { env, pipeline } from '@huggingface/transformers';
import { cueFeatures, spoilerProb } from '../results/snap/spoiler-features.js';
import { report } from './metrics.mjs';
const R = path.resolve(import.meta.dirname, '..');
env.allowRemoteModels = false; env.localModelPath = R + '/models/hf/';
fs.mkdirSync(R + '/models/hf/Xenova/all-MiniLM-L6-v2/onnx', { recursive: true });
for (const f of ['config.json', 'tokenizer.json', 'tokenizer_config.json', 'onnx/model_quantized.onnx']) if (!fs.existsSync(`${R}/models/hf/Xenova/all-MiniLM-L6-v2/${f}`)) fs.copyFileSync(`${R}/../build/.cache/Xenova/all-MiniLM-L6-v2/${f}`, `${R}/models/hf/Xenova/all-MiniLM-L6-v2/${f}`);
const head = JSON.parse(fs.readFileSync(R + '/results/snap/spoiler-model.json'));
const ev = fs.readFileSync(R + '/results/snap/spoiler-eval.jsonl', 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const fe = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2', { dtype: 'q8' });
const t0 = performance.now();
const ps = [];
for (const r of ev) { // same as engine.js classify()
  const sents = r.text.split(/(?<=[.!?])\s+|\n+/).map((s) => s.trim()).filter((s) => s.length > 3).slice(0, 16);
  const emb = (await fe(sents, { pooling: 'mean', normalize: true })).tolist();
  ps.push(Math.max(...emb.map((e, i) => spoilerProb([...e, ...cueFeatures(sents[i]).map((v) => v * head.cueScale)], head))));
}
console.log('ms/post', ((performance.now() - t0) / ev.length).toFixed(1));
report('frozen-minilm+cues (shipped snapshot)', ev, ps, head.threshold);
fs.writeFileSync(R + '/results/text-baseline.json', JSON.stringify(ps));
