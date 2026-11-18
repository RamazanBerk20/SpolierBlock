// usage: node scripts/chrome-probe.mjs <flagset: default|webgpu> <suite: caps|bench> [headless=1]
import puppeteer from 'puppeteer-core';
import { execSync } from 'node:child_process';
import path from 'node:path';
const [flagset = 'default', suite = 'caps', headless = '1'] = process.argv.slice(2);
const ROOT = path.resolve(import.meta.dirname, '..');
const exe = execSync(`ls -d ${ROOT}/../build/browsers/chrome/*/chrome-linux64/chrome`).toString().trim().split('\n').pop();
const flags = { default: [], webgpu: ['--enable-unsafe-webgpu', '--enable-features=Vulkan,WebGPUService', '--use-angle=vulkan', '--ignore-gpu-blocklist'] }[flagset];
const browser = await puppeteer.launch({ executablePath: exe, headless: headless === '1', pipe: true, enableExtensions: [path.join(ROOT, 'ext-probe/chrome')],
  args: ['--no-first-run', '--no-default-browser-check', '--user-data-dir=' + path.join(ROOT, '.tmp-chrome-' + process.pid), ...flags] });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let off;
for (let i = 0; i < 40 && !off; i++) { off = browser.targets().find((t) => t.url().endsWith('/probe.html')); if (!off) await sleep(250); }
const id = off.url().split('/')[2];
const offPage = await off.asPage();
await offPage.waitForFunction(() => globalThis.probe, { timeout: 20000 });
const tab = await browser.newPage();
await tab.goto(`chrome-extension://${id}/probe.html`);
await tab.waitForFunction(() => globalThis.probe);
const res = { flagset, headless, offscreen: await offPage.evaluate(() => probe.caps()), tab: await tab.evaluate(() => probe.caps()) };
console.log(JSON.stringify(res));
if (suite === 'bench') {
  const coi = res.offscreen.coi;
  const runs = [];
  for (const [model, kind] of process.env.MODELS ? process.env.MODELS.split(',').map((x) => x.split(':')) : [['clip32/vision_q8.onnx', 'image'], ['clip32/vision_fp16.onnx', 'image'], ['clip32/vision_fp32.onnx', 'image'], ['minilm/q8.onnx', 'text'], ['minilm/fp32.onnx', 'text'], ['minilm/fp16.onnx', 'text']]) {
    const isQ = model.includes('q8'), isF16 = model.includes('fp16');
    // ORT reads numThreads once, when the wasm module first initialises: one thread count per browser run
    const T = +(process.env.THREADS ?? 1);
    if (!isF16 && process.env.GPU !== '1') runs.push({ model, kind, ep: 'wasm', threads: T });
    if (res.offscreen.adapter && process.env.GPU === '1') runs.push({ model, kind, ep: 'webgpu', threads: T });
  }
  for (const r of runs) { const o = await offPage.evaluate((c) => probe.bench(c), r); console.log(JSON.stringify(o)); }
}
await browser.close();
execSync(`rm -rf ${ROOT}/.tmp-chrome-${process.pid}`);
