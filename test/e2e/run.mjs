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
// The fixture catalog has no series, so the picker's "More from this series" section gets a test-only series in the index
// meta (`series`: one array of work indices per series, oldest first): Dune's two works plus eight other fixture works.
const SERIES_EXTRA = ['Inception', 'Interstellar', 'Ratatouille', 'Cars', 'Rocky II', 'Chernobyl', 'Severance', 'Napoleon'];
{
  const f = path.join(EXT, 'data/index.json'), m = JSON.parse(fs.readFileSync(f, 'utf8'));
  if (!m.series?.length) {
    const ws = [...m.groups.find((g) => g[0] === 'Dune').slice(1), ...SERIES_EXTRA.map((t) => m.titles.indexOf(t))];
    m.series = [ws.sort((a, b) => (m.years[a] || 1e4) - (m.years[b] || 1e4) || a - b)];
    fs.writeFileSync(f, JSON.stringify(m));
  }
}
// SB_CONTENT=<dir with content.js/content.css>: run another content script (e.g. 0.1) against the same pages
if (process.env.SB_CONTENT) for (const f of ['content.js', 'content.css']) fs.copyFileSync(path.join(process.env.SB_CONTENT, f), path.join(EXT, 'src/content', f));
// The test build reads the image server's host (127.0.0.1) as youtube.com, so test/e2e/yt.html gets the youtube.com
// selectors and the uploader part, and the page /x as x.com (rule 10's caption element) (no real site is opened).
{
  const f = path.join(EXT, 'src/content/content.js'), src = fs.readFileSync(f, 'utf8');
  const at = "const host = hostname.replace(/^www\\.|^mobile\\.|^m\\./, '');";
  if (!src.includes(at)) throw new Error('content.js: host line not found for the youtube.com test mapping');
  fs.writeFileSync(f, src.replace(at, at.replace("= hostname", "= location.pathname === '/x' ? 'x.com' : hostname")
    .replace(";", ".replace(/^127\\.0\\.0\\.1$/, 'youtube.com');")));
}
const only = process.env.ONLY; // ONLY=1: skip the 0.1 flow and run the 0.2 cases only; ONLY=feed,coverage: those cases
const want = (s) => !only || only === '1' || only.split(',').includes(s);

const types = { '.jpg': 'image/jpeg', '.png': 'image/png', '.webm': 'video/webm', '.html': 'text/html' };
const PAGES = { '/': 'fixture.html', '/feed': 'feed.html', '/coverage': 'coverage.html', '/videos': 'videos.html', '/x': 'videos.html' };
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
    const page = html ? PAGES[u.pathname] : { '/frame.html': 'frame.html', '/yt.html': 'yt.html' }[u.pathname];
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
    'media.autoplay.default': 0, 'media.autoplay.blocking_policy': 0, // the page may start sound (covered-video case)
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
    args: [`--proxy-server=http://127.0.0.1:${PROXY}`, '--no-first-run', '--no-default-browser-check', '--autoplay-policy=no-user-gesture-required'],
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
const DEF = { enabled: true, scanImages: true, blockUnlisted: true, style: 'all', unknownImages: false, pausedSites: [], captionlessVideos: [], catalogUpdate: 'off' };
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
    not: sr ? !sr.querySelector('[data-a="not"]').hidden : null,
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
let TITLED = null, GENERIC = null, OCRTITLED = null;
// the shipped matcher on this build's index, for preconditions (what does a picture's OCR text name?)
await import(path.join(ROOT, 'src/content/matcher.js'));
const nodeMatcher = new globalThis.SBMatcher.Matcher(new Uint8Array(fs.readFileSync(path.join(EXT, 'data/index.bin'))).buffer, META);
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
    TITLED.group = META.groups[gs[0]][0];
    TITLED.label = `Image from ${TITLED.group}${gs.length > 1 ? ` and ${gs.length - 1} more` : ''}`;
  }
  // rule 7, OCR half: a picture the model titles whose own text names a work (ocrtitle_fightclub.jpg: the Nosferatu still
  // with "FIGHT CLUB" printed on it; checked here, since a caption can change the model's verdict)
  {
    const url = `http://127.0.0.1:${IMG}/ocrtitle_fightclub.jpg`;
    const h = (await ask({ type: 'img.check', key: url, url, prio: 0 }))?.hits ?? [];
    const text = (await ask({ type: 'img.ocr', key: url, url, prio: 0 }))?.text ?? '';
    const named = nodeMatcher.evaluate('\u0001' + text).map((g) => META.groups[g][0]);
    if (h.some(([g]) => g >= 0) && named.length) OCRTITLED = { url, named };
    report.push(`## ocrtitle_fightclub.jpg: hits ${JSON.stringify(h)}, OCR ${JSON.stringify(text)} names ${JSON.stringify(named)}`);
  }
  if (GENERIC) GENERIC.label = 'Possible film, show or game image';
  const a = TITLED ?? GENERIC;
  PICS = { a: a && { file: a.file, expect: a.label }, b: GENERIC && { file: GENERIC.file, expect: GENERIC.label } };
  report.push(`## engine verdicts on the media fixtures (fixture catalog): ${Object.entries(hits).filter(([, h]) => h.length).map(([f, h]) => `${f} ${JSON.stringify(h)}`).join(', ') || 'none'}\n` +
    `titled picture: ${TITLED ? `${TITLED.file} -> "${TITLED.label}"` : 'none'}; generic picture: ${GENERIC?.file ?? 'none'}`);
}
const NO_TITLE = 'the engine titles no media fixture with the fixture catalog (no OCR text), so nothing can prove this with a real verdict';
const NO_GENERIC = 'the engine gives no media fixture the generic verdict without OCR text';
// a post added to the fixture page; mediaDone waits for its pictures' verdicts
const addPost = (id, text, img) => page.evaluate(([id, text, img]) => {
  if (document.getElementById(id)) return;
  const a = document.createElement('article');
  a.className = 'post'; a.id = id;
  a.innerHTML = `<div class="who">@pic</div><p></p>${img ? `<img alt="" src="${img}">` : ''}`;
  a.querySelector('p').textContent = text;
  document.getElementById('feed').append(a);
}, [id, text, img ?? null]);
const mediaDone = async (id) => {
  await page.evaluate((id) => document.getElementById(id)?.scrollIntoView({ block: 'center' }), id);
  await page.waitForFunction((id) => document.documentElement.getAttribute('data-sb-busy') === '0' &&
    [...document.querySelectorAll(`#${id} img`)].every((m) => m.hasAttribute('data-sb-ok')), { timeout: 180000 }, id);
};
// the chosen pictures as posts on the fixture page (after each load)
const addPicPosts = async () => {
  if (TITLED) await addPost('x-titled', 'Look at this.', TITLED.url);
  if (GENERIC) await addPost('x-generic', 'Look at this.', GENERIC.url);
};

let c;
// the 0.1 flow's catalog update stored a rebuilt index; the 0.2 cases use the bundled one (it has the series column)
await storage(() => (globalThis.browser ?? chrome).storage.local.remove('catalogIndex'));
await sleep(1000);
if (want('states')) {
// A) defaults: every work unlisted, style all, unknown images off
await setConfig({});
await open('/');
await addPicPosts();
await settle();
c = await covered(POSTS);
report.push(`## 0.2 defaults\n${JSON.stringify(c)}`);
check('style all: "Mentions {t}"', lab(c['t-breaking']) === 'Mentions Breaking Bad' && lab(c['t-neutral']) === 'Mentions Star Wars', c['t-breaking']);
check('buttons: Show once, I\'ve seen it, Not this, settings', c['t-breaking']?.seen === true && c['t-breaking']?.not === true && c['t-breaking']?.menu === 'SpolierBlock settings');
if (TITLED) check('image identified: "Image from {t}"', lab(c['x-titled']) === TITLED.label, { got: c['x-titled'], want: TITLED.label });
else skip('image identified: "Image from {t}"', NO_TITLE);
if (GENERIC) check('unknownImages off: unidentified media image not covered', c['x-generic'] === null, c['x-generic']);
else skip('unknownImages off', NO_GENERIC);
// rule 7, label order: a group the post's own text names comes before one named only by its picture's OCR text
// (Harry Potter sorts before Game of Thrones in the index)
await addPost('x-order', 'Game of Thrones: the Red Wedding where Robb Stark gets murdered.', `http://127.0.0.1:${IMG}/ocr_spoiler_snape.png`);
await mediaDone('x-order');
c = await covered(['x-order', 'i-ocr']);
check('label: own-text group first, then the OCR-only one', lab(c['i-ocr']) === 'Mentions Harry Potter'
  ? lab(c['x-order']) === 'Mentions Game of Thrones and 1 more' : lab(c['x-order']) === 'Mentions Game of Thrones', c);

// B) unknownImages on (live)
await setConfig({}, { unknownImages: true });
c = await covered(['x-generic']);
if (GENERIC) check('unknownImages on: "Possible film, show or game image" without "I\'ve seen it" and "Not this"', lab(c['x-generic']) === GENERIC.label && c['x-generic'].seen === false && c['x-generic'].not === false, c['x-generic']);
else skip('unknownImages on', NO_GENERIC);

// C) seen never covers; blockUnlisted off covers only blocked groups
await setConfig(worksOf('Breaking Bad', { state: 'seen' }));
c = await covered(POSTS);
check('seen work not covered', c['t-breaking'] === null && lab(c['t-spoiler']) === 'Mentions Star Wars', c);
// rule 7: the post's own text names a seen work and no covered one, so the title on its picture does not cover it
if (TITLED) {
  await addPost('x-rule7', 'Walter White was great. Look at this poster.', TITLED.url);
  await mediaDone('x-rule7');
  c = await covered(['x-rule7', 'x-titled']);
  check('rule 7: own text names a seen work -> its picture\'s title does not cover', c['x-rule7'] === null && lab(c['x-titled']) === TITLED.label, c);
} else skip('rule 7', NO_TITLE);
// rule 7: the picture's title is dropped when its own (OCR) text names a work, here a seen one
if (OCRTITLED && TITLED) {
  await setConfig(worksOf(OCRTITLED.named[0], { state: 'seen' })); // the work its text names does not cover by itself
  await addPost('x-7a-ocr', 'Look at this.', OCRTITLED.url);
  await mediaDone('x-7a-ocr');
  c = await covered(['x-7a-ocr', 'x-titled']);
  check('rule 7: the picture\'s OCR text names a work -> no title from the model', c['x-7a-ocr'] === null && lab(c['x-titled']) === TITLED.label, c);
} else skip('rule 7, picture text', 'the engine does not title ocrtitle_fightclub.jpg, or its OCR text names no work');
// ... and when the post's own text names any work, even one that does not cover (unlisted, blockUnlisted off)
if (TITLED) {
  await setConfig(worksOf(TITLED.group, { state: 'blocked' }), { blockUnlisted: false });
  await addPost('x-7a-own', 'Breaking Bad was great, honestly.', TITLED.url);
  await mediaDone('x-7a-own');
  c = await covered(['x-7a-own', 'x-titled']);
  check('rule 7: own text names any work -> no title from the model', c['x-7a-own'] === null && lab(c['x-titled']) === TITLED.label, c);
} else skip('rule 7, own text', NO_TITLE);
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
check('"I\'ve seen it" on a one-work group writes works[id].state = "seen" at once (no picker)', Object.values(w ?? {}).some((x) => x.title === 'Breaking Bad' && x.state === 'seen') && c['t-breaking'] === null, w);

// the picker: "I've seen it" on a group with several works (Dune: the 2021 film and the 1965 book)
await setConfig({});
await addPost('x-dune', 'Paul Atreides rides the sandworm at the end.');
await sleep(500);
const pkState = (id = 'x-dune') => page.evaluate((id) => {
  const sr = document.querySelector(`#${id} > sb-overlay`).shadowRoot, d = sr.querySelector('dialog'), f = sr.activeElement;
  const more = d.querySelector('.more'), moreBtn = d.querySelector('[data-a="pk-more"]');
  return { open: d.open, rows: [...d.querySelectorAll('.first li')].map((li) => li.textContent), checked: d.querySelectorAll('.first input:checked').length,
    more: more.hidden ? null : { title: d.querySelector('.h2').textContent, rows: [...d.querySelectorAll('.second li')].map((li) => li.textContent),
      visible: d.querySelectorAll('.second li:not([hidden])').length, showMore: moreBtn.hidden ? null : moreBtn.textContent,
      all: d.querySelector('[data-a="pk-all2"]').textContent, checked: d.querySelectorAll('.second input:checked').length },
    focus: f?.localName === 'input' ? 'input' : f?.dataset?.a ?? null, title: d.querySelector('.h').textContent,
    note: d.querySelector('.note').textContent, label: sr.querySelector('p').textContent };
}, id);
const clickIn = (sel, id = 'x-dune') => page.evaluate((sel, id) => document.querySelector(`#${id} > sb-overlay`).shadowRoot.querySelector(sel).click(), sel, id);
const worksNow = () => storage(async () => (await (globalThis.browser ?? chrome).storage.local.get('works')).works ?? {});
const look = await page.evaluate(() => { const cs = getComputedStyle(document.querySelector('#x-dune > sb-overlay')); return { size: cs.fontSize, bg: cs.backgroundColor, ct: cs.containerType }; });
check('the cover keeps its own look under its reset: 13px text, an opaque background, size containment',
  look.size === '13px' && !/transparent|, 0\)$/.test(look.bg) && look.ct === 'size', look);
await clickIn('[data-a="seen"]');
const pk1 = await pkState();
check('picker opens for a group with several works: title, a row per work, nothing ticked, focus inside, note',
  pk1.open && pk1.rows.length === 2 && pk1.checked === 0 && pk1.focus === 'input' && pk1.title === 'Which have you seen?' &&
  pk1.note === 'Posts that only say "Dune" are shown once you have seen one of these.', pk1);
await clickIn('[data-a="pk-all"]');
const pk2 = await pkState();
await clickIn('[data-a="pk-cancel"]');
const pk3 = await pkState();
check('picker: All ticks the first section only; Cancel writes nothing and returns focus', pk2.checked === 2 && pk2.more?.checked === 0 &&
  !pk3.open && pk3.focus === 'seen' && !Object.keys(await worksNow()).length, { pk2, pk3 });
const years = SERIES_EXTRA.map((t) => META.years[META.titles.indexOf(t)]);
check('picker: "More from this series", oldest first, six shown, "Show 2 more", its own "All 8"', pk1.more?.title === 'More from this series' &&
  pk1.more.rows.length === 8 && pk1.more.visible === 6 && pk1.more.showMore === 'Show 2 more' && pk1.more.all === 'All 8' &&
  pk1.more.rows.every((r, i, a) => i === 0 || +a[i - 1].slice(-4) <= +r.slice(-4)), { more: pk1.more, years });
await clickIn('[data-a="seen"]');
await page.keyboard.press('Escape');
await sleep(300);
const pk4 = await pkState();
check('picker: Escape closes it and returns focus', !pk4.open && pk4.focus === 'seen', pk4);
await clickIn('[data-a="seen"]');
await clickIn('[data-a="pk-more"]');
const pkMore = await pkState();
await clickIn('.pk .first li:first-child input');
await clickIn('[data-a="pk-all2"]');
await clickIn('[data-a="pk-ok"]');
await sleep(1500);
const w2 = await worksNow(), pk5 = { covered: await page.evaluate(() => !!document.querySelector('#x-dune > sb-overlay')) }, duneIds = Object.keys(worksOf('Dune', {}));
const written = Object.keys(w2), writtenDune = written.filter((id) => duneIds.includes(id));
check('picker: "Show 2 more" shows the rest; only the ticked works are written (one of the post\'s, the eight of the series); one seen work of the name uncovers the post',
  pkMore.more?.visible === 8 && pkMore.more.showMore === null && written.length === 9 && writtenDune.length === 1 &&
  Object.values(w2).every((x) => x.state === 'seen') && !pk5.covered, { written: Object.values(w2).map((x) => x.title), pk5 });
// a cover naming several groups (Breaking Bad: one work; Dune: two): every unseen work of all of them, and the other note
await setConfig({});
await addPost('x-multi', 'Paul Atreides and Walter White both end badly.');
await sleep(500);
await clickIn('[data-a="seen"]', 'x-multi');
const pk6 = await pkState('x-multi');
await clickIn('[data-a="pk-cancel"]', 'x-multi');
check('picker for a cover naming several groups: the unseen works of all of them, the several-works note',
  pk6.open && pk6.rows.length === 3 && /and 1 more$/.test(pk6.label) &&
  pk6.note === 'This post names several works. It is shown once you have seen one for each name.', pk6);
// one work whose series has more unseen works (Interstellar, in the test series): the picker opens with that work ticked
await addPost('x-one', 'Cooper docks with the Endurance in Interstellar.');
await sleep(500);
await clickIn('[data-a="seen"]', 'x-one');
const pk7 = await pkState('x-one');
await clickIn('[data-a="pk-cancel"]', 'x-one');
const afterCancel = { works: Object.keys(await worksNow()).length, covered: await page.evaluate(() => !!document.querySelector('#x-one > sb-overlay')) };
check('picker for one work of a series: that work ticked, its note, "More from this series"; Cancel writes nothing',
  pk7.open && pk7.label === 'Mentions Interstellar' && pk7.rows.length === 1 && pk7.rows[0].startsWith('Interstellar') && pk7.checked === 1 &&
  pk7.note === 'This post is about "Interstellar". It is shown once you mark that one.' && pk7.more?.rows.length === 9 &&
  pk7.more.all === 'All 9' && pk7.more.showMore === 'Show 3 more' && pk7.more.checked === 0 && !afterCancel.works && afterCancel.covered, { pk7, afterCancel });
await clickIn('[data-a="seen"]', 'x-one');
await clickIn('[data-a="pk-ok"]', 'x-one');
await sleep(1500);
const w3 = Object.values(await worksNow());
check('picker for one work: Mark seen writes only the ticked work and uncovers the post',
  w3.length === 1 && w3[0].title === 'Interstellar' && w3[0].state === 'seen' && !(await page.evaluate(() => !!document.querySelector('#x-one > sb-overlay'))), w3);
// a box covered while it was small (a feed wrapper with its heading) must not stay covered once it fills with posts
const grown = await page.evaluate(async () => {
  const d = document.createElement('div');
  d.id = 'x-grow';
  d.innerHTML = '<span>Breaking Bad finale thread</span>';
  document.body.append(d);
  await new Promise((r) => setTimeout(r, 600));
  const before = !!d.querySelector(':scope > sb-overlay');
  for (let i = 0; i < 40; i++) { const p = document.createElement('p'); p.textContent = `Post ${i}: ` + 'nothing about any work here. '.repeat(10); d.append(p); }
  await new Promise((r) => setTimeout(r, 600));
  return { before, after: !!d.querySelector(':scope > sb-overlay'), inner: !!d.querySelector('span sb-overlay, span[data-sb-blocked]') };
});
check('a covered box that grows into a page section is uncovered (its own text is judged on its own)', grown.before && !grown.after, grown);
// a navigation bar with one link naming a work: that link is covered, not the bar
const menu = await page.evaluate(async () => {
  const d = document.createElement('div');
  d.id = 'x-menu';
  d.innerHTML = '<a href="#a">Home</a> <a href="#b">Reviews</a> <a href="#c" id="x-menu-bb">Breaking Bad</a> <a href="#d">Join for free</a>';
  document.body.append(d);
  await new Promise((r) => setTimeout(r, 600));
  return { bar: !!d.querySelector(':scope > sb-overlay'), link: !!d.querySelector('#x-menu-bb > sb-overlay') };
});
check('a menu of links: only the link that names a work is covered', menu.link && !menu.bar, menu);
// a sidebar: a short line that names a work beside 4,000 characters of paragraphs -> the line is covered, not the box
const side = await page.evaluate(async () => {
  const d = document.createElement('div');
  d.id = 'x-side';
  d.innerHTML = '<span id="x-side-line">Breaking Bad finale thread</span>' + '<p>Rule: be kind to each other and stay on topic, thank you all.</p>'.repeat(70);
  document.body.append(d);
  await new Promise((r) => setTimeout(r, 600));
  return { box: !!d.querySelector(':scope > sb-overlay'), line: !!d.querySelector('#x-side-line > sb-overlay'), paras: d.querySelectorAll('p > sb-overlay').length };
});
check('a big box of paragraphs: only the line that names a work is covered', side.line && !side.box && side.paras === 0, side);

}

if (want('pill')) {
// M) the pill of a post shown once (contract, "Cover wording"): Not this and Cover again, drawn over the shown post
const learnedNow = () => storage(async () => (await (globalThis.browser ?? chrome).storage.local.get('learned')).learned ?? {});
await storage(() => (globalThis.browser ?? chrome).storage.local.remove('learned'));
await setConfig({});
await open('/');
await page.evaluate(() => {
  const mk = (id, html, style = '') => {
    const a = document.createElement('article');
    a.className = 'post'; a.id = id; a.style.cssText = style; a.innerHTML = html;
    document.getElementById('feed').prepend(a);
  };
  mk('pl-a', '<div class="who">@pl</div><p>Walter White ends up like that, honestly. <a id="pl-link" href="#pl-hit">Read the thread</a></p><span id="pl-n">12</span> likes');
  mk('pl-b', '<div class="who">@pm</div><p>Walter White was the best, what a show.</p>');
  mk('pl-narrow', '<p>Walter White ends up like that.</p>', 'width:120px');
});
await sleep(600);
const PILL = `(id) => {
  const el = document.getElementById(id), ov = el?.querySelector(':scope > sb-overlay');
  if (!ov?.hasAttribute('data-pill')) return ov ? 'cover' : null;
  const sr = ov.shadowRoot, pl = sr.querySelector('.pill'), r = pl.getBoundingClientRect(), e = el.getBoundingClientRect();
  sr.activeElement?.blur(); // a scripted click leaves no pointer modality: Chrome shows the moved focus as focus-visible
  const vis = (b) => getComputedStyle(b).display !== 'none' && b.getBoundingClientRect().width > 0;
  return { buttons: [...pl.querySelectorAll('button')].filter(vis).map((b) => b.getAttribute('aria-label') || b.textContent),
    name: sr.getElementById(pl.getAttribute('aria-labelledby'))?.textContent ?? null, covered: el.hasAttribute('data-sb-blocked'),
    inside: r.top >= e.top - 0.5 && r.left >= e.left - 0.5 && r.right <= e.right + 0.5, h: Math.round(r.height), w: Math.round(r.width),
    endSide: Math.abs(e.right - r.right) < Math.abs(r.left - e.left), opacity: +getComputedStyle(pl).opacity,
    textVisible: getComputedStyle(el.querySelector('p')).visibility === 'visible', bh: Math.round(e.height),
    expanded: pl.querySelector('[data-a="more"]').getAttribute('aria-expanded') };
}`;
const pill = (id) => page.evaluate(`(${PILL})(${JSON.stringify(id)})`);
const inOv = (id, sel) => page.evaluate((id, sel) => document.querySelector(`#${id} > sb-overlay`).shadowRoot.querySelector(sel).click(), id, sel);
c = await covered(['pl-a', 'pl-b', 'pl-narrow']);
const h0 = c['pl-a']?.bh;
await page.evaluate(() => document.getElementById('pl-a').scrollIntoView({ block: 'center' }));
await inOv('pl-a', '[data-a="once"]');
await sleep(300);
const p1 = await pill('pl-a');
// the link and the pill, hit by real clicks: the link gets its click through the overlay, the pill takes its own
const hit = await page.evaluate(() => {
  const l = document.getElementById('pl-link').getBoundingClientRect(), ov = document.querySelector('#pl-a > sb-overlay');
  const pr = ov.shadowRoot.querySelector('.pill').getBoundingClientRect();
  window.__plClicks = [];
  document.getElementById('pl-a').addEventListener('click', (e) => window.__plClicks.push(e.target.id || e.target.localName));
  return { x: l.left + l.width / 2, y: l.top + l.height / 2, at: document.elementFromPoint(l.left + l.width / 2, l.top + l.height / 2)?.id,
    pillAt: document.elementFromPoint(pr.left + pr.width / 2, pr.top + pr.height / 2)?.localName };
});
await page.mouse.click(hit.x, hit.y);
await sleep(200);
const linked = await page.evaluate(() => ({ clicks: window.__plClicks, hash: location.hash }));
check('"Show once" on a cover that names works: the pill with "Not this" and "Cover again", at the top end corner, quiet, named by the label; the text is visible; the height is unchanged',
  p1?.covered === false && JSON.stringify(p1.buttons) === '["Not this","Cover again"]' && p1.inside && p1.endSide && p1.h <= 30 && p1.opacity < 1 &&
  p1.name === 'Mentions Breaking Bad' && p1.textVisible && p1.bh === h0, { p1, h0 });
check('a click on a link in the shown post reaches the link; the pill takes the clicks on itself',
  hit.at === 'pl-link' && hit.pillAt === 'sb-overlay' && linked.clicks.includes('pl-link') && linked.hash === '#pl-hit', { hit, linked });
await page.evaluate(() => { document.getElementById('pl-n').textContent = '13'; });
await sleep(400);
const p2 = await pill('pl-a');
check('the pill survives a re-scan of the post (a counter in it changed)', p2?.covered === false && p2.buttons.length === 2, p2);
await inOv('pl-a', '.pill [data-a="again"]');
await sleep(300);
c = await covered(['pl-a']);
check('"Cover again": the cover returns with the same label', lab(c['pl-a']) === 'Mentions Breaking Bad' && (await pill('pl-a')) === 'cover', c['pl-a']);
// "Not this": the cover's button on pl-b, then (after forgetting it) the pill's on pl-a write the same learned.not
const bbIds = Object.keys(worksOf('Breaking Bad', {}));
await inOv('pl-b', '[data-a="not"]');
await sleep(1500);
const fromCover = (await learnedNow()).not ?? {};
await storage(() => (globalThis.browser ?? chrome).storage.local.remove('learned'));
await sleep(1000);
await inOv('pl-a', '[data-a="once"]');
await sleep(300);
await inOv('pl-a', '.pill [data-a="not"]');
await sleep(1500);
const fromPill = (await learnedNow()).not ?? {};
await setConfig({}, { unknownImages: true }); // a real change re-decides every post
const p3 = await pill('pl-a');
check('"Not this" on the pill writes the same learned.not as the cover\'s button; after a re-scan the post has no cover and no pill',
  bbIds.length > 0 && bbIds.every((id) => fromPill[id]?.length === 1) && JSON.stringify(fromPill) === JSON.stringify(fromCover) && p3 === null,
  { fromCover, fromPill, p3 });
await storage(() => (globalThis.browser ?? chrome).storage.local.remove('learned'));
await setConfig({});
// a post narrower than the pill: only the ⋯ button, which opens the two
await inOv('pl-narrow', '[data-a="once"]');
await sleep(300);
const pn1 = await pill('pl-narrow');
await inOv('pl-narrow', '.pill [data-a="more"]');
await sleep(200);
const pn2 = await pill('pl-narrow');
check('a narrow post: the pill shows only "⋯" (named), inside the post; it opens to both buttons',
  JSON.stringify(pn1?.buttons) === '["SpolierBlock: Not this, Cover again"]' && pn1.inside && pn1.expanded === 'false' &&
  pn2?.buttons.includes('Not this') && pn2.buttons.includes('Cover again') && pn2.expanded === 'true', { pn1, pn2 });
}

// memory of the processes that may host the models (Firefox: the "extension" process; Chrome: the extension renderer)
async function procMem() {
  try {
    if (target === 'firefox') {
      const info = await chromeEval(`ChromeUtils.requestProcInfo().then((p) => JSON.stringify(p.children.map((c) => [c.type, Math.round(c.memory / 1048576)])))`);
      return `## Zen child processes [type, resident MB]\n${info}`;
    }
    const ps = execSync("ps -eo rss,args | grep -E 'chrome.*--extension-process' | grep -v grep").toString();
    return `## Chrome extension process RSS\n${ps.split('\n').filter(Boolean).map((l) => (parseInt(l) / 1024).toFixed(0) + ' MB').join('\n')}`;
  } catch (e) { return 'memory: ' + e.message; }
}

if (want('context')) {
// I) unsure names and the title-in-context model (contract, "Names the matcher is unsure about"). Which posts the model
// accepts depends on the shipped model, so the cases use posts the Node runner (tools/context-train/classify.mjs) judges
// that way on the same input, and the engine must give the same probability.
await import(path.join(ROOT, 'src/shared/context-input.js'));
const { contextClassifier } = await import(path.join(ROOT, 'tools/context-train/classify.mjs'));
const ctxNode = await contextClassifier(path.join(EXT, 'models/context'));
const { windowText, workText } = globalThis.SBContext;
const thr = (o) => (o ? ctxNode.meta.thresholdOther ?? ctxNode.meta.threshold : ctxNode.meta.threshold);
// a post (as addPost draws it: "@pic" line, then the text) with no accepted group and exactly one unsure name
const judge = async (text, own = `@pic\n${text}\n`) => {
  const us = nodeMatcher.evaluate(own).length ? [] : nodeMatcher.unsure(own);
  if (us.length !== 1) return null;
  const [u] = us, a = windowText(own, u.s, u.e), b = workText(META, u.g), p = await ctxNode.prob(a, b);
  return { text, a, b, o: u.o, label: META.groups[u.g][0], p, yes: p >= thr(u.o) };
};
let Y = null, N = null, YT = null;
for (const t of ['rewatched severance last night, mark s is the best', 'my favorite show is still severance, nothing comes close', 'the matrix changed everything for me']) {
  const j = await judge(t), jt = await judge(t, t); // the post, and the same words as the page title
  if (j?.yes && jt?.yes) { Y = j; YT = jt; break; }
}
for (const t of ['I lost my keys again today, and then it started to rain.', 'severance pay was finally in my account', 'We drove to Chernobyl last summer']) {
  const j = await judge(t);
  if (j && !j.yes) { N = j; break; }
}
report.push(`## title in context (Node runner, threshold ${ctxNode.meta.threshold}): yes ${JSON.stringify(Y)}; no ${JSON.stringify(N)}`);
const ctxAsk = (msg) => extEval(async (m) => {
  for (let i = 0; ; i++) {
    try { return await (globalThis.browser ?? chrome).runtime.sendMessage(m); } catch (e) {
      if (i > 20) return { error: String(e) };
      await new Promise((r) => setTimeout(r, 500));
    }
  }
}, msg);
if (Y && N) {
  const ms = [];
  await ctxAsk({ type: 'text.classify', text: 'The runtime and the spoiler classifier are loaded first.' }); // so the memory delta is this model's
  await sleep(2000);
  report.push(`## before the first text.context message (with ONLY=context, the first one of this browser): ${await procMem()}`);
  for (const x of [Y, N, YT]) { const t = Date.now(); x.engine = (await ctxAsk({ type: 'text.context', a: x.a, b: x.b, o: x.o }))?.p; ms.push(Date.now() - t); }
  for (let k = 0; k < 20; k++) { const t = Date.now(); await ctxAsk({ type: 'text.context', a: `${k} ${Y.a}`, b: Y.b, o: 0 }); ms.push(Date.now() - t); }
  const warm = ms.slice(1).sort((a, b) => a - b);
  report.push(`## text.context round trip from an extension page: first (loads the model) ${ms[0]} ms, then median ${warm[warm.length >> 1]} ms, max ${warm.at(-1)} ms (${warm.length} calls)\n` +
    `after: ${(await sleep(2000), await procMem())}`);
  check('engine: text.context gives the Node runner\'s probability on the same pair', [Y, N, YT].every((x) => Math.abs(x.engine - x.p) < 0.005),
    [Y, N, YT].map((x) => [x.p.toFixed(4), x.engine]));
  await setConfig({});
  await open('/');
  await settle();
  const tap = (sel, id) => page.evaluate((sel, id) => document.querySelector(`#${id} > sb-overlay`).shadowRoot.querySelector(sel).click(), sel, id);
  const asked = () => page.evaluate(() => JSON.parse(document.documentElement.getAttribute('data-sb-stats') || '{}').ctx ?? 0);
  const idle = () => page.waitForFunction(() => document.documentElement.getAttribute('data-sb-busy') === '0', { timeout: 60000 });
  // added and sampled in one go: the question is in flight (busy) and the post is not covered yet
  const addAsking = (id, text) => page.evaluate(async ([id, text]) => {
    const a = document.createElement('article');
    a.className = 'post'; a.id = id;
    a.innerHTML = '<div class="who">@pic</div><p></p>';
    a.querySelector('p').textContent = text;
    document.getElementById('feed').append(a);
    await new Promise((r) => setTimeout(r, 0));
    return { covered: a.hasAttribute('data-sb-blocked'), busy: +document.documentElement.getAttribute('data-sb-busy') };
  }, [id, text]);
  const n0 = await asked();
  const during = await addAsking('x-ctx-yes', Y.text);
  await idle();
  c = await covered(['x-ctx-yes']);
  const n1 = await asked();
  check('unsure name: not covered while the model is asked', !during.covered && during.busy > 0, during);
  check(`unsure name the model accepts: covered with "Mentions ${Y.label}" after the answer (one question)`,
    lab(c['x-ctx-yes']) === `Mentions ${Y.label}` && n1 - n0 === 1, { cover: c['x-ctx-yes'], asked: n1 - n0 });
  await addAsking('x-ctx-no', N.text);
  await idle();
  c = await covered(['x-ctx-no']);
  check('unsure name the model rejects: not covered', c['x-ctx-no'] === null && (await asked()) - n1 === 1, { cover: c['x-ctx-no'], asked: (await asked()) - n1 });
  // the page title takes the same path
  const n2 = await asked();
  await page.evaluate((t) => { document.title = t; }, YT.text);
  await idle();
  await sleep(300);
  const title = await page.evaluate(() => document.title);
  check('page title with an unsure name the model accepts: replaced by the cover text', title === `Mentions ${YT.label}` && (await asked()) - n2 === 1, title);
  // the same post again: the remembered answer covers it at once, no new question
  const n3 = await asked();
  await addAsking('x-ctx-again', Y.text);
  await sleep(300);
  c = await covered(['x-ctx-again']);
  check('the same text again: covered from the remembered answer, no question', lab(c['x-ctx-again']) === `Mentions ${Y.label}` && (await asked()) === n3, c['x-ctx-again']);
  await tap('[data-a="seen"]', 'x-ctx-again');
  // a work of the test series opens the picker with that work ticked (contract, "Cover wording"): Mark seen
  if (await page.evaluate(() => document.querySelector('#x-ctx-again > sb-overlay')?.shadowRoot.querySelector('dialog').open)) await tap('[data-a="pk-ok"]', 'x-ctx-again');
  await sleep(1500);
  const wSeen = await storage(async () => (await (globalThis.browser ?? chrome).storage.local.get('works')).works ?? {});
  c = await covered(['x-ctx-again', 'x-ctx-yes']);
  check('"I\'ve seen it" on a model cover: writes the work as seen and uncovers', c['x-ctx-again'] === null && c['x-ctx-yes'] === null &&
    Object.values(wSeen).some((x) => x.title === Y.label && x.state === 'seen'), Object.values(wSeen).map((x) => `${x.title} ${x.state}`));
  // a seen group is never asked: a new window around the same name asks nothing
  const n4 = await asked();
  await addAsking('x-ctx-seen', `${Y.text} Really, I mean it.`);
  await idle();
  await sleep(300);
  c = await covered(['x-ctx-seen']);
  check('a seen group is not asked', c['x-ctx-seen'] === null && (await asked()) === n4, { cover: c['x-ctx-seen'], asked: (await asked()) - n4 });
  // unseen again: the rescan covers both posts from the remembered answer; "Show once" (per text) then shows both, also
  // after another rescan
  await setConfig({});
  c = await covered(['x-ctx-yes', 'x-ctx-again']);
  const n5 = await asked();
  await tap('[data-a="once"]', 'x-ctx-yes');
  await setConfig({}, { unknownImages: true }); // a real change: Chrome reports no change for an identical write
  const c2 = await covered(['x-ctx-yes', 'x-ctx-again']);
  check('"Show once" on a model cover: uncovered, and stays so after a rescan', lab(c['x-ctx-yes']) === `Mentions ${Y.label}` &&
    c2['x-ctx-yes'] === null && c2['x-ctx-again'] === null && (await asked()) === n5, { before: c, after: c2 });
} else skip('title in context', 'no candidate post the shipped model accepts (or rejects) with one unsure name');
}

if (want('feed')) {
// F) virtualised, recycled, height-measured feed with late images (scan images on, unknown images on)
await setConfig({}, { unknownImages: true });
await open('/feed');
const problems = new Set(), shownItems = new Set();
const inspect = async (final) => {
  const rows = await page.evaluate(() => window.feedState());
  for (const r of rows) {
    if (shownItems.has(r.i)) { if (r.covered) problems.add(`item ${r.i}: covered again after "Show once" ("${r.label}")`); r.expect = null; r.covered = false; }
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
// "Show once" is per post: on item 3 (text) and on item 8 (text, picture still being judged); the feed recycles both
// cells while scrolling and draws the posts again on other nodes at the end
const showOnceIn = async (i) => {
  for (let y = 0; y < 3000; y += 150) {
    await page.evaluate((y) => scrollTo(0, y), y);
    await sleep(150);
    if (await page.evaluate((i) => !!document.querySelector(`.cell[data-item="${i}"] article[data-sb-blocked] > sb-overlay`), i)) break;
  }
  const pending = await page.evaluate((i) => !document.querySelector(`.cell[data-item="${i}"] .media`).hidden &&
    !document.querySelector(`.cell[data-item="${i}"] img`).hasAttribute('data-sb-ok'), i);
  await page.evaluate((i) => document.querySelector(`.cell[data-item="${i}"] article > sb-overlay`).shadowRoot.querySelector('[data-a="once"]').click(), i);
  shownItems.add(i);
  return pending;
};
await showOnceIn(3);
const pending8 = await showOnceIn(8);
await page.waitForFunction(() => document.querySelector('.cell[data-item="8"] img')?.hasAttribute('data-sb-ok') &&
  document.documentElement.getAttribute('data-sb-busy') === '0', { timeout: 180000 });
const after8 = await page.evaluate(() => document.querySelector('.cell[data-item="8"] article').hasAttribute('data-sb-blocked'));
check('Show once: a picture verdict arriving afterwards does not cover the post again', pending8 && !after8, { pendingAtShowOnce: pending8, coveredAfter: after8 });
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
check('recycled feed: no overlap, no height change, covers belong to their post, labels right; "Show once" posts stay shown', !problems.size,
  Object.values(kinds).map((ps) => `${ps.length}x, e.g. ${ps.slice(0, 3).join(' | ')}`).join('; ') +
  ` (stats ${await page.evaluate(() => document.documentElement.getAttribute('data-sb-stats'))})`);
}

if (want('coverage')) {
// G) coverage: DMs, typeahead, notifications, quote post, background image, shadow DOM, frames, title, height, theme
await setConfig({}, { unknownImages: true });
await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: 'light' }]).catch(() => {});
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
  darkScheme: (${INFO})(document.getElementById('fr-dark').contentDocument?.getElementById('f3')),
  systemDark: matchMedia('(prefers-color-scheme: dark)').matches,
  title: document.title })`);
const cross = page.frames().find((f) => f.url().includes('frame.html'));
const crossC = cross ? (await covered(['f2'], cross)).f2 : 'no frame';
report.push(`## shadow DOM, frames, title\n${JSON.stringify({ ...shadow, cross: crossC })}`);
check('open shadow root covered', lab(shadow.open) === 'Mentions Star Wars', shadow.open);
check('closed shadow root covered', lab(shadow.closed) === 'Mentions Harry Potter', shadow.closed);
check('shadow root attached after the element was seen', lab(shadow.late) === 'Mentions Game of Thrones', shadow.late);
check('about:srcdoc iframe covered', lab(shadow.srcdoc) === 'Mentions Harry Potter', shadow.srcdoc);
check('dark page (color-scheme: dark, no backgrounds) under a light system scheme: dark cover', shadow.darkScheme?.dark === true && shadow.systemDark === false,
  { cover: shadow.darkScheme, systemDark: shadow.systemDark });
check('cross-origin iframe covered', lab(crossC) === 'Mentions Star Wars', crossC);
check('document.title replaced', shadow.title === 'Mentions Breaking Bad', shadow.title);
// a covered post's video is silent (the page started it with sound), stays silent when the page un-mutes and plays it
// again, and gets its sound and playback back after "Show once"
const av = () => page.evaluate(() => { const v = document.getElementById('av'); return { covered: document.getElementById('av-post').hasAttribute('data-sb-blocked'), muted: v.muted, paused: v.paused, startedBySite: window.__avStarted }; });
const av1 = await av();
check('covered post: its video is muted and paused', av1.covered && av1.muted && av1.paused && av1.startedBySite === true, av1);
await page.evaluate(() => { const v = document.getElementById('av'); v.muted = false; v.play().catch(() => {}); });
await sleep(600);
const av2 = await av();
check('page un-mutes and plays it while covered: stays silent', av2.covered && av2.muted && av2.paused, av2);
await page.evaluate(() => document.getElementById('av-post').scrollIntoView({ block: 'center' }));
await page.evaluate(() => document.querySelector('#av-post > sb-overlay').shadowRoot.querySelector('[data-a="once"]').click());
await sleep(800);
const av3 = await av();
av3.pill = await page.evaluate(() => !!document.querySelector('#av-post > sb-overlay[data-pill]'));
await sleep(1500);
const av4 = await av();
check('"Show once" restores sound and playback; the post keeps its pill and keeps playing with sound',
  !av3.covered && !av3.muted && !av3.paused && av3.pill && !av4.covered && !av4.muted && !av4.paused, { av3, av4 });
// a covered post never silences a neighbour's video: sibling posts, plain boxes in a plain wrapper, and posts inside a
// wrapper whose class looks like a post ("post-list"); the cover goes on the post, never on the wrapper
await setConfig({}); // unknown images off: the clip's own frames must not cover its post here
const nb = await page.evaluate(async (src) => {
  const d = document.createElement('section');
  d.id = 'nb';
  const vid = (id) => `<video id="${id}" src="${src}" loop playsinline style="width:200px;height:120px"></video>`;
  d.innerHTML = `<article id="nb-a"><p>Walter White dies at the end of the show.</p></article>
    <article id="nb-b"><p>Sunset at the lake, sound on.</p>${vid('nb-v1')}</article>
    <div id="nb-plain"><div id="nb-c">Walter White's last scene broke me.</div><div id="nb-d"><p>Our dog at the beach.</p>${vid('nb-v2')}</div></div>
    <div class="post-list" id="nb-list"><article id="nb-e"><p>Walter White was the best character.</p></article>
      <article id="nb-f"><p>Waves at night.</p>${vid('nb-v3')}</article></div>`;
  document.querySelector('main').append(d);
  for (const v of d.querySelectorAll('video')) { v.muted = false; v.play().catch(() => {}); }
  await new Promise((r) => setTimeout(r, 1500));
  const vs = Object.fromEntries([...d.querySelectorAll('video')].map((v) => [v.id, { muted: v.muted, paused: v.paused }]));
  const cov = (id) => document.getElementById(id).hasAttribute('data-sb-blocked');
  return { vs, a: cov('nb-a'), c: cov('nb-c'), e: cov('nb-e'), b: cov('nb-b'), d: cov('nb-d'), f: cov('nb-f'), plain: cov('nb-plain'), list: cov('nb-list') };
}, `http://localhost:${PAGE}/img/video_lake.webm`);
check('a covered post leaves a neighbouring post\'s playing video alone (siblings, plain boxes, a "post-list" wrapper)',
  nb.a && nb.c && nb.e && !nb.b && !nb.d && !nb.f && !nb.plain && !nb.list && Object.values(nb.vs).every((v) => !v.muted && !v.paused), nb);
// a site's fixed bottom bar and sticky header drawn over a covered post stay on top and take the clicks
const bar = await page.evaluate(async () => {
  const head = document.createElement('header');
  head.id = 'sticky';
  head.style.cssText = 'position:sticky;top:0;z-index:5;height:40px;background:#eee;display:flex';
  head.innerHTML = '<button id="sticky-btn" style="flex:1">Menu</button>';
  document.body.prepend(head);
  const nav = document.createElement('nav');
  nav.style.cssText = 'position:fixed;left:0;right:0;bottom:0;height:56px;z-index:10;background:#fff;display:flex';
  nav.innerHTML = '<button id="bar-btn" style="flex:1">Home</button>';
  document.body.append(nav);
  const post = document.createElement('article');
  post.id = 'bar-post';
  post.innerHTML = '<p>Walter White dies at the end of the show.</p>';
  post.style.height = '2000px';
  document.querySelector('main').append(post);
  await new Promise((r) => setTimeout(r, 600));
  post.scrollIntoView({ block: 'start' });
  scrollBy(0, -10); // the post's top under the sticky header, its body under the bar
  await new Promise((r) => setTimeout(r, 300));
  const hit = (id) => { const r = document.getElementById(id).getBoundingClientRect(), x = r.left + r.width / 2, y = r.top + r.height / 2;
    const p = post.getBoundingClientRect(); return { el: document.elementFromPoint(x, y)?.id || document.elementFromPoint(x, y)?.localName, x, y, overPost: y > p.top && y < p.bottom }; };
  window.__barClicks = [];
  for (const id of ['bar-btn', 'sticky-btn']) document.getElementById(id).addEventListener('click', () => window.__barClicks.push(id));
  return { covered: post.hasAttribute('data-sb-blocked'), bar: hit('bar-btn'), head: hit('sticky-btn') };
});
for (const k of ['bar', 'head']) await page.mouse.click(bar[k].x, bar[k].y);
await sleep(200);
const clicks = await page.evaluate(() => window.__barClicks);
check('a fixed bar and a sticky header over a covered post: on top of the cover (elementFromPoint) and clicked',
  bar.covered && bar.bar.overPost && bar.head.overPost && bar.bar.el === 'bar-btn' && bar.head.el === 'sticky-btn' &&
  clicks.includes('bar-btn') && clicks.includes('sticky-btn'), { ...bar, clicks });

}

if (want('youtube')) {
// J) youtube.com (the image server's host, read as youtube.com by the test build): the player's end screen and the uploader
await setConfig({});
await page.goto(`http://127.0.0.1:${IMG}/yt.html`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => document.documentElement.hasAttribute('data-sb-ready'));
await sleep(1500); // es-3 and es-4's new label arrive after 0.4 s
c = await covered(['es-1', 'es-2', 'es-3', 'es-4', 'es-up', 'movie_player', 'up-clean', 'up-trailer', 'up-other']);
report.push(`## youtube.com page\n${JSON.stringify(c)}`);
check('end screen: each card is one block (a card with text, an aria-label only, a changed aria-label, "up next"), the player is not',
  lab(c['es-1']) === 'Mentions Breaking Bad' && c['es-2'] === null && lab(c['es-3']) === 'Mentions Breaking Bad' &&
  lab(c['es-4']) === 'Mentions Interstellar' && lab(c['es-up']) === 'Mentions Game of Thrones' && c['movie_player'] === null, c);
check('uploader: a clean title from a channel named like the work is not covered; a trailer from it and the same title from another channel are',
  c['up-clean'] === null && lab(c['up-trailer']) === 'Mentions Minecraft' && lab(c['up-other']) === 'Mentions Minecraft', c);
}

if (want('learned')) {
// L) rule 11, reports. "Not this" on youtube.com (the image server's host): the key is youtube.com/{channel}
const learnedNow = () => storage(async () => (await (globalThis.browser ?? chrome).storage.local.get('learned')).learned ?? {});
await storage(() => (globalThis.browser ?? chrome).storage.local.remove(['learned', 'catalogIndex']));
await setConfig({});
await page.goto(`http://127.0.0.1:${IMG}/yt.html`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => document.documentElement.hasAttribute('data-sb-ready'));
await sleep(800);
const NT = ['nt-a', 'nt-b', 'nt-c'];
c = await covered(NT);
// every button inside the cover's box, none cut to nothing (the compact one-row layout: rows are short, nt-c also narrow)
const fit = await page.evaluate((ids) => ids.map((id) => {
  const ov = document.querySelector(`#${id} > sb-overlay`), o = ov.getBoundingClientRect();
  return [...ov.shadowRoot.querySelectorAll('.b > button:not([hidden])')].every((b) => { const r = b.getBoundingClientRect(); return r.width >= 20 && r.left >= o.left - 0.5 && r.right <= o.right + 0.5; }) && o.height <= 76;
}), NT);
check('"Not this" on every cover that names works; compact one-row covers (wide and 260 px) keep all four buttons inside',
  NT.every((id) => lab(c[id]) === 'Mentions Breaking Bad' && c[id].not === true) && fit.every(Boolean), { c, fit });
await page.evaluate(() => document.querySelector('#nt-a > sb-overlay').shadowRoot.querySelector('[data-a="not"]').click());
await sleep(150);
const at150 = (await covered(['nt-a']))['nt-a'];
await sleep(1500);
c = await covered(NT);
const nl = await learnedNow(), bbIds = Object.keys(worksOf('Breaking Bad', {}));
check('"Not this": the cover goes at once; learned.not gets youtube.com/recap lab for the group\'s works; the same channel\'s other post uncovers, another channel\'s stays',
  at150 === null && c['nt-a'] === null && c['nt-b'] === null && lab(c['nt-c']) === 'Mentions Breaking Bad' &&
  bbIds.every((id) => JSON.stringify(nl.not?.[id]) === '["youtube.com/recap lab"]'), { at150, c, not: nl.not });
await extGo(OPTIONS);
const nui = await extEval(async () => {
  // the title comes from the index (catalog.titles) a moment after the row
  for (let k = 0; k < 40 && !document.querySelector('#not-list li')?.textContent.includes('Breaking Bad'); k++) await new Promise((r) => setTimeout(r, 250));
  const rows = [...document.querySelectorAll('#not-list li')].map((li) => li.textContent.replace(/\s+/g, ' ').trim());
  document.querySelector('#not-list li button').click();
  await new Promise((r) => setTimeout(r, 800));
  return { rows, after: document.querySelectorAll('#not-list li').length };
});
await sleep(1000);
c = await covered(NT);
check('settings: "Not this" listed (work title, where) with a remove control; removing it covers the post again',
  nui.rows.length === bbIds.length && nui.rows.every((r) => r.includes('Breaking Bad') && r.includes('youtube.com/recap lab')) &&
  nui.after === bbIds.length - 1 && lab(c['nt-a']) === 'Mentions Breaking Bad', { nui, c: c['nt-a'] });
await storage(() => (globalThis.browser ?? chrome).storage.local.remove('learned'));

// B) a missing name: the popup offers the page's selection as a name for a work picked by search
const NAME = 'Albuquerque Chemistry Tales';
await open('/');
await page.evaluate((name) => {
  const a = document.createElement('article');
  a.className = 'post'; a.id = 'nm-post';
  a.innerHTML = `<div class="who">@nm</div><p>Finally watched ${name} tonight, what a ride.</p><p id="nm-src">${name}</p>`;
  document.getElementById('feed').prepend(a);
}, NAME);
await sleep(500);
const before = (await covered(['nm-post']))['nm-post'];
const select = () => page.evaluate(() => { const r = document.createRange(); r.selectNodeContents(document.getElementById('nm-src')); getSelection().removeAllRanges(); getSelection().addRange(r); });
await select();
await extGo('/src/popup/popup.html');
await sleep(1200);
const pop = await extEval(async () => {
  const $ = (id) => document.getElementById(id), btn = $('name-btn');
  const row = { hidden: $('teach').hidden, text: btn.textContent };
  btn.click();
  const i = $('pick-search');
  i.value = 'breaking bad'; i.dispatchEvent(new Event('input'));
  for (let k = 0; k < 40 && !document.querySelector('#pick-results li'); k++) await new Promise((r) => setTimeout(r, 250));
  const first = document.querySelector('#pick-results li')?.textContent;
  document.querySelector('#pick-results li button').click();
  const ask = $('pick-what').textContent;
  $('pick-ok').click();
  await new Promise((r) => setTimeout(r, 500));
  return { row, first, ask, done: $('pick-done').textContent };
});
let nmAfter = null;
for (let k = 0; k < 40 && !nmAfter; k++) { await sleep(500); nmAfter = (await covered(['nm-post']))['nm-post']; }
const names = (await learnedNow()).names ?? {};
check('popup with a selection: "Add "{selection}" as a name for…", search, Choose, Add name; a post using the name becomes covered',
  before === null && !pop.row.hidden && pop.row.text === `Add "${NAME}" as a name for…` && /Breaking Bad/.test(pop.first) &&
  Object.values(names).some((n) => n.includes(NAME)) && lab(nmAfter) === 'Mentions Breaking Bad', { before, pop, names, nmAfter });
await page.evaluate(() => getSelection().removeAllRanges());
await extReload();
await sleep(1200);
const noSel = await extEval(() => ({ name: document.getElementById('name-btn').hidden, teach: document.getElementById('teach').hidden }));
check('popup with no selection: no "Add … as a name" row', noSel.teach === true, noSel);
await extGo(OPTIONS);
const ed = await extEval(async () => {
  for (let k = 0; k < 20 && !document.querySelector('#names-list li'); k++) await new Promise((r) => setTimeout(r, 250));
  const row = document.querySelector('#names-list li')?.textContent.replace(/\s+/g, ' ').trim();
  document.querySelector('#names-list .names-btn').click();
  const chips = [...document.querySelectorAll('#names-list .names .chips li span')].map((e) => e.textContent);
  document.querySelector('#names-list .names .chips button').click();
  await new Promise((r) => setTimeout(r, 800));
  return { row, chips, left: document.querySelectorAll('#names-list li.row').length };
});
let nmGone = 'covered';
for (let k = 0; k < 40 && nmGone !== null; k++) { await sleep(500); nmGone = (await covered(['nm-post']))['nm-post']; }
check('settings: "Other names" editor lists the name; removing it uncovers the post', ed.chips.includes(NAME) && ed.left === 0 && nmGone === null, { ed, nmGone });
// the editor in a library row adds a name the same way (and it is stored trimmed)
await setConfig(worksOf('Breaking Bad', { state: 'blocked' }));
const ed2 = await extEval(async () => {
  for (let k = 0; k < 20 && !document.querySelector('#lib .names-btn'); k++) await new Promise((r) => setTimeout(r, 250));
  const b = document.querySelector('#lib .names-btn');
  if (b.getAttribute('aria-expanded') !== 'true') b.click();
  const f = document.querySelector('#lib .names form');
  f.querySelector('input').value = '  BrBa Show  ';
  f.requestSubmit();
  await new Promise((r) => setTimeout(r, 800));
  return [...document.querySelectorAll('#lib .names .chips li span')].map((e) => e.textContent);
});
const n2 = (await learnedNow()).names ?? {};
check('settings: the "Other names" editor of a library row adds a name, trimmed', JSON.stringify(ed2) === '["BrBa Show"]' && Object.values(n2).some((n) => n.includes('BrBa Show')), { ed2, n2 });
await storage(() => (globalThis.browser ?? chrome).storage.local.remove(['learned']));
await sleep(3000); // the background drops the rebuilt index again
await extGo('/src/popup/popup.html');
}

if (want('videos')) {
// K) rule 10, videos with no caption: on a listed site a video post with no caption and no work named is covered
const VIDS = ['v-bare', 'v-cap', 'v-seen', 'v-late', 'v-shadow', 'v-novideo'];
// the settings page's list: a typed URL is stored as its host name and shown as a chip
await setConfig({});
await extGo(OPTIONS);
const ui = await extEval(async () => {
  const f = document.getElementById('vsite-form');
  document.getElementById('vsite').value = 'https://www.X.com/home';
  f.requestSubmit();
  await new Promise((r) => setTimeout(r, 800));
  return { stored: (await (globalThis.browser ?? chrome).storage.local.get('settings')).settings.captionlessVideos,
    chips: [...document.querySelectorAll('#vsites li span')].map((e) => e.textContent), paused: document.querySelectorAll('#sites li.none').length };
});
check('settings page: "Cover videos with no caption on these sites" stores and shows the host name; paused sites untouched',
  JSON.stringify(ui.stored) === '["x.com"]' && JSON.stringify(ui.chips) === '["x.com"]' && ui.paused === 1, ui);
await extGo('/src/popup/popup.html');
const seenBB = worksOf('Breaking Bad', { state: 'seen' });
await setConfig(seenBB, { captionlessVideos: ['localhost'] });
await open('/videos');
await sleep(1500); // the lazy player arrives after 0.5 s
c = await covered(VIDS);
report.push(`## videos with no caption, site listed\n${JSON.stringify(c)}`);
const bareV = () => page.evaluate(() => { const v = document.getElementById('v-bare-v'); return { muted: v.muted, paused: v.paused }; });
const bv1 = await bareV();
check('captionless video post covered: exact label, no "I\'ve seen it" or "Not this", settings button, video muted and paused',
  lab(c['v-bare']) === 'Video with no caption' && c['v-bare'].seen === false && c['v-bare'].not === false && c['v-bare'].menu === 'SpolierBlock settings' &&
  bv1.muted && bv1.paused, { ...c['v-bare'], ...bv1 });
check('a video added to a post later (lazy player) and a video in an open shadow root: covered',
  lab(c['v-late']) === 'Video with no caption' && lab(c['v-shadow']) === 'Video with no caption', c);
check('video post with a 6-word caption, one whose caption names a seen work, and a post with no video: not covered',
  c['v-cap'] === null && c['v-seen'] === null && c['v-novideo'] === null, c);
await page.evaluate(() => document.querySelector('#v-bare > sb-overlay').shadowRoot.querySelector('[data-a="once"]').click());
await sleep(300);
const noPill = await page.evaluate(() => !document.querySelector('#v-bare > sb-overlay'));
check('"Show once" on a "Video with no caption" cover leaves no pill', noPill);
await setConfig(seenBB, { captionlessVideos: ['localhost'], scanImages: false }); // a settings change re-decides every post
const once = (await covered(['v-bare', 'v-late']));
const hNow = await page.evaluate(() => Math.round(document.getElementById('v-bare').getBoundingClientRect().height));
check('the cover did not change the post\'s measured height (covered vs shown)', hNow === c['v-bare']?.bh, { covered: c['v-bare']?.bh, shown: hNow });
check('"Show once" reveals the captionless video post and it stays revealed after a re-decision', once['v-bare'] === null && lab(once['v-late']) === 'Video with no caption', once);
await setConfig(seenBB);
c = await covered(VIDS);
check('list empty: no video post covered', VIDS.every((id) => c[id] === null), c);
// the page at /x is read as x.com by the test build: the caption is [data-testid="tweetText"], not a 4-word run
await setConfig({}, { captionlessVideos: ['x.com'] });
await open('/x');
await sleep(1000);
c = await covered(['x-bare', 'x-cap', 'v-cap']);
report.push(`## videos with no caption, x.com\n${JSON.stringify(c)}`);
check('x.com: a video article with a 5-word name line and no tweet text is covered; with 2 words of tweet text it is not',
  lab(c['x-bare']) === 'Video with no caption' && c['x-cap'] === null && lab(c['v-cap']) === 'Video with no caption', c);
await setConfig({});
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
report.push(await procMem());

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
