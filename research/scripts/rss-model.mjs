// Peak RSS added by one model in onnxruntime-web WASM (1 thread), after load + 3 runs. usage: node scripts/rss-model.mjs <onnx> <image|text>
import fs from 'node:fs';
import * as ort from 'onnxruntime-web';
const [file, kind] = process.argv.slice(2);
ort.env.wasm.numThreads = 1;
const hwm = () => +fs.readFileSync('/proc/self/status', 'utf8').match(/VmHWM:\s+(\d+)/)[1] / 1024;
const base = hwm();
const s = await ort.InferenceSession.create(fs.readFileSync(file), { executionProviders: ['wasm'] });
const f = kind === 'text'
  ? Object.fromEntries(s.inputNames.map((n) => [n, new ort.Tensor('int64', new BigInt64Array(32).fill(n === 'input_ids' ? 2000n : 1n), [1, 32])]))
  : { [s.inputNames[0]]: new ort.Tensor('float32', new Float32Array(3 * 224 * 224).fill(0.1), [1, 3, 224, 224]) };
for (let i = 0; i < 3; i++) await s.run(f);
console.log(`${file.split('/').slice(-1)[0]}: disk ${(fs.statSync(file).size / 1e6).toFixed(0)} MB, peak RSS +${(hwm() - base).toFixed(0)} MB (node baseline ${base.toFixed(0)} MB)`);
