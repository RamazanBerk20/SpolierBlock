// End-to-end check against test/e2e/fixture.html with a temporary browser profile.
// usage: node test/e2e/run.mjs firefox|chrome     (needs `npm run build:fixture` first)
//   firefox: web-ext run with Zen (MOZ_HEADLESS=1), driven over WebDriver BiDi
//   chrome:  Chrome for Testing from build/browsers (npx @puppeteer/browsers install chrome@stable --path build/browsers)
// All non-loopback traffic is forced through a logging proxy that refuses it, so any request the extension
// (or browser) makes to the internet is listed in the report.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execSync } from 'node:child_process';
import puppeteer from 'puppeteer-core';

const target = process.argv[2] ?? 'firefox';
const ROOT = path.resolve(import.meta.dirname, '../..');
const OUT = path.join(ROOT, 'test/e2e/out');
fs.mkdirSync(OUT, { recursive: true });
const IMG_DIR = path.join(ROOT, 'test/fixtures/images');
const off = target === 'chrome' ? 10 : 0; // separate ports so both targets can run at once
const PAGE = 8765 + off, IMG = 8766 + off, PROXY = 8899 + off, BIDI = 9333, SPARQL = 8767 + off;
const log = { page: [], img: [], proxy: [], sparql: [] };

// Test build: a copy of dist/<target> whose data/update-config.json points the catalog update at a local mock
// SPARQL endpoint (release builds have no such file and always use query.wikidata.org).
const EXT = path.join(ROOT, 'build/e2e-ext', target);
fs.rmSync(EXT, { recursive: true, force: true });
fs.cpSync(path.join(ROOT, 'dist', target), EXT, { recursive: true });
fs.writeFileSync(path.join(EXT, 'data/update-config.json'), JSON.stringify({ endpoint: `http://127.0.0.1:${SPARQL}/sparql` }));

const types = { '.jpg': 'image/jpeg', '.png': 'image/png', '.webm': 'video/webm', '.html': 'text/html' };
function staticServer(port, name, html) {
  return http.createServer((req, res) => {
    log[name].push(`${req.method} ${req.url} ua=${(req.headers['user-agent'] ?? '').slice(0, 20)} sec-fetch-site=${req.headers['sec-fetch-site'] ?? ''}`);
    const u = new URL(req.url, 'http://x');
    if (html && u.pathname === '/') {
      res.writeHead(200, { 'content-type': 'text/html' });
      return res.end(fs.readFileSync(path.join(ROOT, 'test/e2e/fixture.html'), 'utf8')
        .replaceAll('{{IMG}}', `http://127.0.0.1:${IMG}`).replaceAll('{{SELF}}', `http://localhost:${PAGE}/img`));
    }
    const f = path.join(IMG_DIR, path.basename(u.pathname));
    if (!fs.existsSync(f)) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'content-type': types[path.extname(f)] ?? 'application/octet-stream', 'cache-control': 'max-age=3600' });
    fs.createReadStream(f).pipe(res);
  }).listen(port, '127.0.0.1');
}
const servers = [staticServer(PAGE, 'page', true), staticServer(IMG, 'img', false)];
// Mock Wikidata: one invented work that is not in the bundled catalog. mode: ok | 429 | bad
let sparqlMode = 'ok';
const NEW_WORK = { id: 'Q999000123', title: 'Zephyrine Vault' };
const bindings = (rows) => JSON.stringify({ head: { vars: [] }, results: { bindings: rows } });
const wdUri = (id) => ({ type: 'uri', value: 'http://www.wikidata.org/entity/' + id });
servers.push(http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => { body += c; });
  req.on('end', () => {
    const q = new URLSearchParams(body).get('query') ?? '';
    log.sparql.push(`${sparqlMode} ${q.slice(0, 60).replace(/\s+/g, ' ')}`);
    if (sparqlMode === '429') { res.writeHead(429, { 'retry-after': '1' }); return res.end('Too Many Requests'); }
    if (sparqlMode === 'bad') { res.writeHead(200, { 'content-type': 'application/sparql-results+json' }); return res.end('{"results": <html>'); }
    res.writeHead(200, { 'content-type': 'application/sparql-results+json' });
    if (q.includes('hint:rangeSafe')) return res.end(bindings(q.includes('P577') ? [{ item: wdUri(NEW_WORK.id), cls: wdUri('Q7889'), sl: { value: '25' } }] : []));
    if (q.includes('rdfs:label ?en')) return res.end(bindings([{ w: wdUri(NEW_WORK.id), en: { value: NEW_WORK.title } }]));
    if (q.includes('wdt:P577')) return res.end(bindings([{ w: wdUri(NEW_WORK.id), d: { value: '2026-09-01T00:00:00Z' } }]));
    if (q.includes('skos:altLabel')) return res.end(bindings([{ w: wdUri(NEW_WORK.id), a: { value: 'ZVault', 'xml:lang': 'en' } }]));
    return res.end(bindings([]));
  });
}).listen(SPARQL, '127.0.0.1'));
const proxy = http.createServer((req, res) => { log.proxy.push(`${req.method} ${req.url}`); res.writeHead(403); res.end(); });
proxy.on('connect', (req, sock) => { log.proxy.push(`CONNECT ${req.url}`); sock.end('HTTP/1.1 403 Forbidden\r\n\r\n'); });
proxy.listen(PROXY, '127.0.0.1');
servers.push(proxy);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
process.on('uncaughtException', (e) => { console.error(e); child?.kill('SIGINT'); setTimeout(() => process.exit(1), 3000); });
process.on('unhandledRejection', (e) => { console.error(e); child?.kill('SIGINT'); setTimeout(() => process.exit(1), 3000); });
let browser, child, extBase;
const consoleLog = [];

if (target === 'firefox') {
  const uuid = '6a1f1f9e-1111-4c7a-9e7e-5b0b5b0b5b0b';
  const prefs = {
    'network.proxy.type': 1, 'network.proxy.http': '127.0.0.1', 'network.proxy.http_port': PROXY,
    'network.proxy.ssl': '127.0.0.1', 'network.proxy.ssl_port': PROXY, 'network.proxy.no_proxies_on': 'localhost, 127.0.0.1',
    'network.proxy.allow_hijacking_localhost': false,
    'extensions.webextensions.uuids': JSON.stringify({ 'spolierblocker@local': uuid }),
  };
  const args = ['web-ext', 'run', '--source-dir', EXT, '--firefox=/usr/bin/zen-browser',
    '--no-reload', '--no-input', '--start-url', 'about:blank', `--arg=--remote-debugging-port=${BIDI}`,
    ...Object.entries(prefs).map(([k, v]) => `--pref=${k}=${v}`)];
  child = spawn('npx', args, { cwd: ROOT, env: { ...process.env, MOZ_HEADLESS: '1', MOZ_REMOTE_ALLOW_SYSTEM_ACCESS: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', (d) => fs.appendFileSync(path.join(OUT, 'web-ext.log'), d));
  child.stderr.on('data', (d) => fs.appendFileSync(path.join(OUT, 'web-ext.log'), d));
  for (let i = 0; i < 60 && !browser; i++) {
    await sleep(1000);
    try { browser = await puppeteer.connect({ browserWSEndpoint: `ws://127.0.0.1:${BIDI}/session`, protocol: 'webDriverBiDi' }); } catch {}
  }
  if (!browser) throw new Error('could not connect to Zen');
  extBase = `moz-extension://${uuid}`;
  await sleep(2000); // let web-ext finish installing the temporary add-on
} else {
  const exe = execSync(`ls -d ${ROOT}/build/browsers/chrome/*/chrome-linux64/chrome`).toString().trim().split('\n').pop();
  const ext = EXT;
  browser = await puppeteer.launch({
    executablePath: exe, headless: true, pipe: true, enableExtensions: [ext],
    args: [`--proxy-server=http://127.0.0.1:${PROXY}`, '--no-first-run', '--no-default-browser-check'],
  });
  let sw;
  for (let i = 0; i < 30 && !sw; i++) { sw = browser.targets().find((t) => t.type() === 'service_worker' && t.url().includes('background.js')); if (!sw) await sleep(500); }
  extBase = sw.url().split('/').slice(0, 3).join('/'); // URL.origin is 'null' for chrome-extension:
}

// Extension page used to read/write storage like the popup does.
let extPage, extEval, chromeEval, extReload;
if (target === 'firefox') {
  // BiDi may not navigate content tabs to moz-extension:, so open it from the privileged browser window
  // (allowed by --remote-allow-system-access, test profile only).
  const conn = browser.connection;
  const tree = await conn.send('browsingContext.getTree', { 'moz:scope': 'chrome' });
  const { contexts } = tree.result ?? tree;
  chromeEval = async (expression) => {
    const r = await conn.send('script.evaluate', { target: { context: contexts[0].context }, awaitPromise: true, expression });
    return (r.result ?? r).result?.value;
  };
  let host;
  for (let i = 0; i < 30 && !host; i++) { host = await chromeEval(`WebExtensionPolicy.getByID('spolierblocker@local')?.mozExtensionHostname ?? null`); if (!host) await sleep(500); }
  extBase = `moz-extension://${host}`;
  await chromeEval(`openTrustedLinkIn(${JSON.stringify('moz-extension://' + host + '/src/popup/popup.html')}, 'tab'); true`);
  let ctx;
  for (let i = 0; i < 20 && !ctx; i++) {
    await sleep(500);
    const t = await conn.send('browsingContext.getTree', {});
    ctx = (t.result ?? t).contexts.find((c) => c.url.startsWith(extBase))?.context;
  }
  extReload = () => conn.send('browsingContext.reload', { context: ctx, wait: 'complete' });
  // raw BiDi evaluation in the extension page (puppeteer does not track tabs opened by the browser itself)
  extEval = async (fn, arg) => {
    const r = await conn.send('script.callFunction', {
      functionDeclaration: `async (a) => JSON.stringify(await (${fn})(JSON.parse(a)))`, awaitPromise: true,
      target: { context: ctx }, arguments: [{ type: 'string', value: JSON.stringify(arg ?? null) }],
    });
    const v = (r.result ?? r).result?.value;
    return v === undefined ? undefined : JSON.parse(v);
  };
} else {
  extPage = await browser.newPage();
  await extPage.goto(`${extBase}/src/popup/popup.html`);
  extEval = (fn, arg) => extPage.evaluate(fn, arg);
  extReload = () => extPage.reload();
}
const storage = extEval;
await storage(() => (globalThis.browser ?? chrome).storage.local.clear());

// debugging aid: node test/e2e/run.mjs firefox --eval 'async () => ...'  (runs in an extension page)
const evalArg = process.argv.indexOf('--eval');
if (evalArg > 0) {
  try { console.log(JSON.stringify(target === "chrome" ? await extPage.evaluate(`(${process.argv[evalArg + 1]})()`) : await extEval(process.argv[evalArg + 1]), null, 1)); } catch (e) { console.log('EVAL ERROR', e.message); }
  await browser.close().catch(() => {});
  child?.kill('SIGINT');
  servers.forEach((s) => s.close());
  setTimeout(() => process.exit(0), 3000);
  await sleep(1e9);
}

const page = await browser.newPage();
await page.setViewport({ width: 700, height: 900 });
page.on('console', (m) => consoleLog.push(`[${m.type()}] ${m.text()}`));
page.on('pageerror', (e) => consoleLog.push(`[pageerror] ${e.message}`));

async function state() {
  return page.evaluate(() => [...document.querySelectorAll('article')].map((a) => {
    const ov = a.querySelector(':scope > sb-overlay');
    const media = [...a.querySelectorAll('.post > img, video')];
    return {
      id: a.id,
      blocked: a.hasAttribute('data-sb-blocked'),
      overlay: ov?.shadowRoot?.querySelector('p')?.textContent ?? null,
      // i-* / v-trooper show a known work: verdict done but post not blocked = MISS (reported, not a failure)
      media: media.map((m) => (!m.hasAttribute('data-sb-ok') ? 'pending'
        : /^(i-|v-trooper)/.test(a.id) && !a.hasAttribute('data-sb-blocked') ? 'MISS' : 'ok')).join(','),
    };
  }));
}
// Waits for the content script's explicit "all verdicts in" signal: every media element has a verdict
// (data-sb-ok) and nothing is in flight (data-sb-busy="0"), checked twice 1 s apart.
const allIn = () => page.evaluate(() => document.documentElement.getAttribute('data-sb-busy') === '0' &&
  ![...document.querySelectorAll('img, video')].some((m) => !m.hasAttribute('data-sb-ok')));
async function settle(maxMs = 120000) {
  await page.evaluate(() => window.scrollTo(0, 0)); // reloads restore the old scroll position
  const t0 = Date.now();
  for (;;) {
    // media is only scanned near the viewport (IntersectionObserver), so scroll like a reader would
    await page.evaluate(() => (innerHeight + scrollY >= document.documentElement.scrollHeight - 2 ? scrollTo(0, 0) : scrollBy(0, 500)));
    if (await allIn()) {
      const ms = Date.now() - t0;
      await sleep(1000);
      if (await allIn()) return { s: await state(), ms, how: 'all verdicts in' };
    }
    if (Date.now() - t0 > maxMs) return { s: await state(), ms: Date.now() - t0, how: 'TIMEOUT' };
    await sleep(500);
  }
}
const fmt = (s) => s.map((x) => `${x.id.padEnd(15)} ${x.blocked ? 'BLOCKED' : 'visible'} ${x.media ? '[' + x.media + ']' : ''} ${x.overlay ?? ''}`).join('\n');
const report = [];
report.push = (...xs) => { Array.prototype.push.apply(report, xs); fs.appendFileSync(path.join(OUT, `${target}-progress.txt`), xs.join('\n') + '\n\n'); return report.length; };
const section = async (name, extra = '') => {
  const { s, ms, how } = await settle();
  await page.screenshot({ path: path.join(OUT, `${target}-${name}.png`), fullPage: true });
  const dbg = await page.evaluate(() => document.documentElement.getAttribute('data-sb-stats'));
  report.push(`## ${name} (${how} after ${ms} ms; stats ${dbg}) ${extra}\n${fmt(s)}`);
  const stuck = await page.evaluate(() => [...document.querySelectorAll('img:not([data-sb-ok]), video:not([data-sb-ok])')].slice(0, 3)
    .map((m) => ({ src: m.currentSrc.slice(-30), complete: m.complete, nw: m.naturalWidth, top: Math.round(m.getBoundingClientRect().top), scrollY })));
  if (stuck.length) report.push(`stuck media: ${JSON.stringify(stuck)}`);
  return s;
};

// 1) first paint: is anything spoilery ever visible? Sample the DOM as early as possible.
const t0 = Date.now();
await page.goto(`http://localhost:${PAGE}/`, { waitUntil: 'domcontentloaded' });
const early = await page.evaluate(() => ({
  ready: document.documentElement.hasAttribute('data-sb-ready'),
  bodyVisibility: getComputedStyle(document.body).visibility,
  blockedAtDCL: [...document.querySelectorAll('[data-sb-blocked]')].map((e) => e.id),
  pendingImgs: [...document.querySelectorAll('img:not([data-sb-ok])')].length,
  imgFilter: getComputedStyle(document.querySelector('#i-vader img')).filter,
}));
report.push(`## at DOMContentLoaded (+${Date.now() - t0} ms)\n${JSON.stringify(early)}`);
const any1 = await section('any-mode');
report.push(`## time to all verdicts (from navigation, incl. scrolling the page at 500 px / 0.5 s): ${Date.now() - t0} ms`);
const ocrLine = any1.find((x) => x.id === 'i-ocr');
if (!ocrLine?.blocked) { report.push('## FAIL: i-ocr (text only visible through OCR) was not blocked in any-mode'); process.exitCode = 1; }
if (process.env.STOP_AFTER_ANY) { fs.writeFileSync(path.join(OUT, `${target}-report.txt`), report.join('\n\n') + `\n## page console\n${consoleLog.join('\n')}\n`); await browser.close().catch(() => {}); child?.kill('SIGINT'); servers.forEach((x) => x.close()); setTimeout(() => process.exit(process.exitCode ?? 0), 3000); await sleep(1e9); }

// 2) The real popup page (src/popup/popup.html) driven through its own UI.
const popupSearch = (q) => extEval(async (q) => {
  const i = document.getElementById('search');
  i.value = q; i.dispatchEvent(new Event('input'));
  // wait until the list shows results for this query (the background may be starting up)
  for (let k = 0; k < 40 && !(document.querySelector('#results li')?.textContent.toLowerCase().includes(q)); k++) await new Promise((r) => setTimeout(r, 250));
  return [...document.querySelectorAll('#results li')].map((li) => li.textContent.replace(/\s+/g, ' ').trim()).slice(0, 6);
}, q);
report.push(`## popup search "breaking bad"\n${JSON.stringify(await popupSearch('breaking bad'))}`);
await extEval(() => document.querySelector('#results button').click()); // "Add" on the first (most popular) result
await sleep(1500);
report.push(`## after popup "Add" Breaking Bad: ${fmt((await state()).filter((x) => x.id === 't-breaking'))}`);
report.push(`## popup search "star wars"\n${JSON.stringify(await popupSearch('star wars'))}`);

// 3) "I've seen {title}" on an overlay: marks every work of the name group in one write
const dynLabel = (await state()).find((x) => x.id === 't-dynamic').overlay;
await page.evaluate(() => document.querySelector('#t-dynamic > sb-overlay').shadowRoot.querySelector('[data-a="seen"]').click());
await sleep(1500);
const seenNow = await storage(async () => (await (globalThis.browser ?? chrome).storage.local.get('seen')).seen);
report.push(`## after overlay "I've seen" on #t-dynamic (${dynLabel}): ${fmt((await state()).filter((x) => x.id === 't-dynamic'))}\nstorage.seen: ${Object.keys(seenNow).length} works: ${Object.values(seenNow).map((w) => w.title).join(' | ')}`);
await page.reload({ waitUntil: 'domcontentloaded' });
await section('after-seen-reload');
report.push(`## content-script init on this tab (fetch index + parse + first scan): ${await page.evaluate(() => document.documentElement.getAttribute('data-sb-ready'))} ms`);

// 4) popup status line (tab.stats) for the fixture tab
await extReload();
await sleep(1500);
report.push(`## popup status: "${await extEval(() => document.getElementById('status').textContent)}"`);

// 4b) Opt-in catalog update, driven through the popup against the mock endpoint.
report.push(`## SPARQL requests while the setting is off and nothing was clicked: ${log.sparql.length}`);
if (log.sparql.length) { report.push('## FAIL: network request without opt-in'); process.exitCode = 1; }
const alarm = () => extEval(async () => (globalThis.browser ?? chrome).alarms.get('catalogUpdate').then((a) => a ? { periodInMinutes: a.periodInMinutes } : null));
await extEval(() => { const s = document.getElementById('catalogUpdate'); s.value = 'weekly'; s.dispatchEvent(new Event('change')); });
await sleep(1500);
report.push(`## popup "Update catalog" = Weekly -> alarm ${JSON.stringify(await alarm())}`);
const clickUpdate = async (mode) => {
  sparqlMode = mode;
  const n = log.sparql.length;
  await extEval(() => document.getElementById('updateNow').click());
  for (let i = 0; i < 80; i++) { await sleep(250); if (await extEval(() => !document.getElementById('updateNow').disabled)) break; }
  return `requests ${log.sparql.length - n}; status "${await extEval(() => document.getElementById('catalogStatus').textContent)}"`;
};
const newLine = async () => fmt((await state()).filter((x) => x.id === 't-new' || x.id === 't-amb-ctx'));
for (const mode of ['429', 'bad']) {
  report.push(`## Update now with mock answering ${mode}: ${await clickUpdate(mode)}\n${await newLine()}`);
}
report.push(`## Update now with mock answering ok: ${await clickUpdate('ok')}`);
await sleep(2000); // the open tab swaps its index live on storage.onChanged
report.push(`## fixture tab after the update (no reload):\n${await newLine()}`);
if (!(await state()).find((x) => x.id === 't-new')?.blocked) { report.push('## FAIL: updated work not blocked'); process.exitCode = 1; }
report.push(`## popup search "zephyrine": ${JSON.stringify(await popupSearch('zephyrine'))}`);
await extEval(() => { const s = document.getElementById('catalogUpdate'); s.value = 'off'; s.dispatchEvent(new Event('change')); });
await sleep(1500);
report.push(`## popup "Update catalog" = Off -> alarm ${JSON.stringify(await alarm())}`);
report.push(`## storage sizes: ${JSON.stringify(await storage(async () => { const a = await (globalThis.browser ?? chrome).storage.local.get(['catalogIndex', 'catalogAdded']); return { catalogIndex: JSON.stringify(a.catalogIndex ?? null).length, catalogAdded: JSON.stringify(a.catalogAdded ?? null).length }; }))}`);

// 5) "Show once" on #t-spoiler
await page.evaluate(() => document.querySelector('#t-spoiler > sb-overlay').shadowRoot.querySelector('[data-a="once"]').click());
await sleep(500);
report.push(`## after "Show once" on #t-spoiler\n${fmt((await state()).filter((x) => x.id === 't-spoiler'))}`);

// 6) popup "Only block actual spoilers" switch, live then after reload
await extEval(() => document.getElementById('spoilerMode').click());
await sleep(500);
report.push(`## settings after popup switch: ${JSON.stringify(await storage(async () => (await (globalThis.browser ?? chrome).storage.local.get('settings')).settings))}`);
await section('spoiler-mode-live');
await page.reload({ waitUntil: 'domcontentloaded' });
await section('spoiler-mode-reload');
report.push(`## content-script init with the updated (stored) index: ${await page.evaluate(() => document.documentElement.getAttribute('data-sb-ready'))} ms`);
await extEval(() => document.getElementById('spoilerMode').click());
await sleep(500);
await section('back-to-any-mode-live');

// 7) pause the site live
await storage(() => (globalThis.browser ?? chrome).storage.local.set({ settings: { enabled: true, scanImages: true, pausedSites: ['localhost'], mode: 'any' } }));
await sleep(1000);
const paused = await state();
report.push(`## paused site: blocked count ${paused.filter((x) => x.blocked).length}`);
if (target === 'chrome') {
  const mt = await page.metrics();
  report.push(`## fixture tab JS heap (page + content script isolated world): ${(mt.JSHeapUsedSize / 1e6).toFixed(1)} MB used / ${(mt.JSHeapTotalSize / 1e6).toFixed(1)} MB total`);
}

// memory of the process hosting the models (Firefox: the "extension" process; Chrome: the extension renderer)
try {
  if (target === 'firefox') {
    const info = await chromeEval(`ChromeUtils.requestProcInfo().then((p) => JSON.stringify(p.children.map((c) => [c.type, Math.round(c.memory / 1048576)])))`);
    report.push(`## Zen child processes [type, resident MB]\n${info}`);
  } else {
    const ps = execSync("ps -eo rss,args | grep -E 'chrome.*--extension-process' | grep -v grep").toString();
    report.push(`## Chrome extension process RSS\n${ps.split('\n').filter(Boolean).map((l) => (parseInt(l) / 1024).toFixed(0) + ' MB').join('\n')}`);
  }
} catch (e) { report.push('memory: ' + e.message); }

report.push(`## requests to the cross-origin image server (refetches by the background)\n${log.img.join('\n')}`);
const hosts = {};
for (const l of log.proxy) hosts[l] = (hosts[l] ?? 0) + 1;
report.push(`## requests that tried to leave the machine (proxy log, all refused; unique)\n${Object.entries(hosts).map(([h, n]) => `${n}x ${h}`).join('\n') || '(none)'}`);
report.push(`## page console\n${consoleLog.filter((l) => /SpolierBlocker|error/i.test(l)).slice(0, 40).join('\n') || '(clean)'}`);
fs.writeFileSync(path.join(OUT, `${target}-report.txt`), report.join('\n\n') + '\n');
console.log(report.join('\n\n'));

await browser.close().catch(() => {});
child?.kill('SIGINT');
servers.forEach((s) => s.close());
process.exit(process.exitCode ?? 0);
