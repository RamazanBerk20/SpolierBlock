// Florence-2-base-ft '<OCR>' via transformers.js (q8 ONNX, onnxruntime-node) on data/ocr; also checks it on 5 media fixtures with <CAPTION>.
import fs from 'node:fs';
import path from 'node:path';
import { env, Florence2ForConditionalGeneration, AutoProcessor, AutoTokenizer, RawImage } from '@huggingface/transformers';
import { score } from './ocr-score.mjs';
const R = path.resolve(import.meta.dirname, '..');
env.allowRemoteModels = false; env.localModelPath = R + '/models/hf/';
const id = 'onnx-community/Florence-2-base-ft';
const model = await Florence2ForConditionalGeneration.from_pretrained(id, { dtype: 'q8' });
const proc = await AutoProcessor.from_pretrained(id), tok = await AutoTokenizer.from_pretrained(id);
async function run(file, task) {
  const img = await RawImage.read(file);
  const inputs = await proc(img, proc.construct_prompts(task));
  const ids = await model.generate({ ...inputs, max_new_tokens: 48 });
  return tok.batch_decode(ids, { skip_special_tokens: true })[0];
}
const truth = JSON.parse(fs.readFileSync(R + '/data/ocr/truth.json'));
const out = {}, ms = [];
for (const f of Object.keys(truth)) { const t = performance.now(); out[f] = await run(R + '/data/ocr/' + f, '<OCR>'); ms.push(performance.now() - t); }
score('Florence-2-base-ft q8 <OCR>', truth, out, ms);
console.log('RSS MB', Math.round(process.memoryUsage().rss / 1e6));
for (const f of ['spoiler_starwars_vader.jpg', 'spoiler_mario.jpg', 'spoiler_got_throne.jpg', 'pos_metropolis.jpg', 'clean_cat.jpg']) {
  const t = performance.now(); const c = await run(R + '/../test/fixtures/images/' + f, '<MORE_DETAILED_CAPTION>');
  console.log(`caption ${f}: ${Math.round(performance.now() - t)} ms: ${c.slice(0, 160)}`);
}
