// Node mirror of engine.js classify() (same tokenizer, model and onnxruntime-web WASM runtime, 1 thread), for
// tools/eval-spoiler.mjs and test/rdr2-probe.mjs. usage: const { threshold, prob } = await spoilerClassifier();
import fs from 'node:fs';
import path from 'node:path';
import * as ort from 'onnxruntime-web';
import { env, AutoTokenizer } from '@huggingface/transformers';
ort.env.wasm.numThreads = 1;
export async function spoilerClassifier(dir = new URL('../models/spoiler', import.meta.url).pathname) {
  env.allowRemoteModels = false;
  env.localModelPath = path.dirname(path.resolve(dir)) + '/';
  const tok = await AutoTokenizer.from_pretrained(path.basename(dir));
  const sess = await ort.InferenceSession.create(fs.readFileSync(`${dir}/model_int8.onnx`), { executionProviders: ['wasm'] });
  const { threshold } = JSON.parse(fs.readFileSync(`${dir}/meta.json`, 'utf8'));
  async function prob(text) {
    // @handles are absent from the training data; a bare handle line ("@gus") alone scores near the threshold
    const sents = text.split(/(?<=[.!?])\s+|\n+/).map((s) => s.replace(/@\w+/g, '').trim()).filter((s) => s.length > 3).slice(0, 16);
    if (!sents.length) return 0;
    // one sentence per run: the int8 model quantizes activations per tensor, so padding/batching would shift scores
    let z = -Infinity;
    for (const s of sents) {
      const x = tok(s, { truncation: true, max_length: 64 });
      const t = (k) => new ort.Tensor('int64', x[k].data, x[k].dims);
      z = Math.max(z, (await sess.run({ input_ids: t('input_ids'), attention_mask: t('attention_mask') })).logit.data[0]);
    }
    return 1 / (1 + Math.exp(-z));
  }
  return { threshold, prob };
}
