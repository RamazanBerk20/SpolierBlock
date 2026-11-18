// Re-scores the 300-item eval with the exported int8 ONNX of a fine-tuned model through onnxruntime-web WASM, 1 thread
// (the extension runtime); reports metrics, per-post latency and RSS. usage: node scripts/ft-int8.mjs <name>
import fs from 'node:fs';
import path from 'node:path';
import * as ort from 'onnxruntime-web';
import { AutoTokenizer, env } from '@huggingface/transformers';
import { report } from './metrics.mjs';
const R = path.resolve(import.meta.dirname, '..');
const name = process.argv[2];
ort.env.wasm.numThreads = 1;
env.allowRemoteModels = false; env.localModelPath = R + '/models/ft/';
const tok = await AutoTokenizer.from_pretrained(name);
const sess = await ort.InferenceSession.create(fs.readFileSync(`${R}/models/ft/${name}/model_int8.onnx`), { executionProviders: ['wasm'] });
const { thr } = JSON.parse(fs.readFileSync(`${R}/results/ft/${name}.json`));
const ev = fs.readFileSync(R + '/results/snap/spoiler-eval.jsonl', 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const ps = []; const t0 = performance.now();
for (const r of ev) {
  const sents = r.text.split(/(?<=[.!?])\s+|\n+/).map((s) => s.trim()).filter((s) => s.length > 3).slice(0, 16);
  let best = 0;
  for (const s of sents.length ? sents : [r.text]) {
    const x = tok(s, { truncation: true, max_length: 64 });
    const o = await sess.run({ input_ids: new ort.Tensor('int64', x.input_ids.data, x.input_ids.dims), attention_mask: new ort.Tensor('int64', x.attention_mask.data, x.attention_mask.dims) });
    best = Math.max(best, 1 / (1 + Math.exp(-o.logit.data[0])));
  }
  ps.push(best);
}
console.log(`ms/post (ort-web wasm 1 thread) ${((performance.now() - t0) / ev.length).toFixed(1)}, RSS ${Math.round(process.memoryUsage().rss / 1e6)} MB`);
report(name + ' int8 onnx', ev, ps, thr);
