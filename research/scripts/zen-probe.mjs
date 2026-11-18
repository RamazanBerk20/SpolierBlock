// usage: node scripts/zen-probe.mjs <default|webgpu> <caps|bench>   (Zen, temporary profile, headless)
import fs from 'node:fs';
const require_log = () => fs.openSync(new URL('../results/zen-webext.log', import.meta.url), 'a');
import puppeteer from 'puppeteer-core';
import { spawn } from 'node:child_process';
import path from 'node:path';
const [flagset = 'default', suite = 'caps'] = process.argv.slice(2);
const ROOT = path.resolve(import.meta.dirname, '..');
const uuid = '7b2f1f9e-2222-4c7a-9e7e-5b0b5b0b5b0c', BIDI = 9444;
const prefs = { 'extensions.webextensions.uuids': JSON.stringify({ 'probe@local': uuid }),
  ...(flagset === 'webgpu' ? { 'dom.webgpu.enabled': true, 'gfx.webgpu.ignore-blocklist': true } : {}) };
const child = spawn(path.join(ROOT, '../node_modules/.bin/web-ext'), ['run', '--source-dir', path.join(ROOT, 'ext-probe/firefox'), '--firefox=/usr/bin/zen-browser',
  '--no-reload', '--no-input', '--start-url', 'about:blank', `--arg=--remote-debugging-port=${BIDI}`, ...Object.entries(prefs).map(([k, v]) => `--pref=${k}=${v}`)],
  { env: { ...process.env, MOZ_HEADLESS: '1', MOZ_REMOTE_ALLOW_SYSTEM_ACCESS: '1' }, stdio: ['ignore', require_log(), require_log()], detached: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let browser;
try {
  for (let i = 0; i < 60 && !browser; i++) { await sleep(1000); try { browser = await puppeteer.connect({ browserWSEndpoint: `ws://127.0.0.1:${BIDI}/session`, protocol: 'webDriverBiDi' }); } catch {} }
  // BiDi cannot navigate content tabs to moz-extension:, open it from the privileged window (same trick as test/e2e/run.mjs)
  const conn = browser.connection;
  const { contexts } = await conn.send('browsingContext.getTree', { 'moz:scope': 'chrome' }).then((t) => t.result ?? t);
  const chromeEval = async (expression) => { const r = await conn.send('script.evaluate', { target: { context: contexts[0].context }, awaitPromise: true, expression }); return (r.result ?? r).result?.value; };
  let host; for (let i = 0; i < 30 && !host; i++) { host = await chromeEval(`WebExtensionPolicy.getByID('probe@local')?.mozExtensionHostname ?? null`); if (!host) await sleep(500); }
  await chromeEval(`openTrustedLinkIn('moz-extension://${host}/probe.html', 'tab'); true`);
  let ctx; for (let i = 0; i < 20 && !ctx; i++) { await sleep(500); const t = await conn.send('browsingContext.getTree', {}); ctx = (t.result ?? t).contexts.find((c) => c.url.includes(host))?.context; }
  const ev = async (fn, arg) => { const r = await conn.send('script.callFunction', { functionDeclaration: `async (a) => { for (let i = 0; i < 100 && !globalThis.probe; i++) await new Promise((r) => setTimeout(r, 100)); return JSON.stringify(await (${fn})(JSON.parse(a))); }`, awaitPromise: true, target: { context: ctx }, arguments: [{ type: 'string', value: JSON.stringify(arg ?? null) }] }); const v = (r.result ?? r).result?.value; return v === undefined ? (r.result ?? r) : JSON.parse(v); };
  const tab = { evaluate: (fn, arg) => ev(fn.toString(), arg) };
  const res = { flagset, tab: await tab.evaluate(() => probe.caps()), bg: await tab.evaluate(async () => { const bg = await browser.runtime.getBackgroundPage(); return bg?.probe ? bg.probe.caps() : 'no bg'; }) };
  console.log(JSON.stringify(res));
  if (suite === 'bench') {
    const T = +(process.env.THREADS ?? 1);
    for (const [model, kind] of process.env.MODELS ? process.env.MODELS.split(',').map((x) => x.split(':')) : [['clip32/vision_q8.onnx', 'image'], ['clip32/vision_fp16.onnx', 'image'], ['minilm/q8.onnx', 'text'], ['minilm/fp16.onnx', 'text']]) {
      const f16 = model.includes('fp16') || process.env.GPU === '1';
      if (!f16) console.log(JSON.stringify(await tab.evaluate((c) => probe.bench(c), { model, kind, ep: 'wasm', threads: T })));
      if (f16 && res.tab.adapter) console.log(JSON.stringify(await tab.evaluate((c) => probe.bench(c), { model, kind, ep: 'webgpu', threads: T })));
    }
  }
} finally { try { await browser?.close(); } catch {} try { process.kill(-child.pid, 'SIGTERM'); } catch {} }
process.exit(0);
