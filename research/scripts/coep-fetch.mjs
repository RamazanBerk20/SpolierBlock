// Does COEP require-corp in the Chrome offscreen document break fetching page images (no CORS / CORP headers)?
import http from 'node:http';
import fs from 'node:fs';
import puppeteer from 'puppeteer-core';
import { execSync } from 'node:child_process';
import path from 'node:path';
const ROOT = path.resolve(import.meta.dirname, '..');
const img = fs.readFileSync(ROOT + '/../test/fixtures/images/clean_cat.jpg');
const srv = http.createServer((q, r) => { r.writeHead(200, { 'content-type': 'image/jpeg' }); r.end(img); }).listen(8781, '127.0.0.1');
const exe = execSync(`ls -d ${ROOT}/../build/browsers/chrome/*/chrome-linux64/chrome`).toString().trim().split('\n').pop();
const browser = await puppeteer.launch({ executablePath: exe, headless: true, pipe: true, enableExtensions: [ROOT + '/ext-probe/chrome'], args: ['--no-first-run', '--user-data-dir=' + ROOT + '/.tmp-chrome-coep'] });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let off; for (let i = 0; i < 40 && !off; i++) { off = browser.targets().find((t) => t.url().endsWith('/probe.html')); if (!off) await sleep(250); }
const p = await off.asPage(); await p.waitForFunction(() => globalThis.probe);
console.log(JSON.stringify({ coi: await p.evaluate(() => crossOriginIsolated), fetch: await p.evaluate(() => probe.fetchTest('http://127.0.0.1:8781/cat.jpg')) }));
await browser.close(); srv.close(); execSync(`rm -rf ${ROOT}/.tmp-chrome-coep`);
