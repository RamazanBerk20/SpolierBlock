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
// The content script needs to run in frames (embedded posts, YouTube live chat). Applied here until manifest.json has it.
const mf = JSON.parse(fs.readFileSync(path.join(EXT, 'manifest.json'), 'utf8'));
Object.assign(mf.content_scripts[0], { all_frames: true, match_about_blank: true });
fs.writeFileSync(path.join(EXT, 'manifest.json'), JSON.stringify(mf, null, 2));
// SB_CONTENT=<dir with content.js/content.css>: run another content script (e.g. 0.1) against the same pages
if (process.env.SB_CONTENT) for (const f of ['content.js', 'content.css']) fs.copyFileSync(path.join(process.env.SB_CONTENT, f), path.join(EXT, 'src/content', f));
const only = process.env.ONLY; // ONLY=1: skip the 0.1 flow and run the 0.2 cases only; ONLY=feed,coverage: those cases
const want = (s) => !only || only === '1' || only.split(',').includes(s);

const types = { '.jpg': 'image/jpeg', '.png': 'image/png', '.webm': 'video/webm', '.html': 'text/html' };
const PAGES = { '/': 'fixture.html', '/feed': 'feed.html', '/coverage': 'coverage.html' };
let PICS = null; // pictures the shipped engine titles / calls generic media, chosen at run time (see the 0.2 cases)
// a long static feed for the scan-cost measurement: 3,000 posts, one in ten names a work
const longPage = () => '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>long feed</title></head><body><main id="feed">' +
  Array.from({ length: 3000 }, (_, i) => `<article class="post"><div class="who">@user${i}</div><p>${i % 10 === 3
    ? "Can't believe Walter White ends up like that in the last episode."
    : `Post number ${i}: lovely weather in the park today, the ducks were out and the coffee was good.`}</p></article>`).join('') +
  '</main><script>window.burst = () => new Promise((r) => { const t = performance.now(), f = document.getElementById("feed");' +
  'for (let i = 0; i < 500; i++) { const a = document.createElement("article"); a.className = "post";' +
  'a.innerHTML = `<div class="who">@new${i}</div><p>${i % 10 === 3 ? "Snape kills Dumbledore at the end of the sixth book." : "Another ordinary post about lunch " + i}</p>`; f.prepend(a); }' +
  'requestAnimationFrame(() => r(performance.now() - t)); });</script></body></html>';
function staticServer(port, name, html) {
  return http.createServer((req, res) => {
    log[name].push(`${req.method} ${req.url} ua=${(req.headers['user-agent'] ?? '').slice(0, 20)} sec-fetch-site=${req.headers['sec-fetch-site'] ?? ''}`);
    const u = new URL(req.url, 'http://x');
    if (html && u.pathname === '/long') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end(longPage()); }
    const page = html ? PAGES[u.pathname] : u.pathname === '/frame.html' && 'frame.html';
    if (page) {
      res.writeHead(200, { 'content-type': 'text/html' });
      return res.end(fs.readFileSync(path.join(ROOT, 'test/e2e', page), 'utf8')
        .replaceAll('{{IMG}}', `http://127.0.0.1:${IMG}`).replaceAll('{{SELF}}', `http://localhost:${PAGE}/img`)
        .replaceAll('{{FRAME}}', `http://127.0.0.1:${IMG}/frame.html`)
        .replaceAll('{{PICS}}', JSON.stringify(PICS)).replaceAll('{{BG}}', PICS?.a?.file ?? 'clean_dog.jpg'));
    }
    const f = path.join(IMG_DIR, path.basename(u.pathname));
    if (!fs.existsSync(f)) { res.writeHead(404); return res.end(); }
    // ?d=ms delays the answer: images that arrive after the page has laid out and recycled the post
    setTimeout(() => {
      res.writeHead(200, { 'content-type': types[path.extname(f)] ?? 'application/octet-stream', 'cache-control': 'max-age=3600' });
      fs.createReadStream(f).pipe(res);
    }, +(u.searchParams.get('d') ?? 0));
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
    if (q.includes('VALUES ?l')) return res.end(bindings([])); // "name means something else" lookup: nothing else has the name
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
    'extensions.webextensions.uuids': JSON.stringify({ 'spolierblock@local': uuid }),
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
let extPage, extEval, chromeEval, extReload, extGo, optionsTabs, closeOptionsTabs;
const OPTIONS = '/src/options/options.html';
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
  for (let i = 0; i < 30 && !host; i++) { host = await chromeEval(`WebExtensionPolicy.getByID('spolierblock@local')?.mozExtensionHostname ?? null`); if (!host) await sleep(500); }
  extBase = `moz-extension://${host}`;
  await chromeEval(`openTrustedLinkIn(${JSON.stringify('moz-extension://' + host + '/src/popup/popup.html')}, 'tab'); true`);
  let ctx;
  for (let i = 0; i < 20 && !ctx; i++) {
    await sleep(500);
    const t = await conn.send('browsingContext.getTree', {});
    ctx = (t.result ?? t).contexts.find((c) => c.url.startsWith(extBase))?.context;
  }
  extReload = () => conn.send('browsingContext.reload', { context: ctx, wait: 'complete' });
  const tabsAt = async (p) => ((await conn.send('browsingContext.getTree', {})).result ?? {}).contexts?.filter((c) => c.url.includes(p) && c.context !== ctx) ?? [];
  optionsTabs = async () => (await tabsAt(OPTIONS)).length;
  closeOptionsTabs = async () => { for (const c of await tabsAt(OPTIONS)) await conn.send('browsingContext.close', { context: c.context }); };
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
  extGo = (p) => extPage.goto(extBase + p);
  const tabsAt = async (p) => (await browser.pages()).filter((x) => x !== extPage && x.url().includes(p));
  optionsTabs = async () => (await tabsAt(OPTIONS)).length;
  closeOptionsTabs = async () => { for (const x of await tabsAt(OPTIONS)) await x.close(); };
}
// Firefox: the extension tab navigates itself (BiDi may not navigate a tab to moz-extension:)
extGo ??= async (p) => {
  await extEval((p) => { setTimeout(() => location.assign(p), 0); }, p);
  for (let i = 0; i < 40; i++) {
    await sleep(250);
    try { if (await extEval((p) => location.pathname === p && document.readyState === 'complete', p)) break; } catch {}
  }
  await sleep(500);
};
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

if (!only) {
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

// 3) "I've seen it" on an overlay: marks every work of the name group in one write to `works`, keeping the
// works the 0.1 popup put in `seen` (migrated on that first write)
const dynLabel = (await state()).find((x) => x.id === 't-dynamic').overlay;
await page.evaluate(() => document.querySelector('#t-dynamic > sb-overlay').shadowRoot.querySelector('[data-a="seen"]').click());
await sleep(1500);
const seenNow = await storage(async () => (await (globalThis.browser ?? chrome).storage.local.get('works')).works ?? {});
report.push(`## after overlay "I've seen" on #t-dynamic (${dynLabel}): ${fmt((await state()).filter((x) => x.id === 't-dynamic'))}\nstorage.works: ${Object.keys(seenNow).length} works: ${Object.values(seenNow).map((w) => `${w.title} (${w.state})`).join(' | ')}`);
await page.reload({ waitUntil: 'domcontentloaded' });
await section('after-seen-reload');
report.push(`## content-script init on this tab (fetch index + parse + first scan): ${await page.evaluate(() => document.documentElement.getAttribute('data-sb-ready'))} ms`);

// 4) popup status line (tab.stats) for the fixture tab
await extReload();
await sleep(1500);
report.push(`## popup status: "${await extEval(() => document.getElementById('status').textContent)}"`);

// 4b) Opt-in catalog update, driven through the settings page against the mock endpoint.
await extGo(OPTIONS);
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

// 6) settings page "Cover only spoilers", live then after reload
await extEval(() => document.querySelector('input[name="style"][value="spoilers"]').click());
await sleep(500);
report.push(`## settings after popup switch: ${JSON.stringify(await storage(async () => (await (globalThis.browser ?? chrome).storage.local.get('settings')).settings))}`);
await section('spoiler-mode-live');
await page.reload({ waitUntil: 'domcontentloaded' });
await section('spoiler-mode-reload');
report.push(`## content-script init with the updated (stored) index: ${await page.evaluate(() => document.documentElement.getAttribute('data-sb-ready'))} ms`);
await extEval(() => document.querySelector('input[name="style"][value="all"]').click());
await sleep(500);
await section('back-to-any-mode-live');
await extGo('/src/popup/popup.html');
}

// ---------- 0.2 (docs/agents/contract.md): states, styles, wording, recycled feed, coverage, scan cost ----------
const META = JSON.parse(fs.readFileSync(path.join(EXT, 'data/index.json'), 'utf8'));
const worksOf = (label, entry) => Object.fromEntries(META.groups.find((g) => g[0] === label).slice(1)
  .map((w) => [META.ids[w], { title: META.titles[w], type: META.types[w], year: META.years[w] || null, ts: 1, style: null, ...entry }]));
const DEF = { enabled: true, scanImages: true, blockUnlisted: true, style: 'all', unknownImages: false, pausedSites: [], catalogUpdate: 'off' };
const setConfig = async (works, s = {}) => {
  await storage((a) => (globalThis.browser ?? chrome).storage.local.set(a), { works, settings: { ...DEF, ...s } });
  await sleep(1000);
};
const check = (name, ok, detail = '') => {
  report.push(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` :: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : ''}`);
  if (!ok) process.exitCode = 1;
};
// cover of an element: null when not covered, else its label, buttons, theme and heights (cover vs block)
const INFO = `(el) => {
  if (!el) return 'missing';
  if (!el.hasAttribute('data-sb-blocked')) return null;
  const ov = [...el.children, ...(el.shadowRoot?.children ?? [])].find((c) => c.localName === 'sb-overlay');
  const sr = ov?.shadowRoot;
  return { label: sr?.querySelector('p')?.textContent ?? null, seen: sr ? !sr.querySelector('[data-a="seen"]').hidden : null,
    menu: sr?.querySelector('[data-a="menu"]')?.getAttribute('aria-label') ?? null, dark: !!ov?.hasAttribute('data-dark'),
    oh: ov ? Math.round(ov.getBoundingClientRect().height) : null, bh: Math.round(el.getBoundingClientRect().height) };
}`;
const covered = (ids, ctx = page) => ctx.evaluate(`(${JSON.stringify(ids)}).reduce((o, id) => (o[id] = (${INFO})(document.getElementById(id)), o), {})`);
const lab = (x) => x?.label ?? null;
const open = async (p) => {
  await page.goto(`http://localhost:${PAGE}${p}`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => document.documentElement.hasAttribute('data-sb-ready'));
};
const POSTS = ['t-breaking', 't-neutral', 't-spoiler', 't-got-neutral', 't-got-spoiler', 'x-titled', 'x-generic'];
const skip = (name, why) => report.push(`SKIP ${name} :: ${why}`);

// Which pictures get a title or the generic "film/show/game media" verdict depends on the image model and the catalog,
// so the image cases ask the shipped engine (through the background, like the content script, with the same cache key)
// and use pictures it really judges that way. OCR text must be empty, so the text path cannot decide the cover instead.
let TITLED = null, GENERIC = null;
if (want('states') || want('feed') || want('coverage')) {
  const ask = (msg) => extEval(async (m) => {
    for (let i = 0; ; i++) {
      try { return await (globalThis.browser ?? chrome).runtime.sendMessage(m); } catch (e) {
        if (i > 20) return { error: String(e) };
        await new Promise((r) => setTimeout(r, 500)); // the background may still be starting
      }
    }
  }, msg);
  const files = fs.readdirSync(IMG_DIR).filter((f) => /^(spoiler_|pos_)/.test(f)).sort();
  const hits = {};
  await Promise.all(files.map(async (f) => { const url = `http://127.0.0.1:${IMG}/${f}`; hits[f] = (await ask({ type: 'img.check', key: url, url, prio: 0 }))?.hits ?? []; }));
  const pick = async (ok) => {
    for (const f of files) {
      if (!ok(hits[f])) continue;
      const url = `http://127.0.0.1:${IMG}/${f}`;
      if (!(await ask({ type: 'img.ocr', key: url, url, prio: 0 }))?.text) return { file: f, url, hits: hits[f] };
    }
    return null;
  };
  TITLED = await pick((h) => h.some(([g]) => g >= 0));
  GENERIC = await pick((h) => h.length > 0 && h.every(([g]) => g === -1));
  if (TITLED) {
    const gs = TITLED.hits.map(([g]) => g).filter((g) => g >= 0);
    TITLED.label = `Image from ${META.groups[gs[0]][0]}${gs.length > 1 ? ` and ${gs.length - 1} more` : ''}`;
  }
  if (GENERIC) GENERIC.label = 'Possible film, show or game image';
  const a = TITLED ?? GENERIC;
  PICS = { a: a && { file: a.file, expect: a.label }, b: GENERIC && { file: GENERIC.file, expect: GENERIC.label } };
  report.push(`## engine verdicts on the media fixtures (fixture catalog): ${Object.entries(hits).filter(([, h]) => h.length).map(([f, h]) => `${f} ${JSON.stringify(h)}`).join(', ') || 'none'}\n` +
    `titled picture: ${TITLED ? `${TITLED.file} -> "${TITLED.label}"` : 'none'}; generic picture: ${GENERIC?.file ?? 'none'}`);
}
const NO_TITLE = 'the engine titles no media fixture with the fixture catalog (no OCR text), so nothing can prove this with a real verdict';
const NO_GENERIC = 'the engine gives no media fixture the generic verdict without OCR text';
// the chosen pictures as posts on the fixture page (after each load)
const addPicPosts = () => page.evaluate((ps) => {
  for (const [id, f] of ps) {
    if (!f || document.getElementById(id)) continue;
    const a = document.createElement('article');
    a.className = 'post'; a.id = id;
    a.innerHTML = `<div class="who">@pic</div><p>Look at this.</p><img alt="" src="${f}">`;
    document.getElementById('feed').append(a);
  }
}, [['x-titled', TITLED?.url], ['x-generic', GENERIC?.url]]);

let c;
if (want('states')) {
// A) defaults: every work unlisted, style all, unknown images off
await setConfig({});
await open('/');
await addPicPosts();
await settle();
c = await covered(POSTS);
report.push(`## 0.2 defaults\n${JSON.stringify(c)}`);
check('style all: "Mentions {t}"', lab(c['t-breaking']) === 'Mentions Breaking Bad' && lab(c['t-neutral']) === 'Mentions Star Wars', c['t-breaking']);
check('buttons: Show once, I\'ve seen it, settings', c['t-breaking']?.seen === true && c['t-breaking']?.menu === 'SpolierBlock settings');
if (TITLED) check('image identified: "Image from {t}"', lab(c['x-titled']) === TITLED.label, { got: c['x-titled'], want: TITLED.label });
else skip('image identified: "Image from {t}"', NO_TITLE);
if (GENERIC) check('unknownImages off: unidentified media image not covered', c['x-generic'] === null, c['x-generic']);
else skip('unknownImages off', NO_GENERIC);

// B) unknownImages on (live)
await setConfig({}, { unknownImages: true });
c = await covered(['x-generic']);
if (GENERIC) check('unknownImages on: "Possible film, show or game image" without "I\'ve seen it"', lab(c['x-generic']) === GENERIC.label && c['x-generic'].seen === false, c['x-generic']);
else skip('unknownImages on', NO_GENERIC);

// C) seen never covers; blockUnlisted off covers only blocked groups
await setConfig(worksOf('Breaking Bad', { state: 'seen' }));
c = await covered(POSTS);
check('seen work not covered', c['t-breaking'] === null && lab(c['t-spoiler']) === 'Mentions Star Wars', c);
await setConfig(worksOf('Game of Thrones', { state: 'blocked' }), { blockUnlisted: false });
c = await covered(POSTS);
check('blockUnlisted off: only the blocked work is covered', lab(c['t-got-neutral']) === 'Mentions Game of Thrones' &&
  c['t-breaking'] === null && c['t-spoiler'] === null && (!TITLED || c['x-titled'] === null), c);

// D) style spoilers: "Checking …" while the classifier runs, then "Spoiler about {t}" or uncovered
await setConfig({}, { style: 'spoilers' });
await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => document.documentElement.hasAttribute('data-sb-ready'));
const early = await covered(['t-spoiler']);
await addPicPosts();
report.push(`## style spoilers, first label: ${JSON.stringify(early)}`);
await settle();
c = await covered(POSTS);
check('style spoilers: first label is "Checking {t} for spoilers…" (timing-dependent)', lab(early['t-spoiler']) === 'Checking Star Wars for spoilers…' || lab(early['t-spoiler']) === 'Spoiler about Star Wars', early);
check('style spoilers: "Spoiler about {t}", neutral post uncovered', lab(c['t-spoiler']) === 'Spoiler about Star Wars' && c['t-neutral'] === null, c);
if (TITLED) check('style spoilers: identified image still covered', lab(c['x-titled']) === TITLED.label, { got: c['x-titled'], want: TITLED.label });
else skip('style spoilers: identified image still covered', NO_TITLE);
// per-work style overrides the default
await setConfig(worksOf('Star Wars', { state: 'blocked', style: 'all' }), { style: 'spoilers' });
c = await covered(POSTS);
check('per-work style all under default spoilers', lab(c['t-neutral']) === 'Mentions Star Wars', c['t-neutral']);

// E) "I've seen it" writes works; the settings button sends ui.openSettings
await setConfig({});
await closeOptionsTabs();
await page.evaluate(() => document.querySelector('#t-breaking > sb-overlay').shadowRoot.querySelector('[data-a="menu"]')?.click());
let optTabs = 0;
for (let k = 0; k < 20 && !optTabs; k++) { await sleep(250); optTabs = await optionsTabs(); }
check('settings button opens the settings page', optTabs === 1, { optionsTabs: optTabs });
await closeOptionsTabs();
await page.bringToFront(); // a background tab gets no animation frames
await page.evaluate(() => document.querySelector('#t-breaking > sb-overlay').shadowRoot.querySelector('[data-a="seen"]').click());
await sleep(1200);
const w = await storage(async () => (await (globalThis.browser ?? chrome).storage.local.get('works')).works);
c = await covered(['t-breaking']);
check('"I\'ve seen it" writes works[id].state = "seen"', Object.values(w ?? {}).some((x) => x.title === 'Breaking Bad' && x.state === 'seen') && c['t-breaking'] === null, w);

}

if (want('feed')) {
// F) virtualised, recycled, height-measured feed with late images (scan images on, unknown images on)
await setConfig({}, { unknownImages: true });
await open('/feed');
const problems = new Set();
const inspect = async (final) => {
  const rows = await page.evaluate(() => window.feedState());
  for (const r of rows) {
    if (Math.abs(r.height - r.measured) > 0.5) problems.add(`item ${r.i}: height changed after the feed measured it (${r.measured} -> ${r.height})`);
    if (r.pendingVisible) problems.add(`item ${r.i}: photo visible before its verdict`);
    if (r.covered && !r.expect) problems.add(`item ${r.i}: clean post covered ("${r.label}")`);
    if (final && r.expect && r.label !== r.expect) problems.add(`item ${r.i}: label ${JSON.stringify(r.label)}, want "${r.expect}"${r.imgOk ? '' : ' (no verdict yet)'}`);
  }
  for (let k = 1; k < rows.length; k++) {
    const a = rows[k - 1], b = rows[k];
    if (b.i === a.i + 1 && a.bottom > b.top + 0.5) problems.add(`items ${a.i} and ${b.i} overlap by ${Math.round(a.bottom - b.top)} px`);
  }
};
const feedEnd = await page.evaluate(() => document.documentElement.scrollHeight - innerHeight);
for (let y = 0; y <= feedEnd + 300; y += 350) { await page.evaluate((y) => scrollTo(0, y), y); await sleep(120); await inspect(false); }
for (let y = feedEnd; y >= 0; y -= 500) { await page.evaluate((y) => scrollTo(0, y), y); await sleep(300); await inspect(false); }
for (const y of [0, Math.round(feedEnd / 2), feedEnd]) {
  await page.evaluate((y) => scrollTo(0, y), y);
  const visibleIn = () => page.evaluate(() => document.documentElement.getAttribute('data-sb-busy') === '0' &&
    [...document.querySelectorAll('.cell')].filter((n) => !n.querySelector('.media').hidden && n.getBoundingClientRect().bottom > 0 &&
      n.getBoundingClientRect().top < innerHeight).every((n) => n.querySelector('img').hasAttribute('data-sb-ok')));
  for (let k = 0; k < 360 && !(await visibleIn()); k++) await sleep(500); // Firefox runs the models on one thread
  await sleep(800);
  await inspect(true);
}
await page.screenshot({ path: path.join(OUT, `${target}-feed.png`) });
const kinds = {};
for (const p of problems) (kinds[['overlap', 'height changed', 'before its verdict', 'clean post covered', 'label'].find((k) => p.includes(k))] ??= []).push(p);
check('recycled feed: no overlap, no height change, covers belong to their post, labels right', !problems.size,
  Object.values(kinds).map((ps) => `${ps.length}x, e.g. ${ps.slice(0, 3).join(' | ')}`).join('; ') +
  ` (stats ${await page.evaluate(() => document.documentElement.getAttribute('data-sb-stats'))})`);
}

if (want('coverage')) {
// G) coverage: DMs, typeahead, notifications, quote post, background image, shadow DOM, frames, title, height, theme
await setConfig({}, { unknownImages: true });
await open('/coverage');
await sleep(3000); // sb-late-card is defined after 1.2 s
for (let k = 0; k < 120 && !(await page.evaluate(() => document.documentElement.getAttribute('data-sb-busy') === '0' && document.querySelector('.pic')?.hasAttribute('data-sb-ok'))); k++) await sleep(500);
c = await covered(['dm-23', 'dm-22', 'dm-thread', 'ta-spoil', 'ta-clean', 'n-spoil', 'n-clean', 'quoted', 'quote', 'bg-post', 'short', 'short-twin', 'dark-post']);
report.push(`## coverage\n${JSON.stringify(c)}`);
check('DM: the message row is covered, not the thread', lab(c['dm-23']) === 'Mentions Breaking Bad' && c['dm-22'] === null && c['dm-thread'] === null, c['dm-23']);
check('search suggestion covered', lab(c['ta-spoil']) === 'Mentions Breaking Bad' && c['ta-clean'] === null, c['ta-spoil']);
check('notification covered', lab(c['n-spoil']) === 'Mentions Breaking Bad' && c['n-clean'] === null, c['n-spoil']);
// the outer post's text includes the quote, so the whole post is covered; its cover hides the inner one
const quoteVisible = await page.evaluate(() => [...document.querySelectorAll('#quote sb-overlay')].filter((o) => getComputedStyle(o).visibility === 'visible').length);
check('quote post: covered, one visible cover', lab(c['quote']) === 'Mentions Game of Thrones' && quoteVisible === 1, { quote: c['quote'], quoteVisible });
if (PICS.a) check(`CSS background-image photo judged: "${PICS.a.expect}"`, lab(c['bg-post']) === PICS.a.expect, c['bg-post']);
else skip('CSS background-image photo', NO_GENERIC);
const twinH = await page.evaluate(() => document.getElementById('short-twin').getBoundingClientRect().height);
check('short block: height unchanged, cover not taller than the block', c['short'] && c['short'].bh === Math.round(twinH) && c['short'].oh <= c['short'].bh, { short: c['short'], twinH });
check('dark section: dark cover', c['dark-post']?.dark === true && c['short']?.dark === false, { dark: c['dark-post'], light: c['short'] });
const shadow = await page.evaluate(`({
  open: (${INFO})(document.getElementById('sh-open').shadowRoot.querySelector('article')),
  closed: (${INFO})(window.__closedRoot.querySelector('article')),
  late: (${INFO})(document.getElementById('sh-late').shadowRoot?.querySelector('article')),
  srcdoc: (${INFO})(document.getElementById('fr-srcdoc').contentDocument?.getElementById('f1')),
  title: document.title })`);
const cross = page.frames().find((f) => f.url().includes('frame.html'));
const crossC = cross ? (await covered(['f2'], cross)).f2 : 'no frame';
report.push(`## shadow DOM, frames, title\n${JSON.stringify({ ...shadow, cross: crossC })}`);
check('open shadow root covered', lab(shadow.open) === 'Mentions Star Wars', shadow.open);
check('closed shadow root covered', lab(shadow.closed) === 'Mentions Harry Potter', shadow.closed);
check('shadow root attached after the element was seen', lab(shadow.late) === 'Mentions Game of Thrones', shadow.late);
check('about:srcdoc iframe covered', lab(shadow.srcdoc) === 'Mentions Harry Potter', shadow.srcdoc);
check('cross-origin iframe covered', lab(crossC) === 'Mentions Star Wars', crossC);
check('document.title replaced', shadow.title === 'Mentions Breaking Bad', shadow.title);

}

if (want('perf')) {
// H) scan cost on a long feed: first scan of 3,000 posts (init), and 500 posts inserted at once (to the next frame)
await setConfig({});
const burst = async () => { const r = []; for (let k = 0; k < 3; k++) { await open('/long'); r.push(await page.evaluate(() => window.burst())); } return r.sort((a, b) => a - b)[1]; };
const inits = [];
for (let k = 0; k < 3; k++) { await open('/long'); inits.push(+(await page.evaluate(() => document.documentElement.getAttribute('data-sb-ready')))); }
const on = await burst();
await setConfig({}, { pausedSites: ['localhost'] });
const offB = await burst();
report.push(`## scan cost, 3,000-post page: init + first scan ${inits.sort((a, b) => a - b)[1]} ms (median of 3); 500 posts inserted -> next frame ${on.toFixed(1)} ms active, ${offB.toFixed(1)} ms paused`);
await setConfig({});
}

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
report.push(`## page console\n${consoleLog.filter((l) => /SpolierBlock|error/i.test(l)).slice(0, 40).join('\n') || '(clean)'}`);
fs.writeFileSync(path.join(OUT, `${target}-report.txt`), report.join('\n\n') + '\n');
console.log(report.join('\n\n'));

await browser.close().catch(() => {});
child?.kill('SIGINT');
servers.forEach((s) => s.close());
process.exit(process.exitCode ?? 0);
