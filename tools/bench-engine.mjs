// Per-image latency of the real engine (src/background/engine.js) inside the built extension: Chrome (cross-origin
// isolated extension page, 4 WASM threads) or Zen/Firefox (1 thread). Runs through test/e2e/run.mjs --eval, which loads
// dist/<target> in a temporary profile and serves test/fixtures/images on 127.0.0.1.
// usage: node tools/bench-engine.mjs chrome|firefox [file-prefix-regex=.]     (after npm run build or build:fixture)
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
const [target = 'chrome', re = '.'] = process.argv.slice(2);
const port = target === 'chrome' ? 8776 : 8766;
const files = fs.readdirSync('test/fixtures/images').filter((f) => /\.(jpg|png)$/.test(f) && new RegExp(re).test(f)).sort();
const fn = `async () => {
  const api = globalThis.browser ?? globalThis.chrome;
  const m = await import(api.runtime.getURL('src/background/engine.js'));
  const files = ${JSON.stringify(files)}, out = { threads: globalThis.crossOriginIsolated ? Math.min(4, navigator.hardwareConcurrency) : 1, rows: [] };
  const run = async (type, f, i) => { const u = 'http://127.0.0.1:${port}/' + f, t = performance.now(); const r = await m.handle({ type, key: u + '#' + i, url: u, prio: 0 }); return [performance.now() - t, r]; };
  const [c0] = await run('img.check', files[0], 'warm'), [o0] = await run('img.ocr', files[0], 'warm');
  out.firstCheckMs = Math.round(c0); out.firstOcrMs = Math.round(o0);
  for (const f of files) {
    const [tc, a] = await run('img.check', f, 1), [to, b] = await run('img.ocr', f, 1);
    out.rows.push([f, Math.round(tc), Math.round(to), JSON.stringify(a.hits ?? a.error), (b.text ?? b.error ?? '').replace(/\\s+/g, ' ').slice(0, 60)]);
  }
  const med = (k) => { const s = out.rows.map((r) => r[k]).sort((x, y) => x - y); return s[s.length >> 1]; };
  const p90 = (k) => { const s = out.rows.map((r) => r[k]).sort((x, y) => x - y); return s[Math.floor(s.length * 0.9)]; };
  // feed-like burst: every image requested at once (title checks then OCR, as a screen of thumbnails would)
  let t = performance.now();
  await Promise.all(files.map((f) => run('img.check', f, 'burst')));
  out.burstCheckMsPerImage = Math.round((performance.now() - t) / files.length);
  t = performance.now();
  await Promise.all(files.map((f) => run('img.ocr', f, 'burst')));
  out.burstOcrMsPerImage = Math.round((performance.now() - t) / files.length);
  out.checkMedianMs = med(1); out.checkP90Ms = p90(1); out.ocrMedianMs = med(2); out.ocrP90Ms = p90(2);
  return out;
}`;
const r = spawnSync('node', ['test/e2e/run.mjs', target, '--eval', fn], { encoding: 'utf8', maxBuffer: 1 << 26 });
const line = r.stdout.split('\n').findIndex((l) => l.startsWith('{'));
const res = line >= 0 ? JSON.parse(r.stdout.split('\n').slice(line).join('\n')) : null;
if (!res?.rows) { console.log(r.stdout.slice(-3000), r.stderr.slice(-3000)); process.exit(1); }
for (const row of res.rows) console.log(row.join('\t'));
const { rows, ...summary } = res;
console.log(JSON.stringify({ target, images: rows.length, ...summary }));
