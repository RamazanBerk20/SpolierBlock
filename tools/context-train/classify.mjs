// Node runner of the "title in context" model (onnxruntime-web WASM, 1 thread, as tools/spoiler-classify.mjs), for
// tools/eval-context.mjs. usage: const { threshold, prob } = await contextClassifier(); await prob(windowA, workB)
// The pair is assembled by hand so the truncation is explicit and easy to port: [CLS] A [SEP] B [SEP], token types 0 for
// [CLS] A [SEP] and 1 for B [SEP]; when that is longer than maxLength, A's tokens are cut from the end (Python's
// truncation='only_first'). transformers.js's own pair truncation cuts the end of the whole sequence instead.
import fs from 'node:fs';
import path from 'node:path';
import * as ort from 'onnxruntime-web';
import { env, AutoTokenizer } from '@huggingface/transformers';
ort.env.wasm.numThreads = 1;
export async function contextClassifier(dir = new URL('../../models/context', import.meta.url).pathname) {
  env.allowRemoteModels = false;
  env.localModelPath = path.dirname(path.resolve(dir)) + '/';
  const tok = await AutoTokenizer.from_pretrained(path.basename(dir));
  const sess = await ort.InferenceSession.create(fs.readFileSync(`${dir}/model_int8.onnx`), { executionProviders: ['wasm'] });
  const meta = JSON.parse(fs.readFileSync(`${dir}/meta.json`, 'utf8'));
  const [CLS, SEP] = tok.encode('');
  function encode(a, b) {
    const ta = tok.encode(a, { add_special_tokens: false }), tb = tok.encode(b, { add_special_tokens: false });
    const ka = Math.max(0, Math.min(ta.length, meta.maxLength - tb.length - 3));
    const ids = [CLS, ...ta.slice(0, ka), SEP, ...tb, SEP];
    return { ids, types: ids.map((_, i) => (i < ka + 2 ? 0 : 1)) };
  }
  async function prob(a, b) {
    const { ids, types } = encode(a, b), T = (v) => new ort.Tensor('int64', BigInt64Array.from(v, BigInt), [1, v.length]);
    const z = (await sess.run({ input_ids: T(ids), attention_mask: T(ids.map(() => 1)), token_type_ids: T(types) })).logit.data[0];
    return 1 / (1 + Math.exp(-z));
  }
  return { threshold: meta.threshold, meta, prob, encode };
}
