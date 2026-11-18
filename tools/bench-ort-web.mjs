// Vision-tower latency + RSS with onnxruntime-web WASM (the extension's runtime). usage: node tools/bench-ort-web.mjs <model.onnx> [size] [threads]
import * as ort from 'onnxruntime-web';
import fs from 'node:fs';
const [file, size = 224, threads = 1] = process.argv.slice(2);
ort.env.wasm.numThreads = +threads;
const rss0 = process.memoryUsage().rss;
let t = performance.now();
const s = await ort.InferenceSession.create(fs.readFileSync(file), { executionProviders: ['wasm'] });
console.log('load ms', (performance.now() - t).toFixed(0), 'inputs', s.inputNames, 'outputs', s.outputNames);
const x = new ort.Tensor('float32', new Float32Array(3 * size * size).fill(0.1), [1, 3, +size, +size]);
const times = [];
for (let i = 0; i < 8; i++) { t = performance.now(); await s.run({ [s.inputNames[0]]: x }); times.push(performance.now() - t); }
console.log('run ms', times.map((v) => v.toFixed(0)).join(' '), 'RSS +MB', ((process.memoryUsage().rss - rss0) / 1e6).toFixed(0));
