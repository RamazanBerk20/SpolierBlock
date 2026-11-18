// Background: Firefox event page (document) or Chrome MV3 service worker.
// Answers popup queries itself and routes inference to engine.js — loaded in-place on Firefox, in an
// offscreen document on Chrome (service workers cannot host the WASM runtime's dynamic imports/workers).
import { runUpdate, rebuild, alarmPlan, toBase64, ALARM, ENDPOINT } from './catalog-update.js';
const api = globalThis.browser ?? globalThis.chrome;
const isWorker = typeof document === 'undefined';

// One shared promise per service-worker lifetime: concurrent first messages must all wait for the document to be
// created; previously the 2nd caller saw hasDocument() === true while it was still loading and sent too early.
let offscreenReady = null;
function offscreen() {
  offscreenReady ??= (async () => {
    if (await chrome.offscreen.hasDocument()) return;
    await chrome.offscreen.createDocument({
      url: 'src/background/offscreen.html',
      reasons: ['WORKERS'],
      justification: 'Runs the bundled image/text models (WASM) locally.',
    });
  })().catch((e) => { offscreenReady = null; throw e; });
  return offscreenReady;
}
let enginePromise = null;
async function infer(msg) {
  if (isWorker) {
    await offscreen();
    return chrome.runtime.sendMessage({ ...msg, target: 'offscreen' });
  }
  enginePromise ??= import('./engine.js');
  return (await enginePromise).handle(msg);
}

// ---------- catalog: bundled, or the locally rebuilt one after an opt-in update ----------
const getJSON = (p) => fetch(api.runtime.getURL(p)).then((r) => r.json());
let bundleP = null;
const loadBundle = () => (bundleP ??= Promise.all([getJSON('data/catalog.json'), fetch(api.runtime.getURL('data/common-words.txt')).then((r) => r.text()),
  getJSON('data/catalog-classes.json'), getJSON('data/catalog-info.json'), getJSON('data/index.json')])
  .then(([catalog, words, classes, info, meta]) => ({ catalog, words, classes, info, meta })).catch((e) => { bundleP = null; throw e; }));

// The rebuilt index lives in storage.local (catalogIndex) and is only valid for the bundle it was built against.
async function currentMeta() {
  const { catalogIndex } = await api.storage.local.get('catalogIndex');
  if (catalogIndex && catalogIndex.bundle === (await getJSON('data/catalog-info.json')).builtAt) return catalogIndex.meta;
  return getJSON('data/index.json');
}

let index = null;
api.storage.onChanged.addListener((c, area) => { if (area === 'local' && c.catalogIndex) index = null; });
const fold = (s) => s.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase();
async function search(q, limit = 20) {
  index ??= currentMeta().then((m) => ({ m, folded: m.titles.map(fold) })).catch((e) => { index = null; throw e; });
  const { m, folded } = await index;
  q = fold(String(q ?? '').trim());
  if (!q) return [];
  const prefix = [], sub = [];
  // works are stored most-popular first, so scan order is popularity order
  for (let i = 0; i < folded.length && prefix.length < limit; i++) {
    const at = folded[i].indexOf(q);
    if (at === 0 || (at > 0 && folded[i][at - 1] === ' ')) prefix.push(i);
    else if (at > 0 && sub.length < limit) sub.push(i);
  }
  return [...prefix, ...sub].slice(0, limit).map((i) => ({ id: m.ids[i], title: m.titles[i], type: m.types[i], year: m.years[i] || null }));
}

// ---------- opt-in catalog update (the only network use) ----------
let updating = null;
async function endpoint() { // tests only: a test build may ship data/update-config.json pointing at a local mock
  try { return (await getJSON('data/update-config.json')).endpoint ?? ENDPOINT; } catch { return ENDPOINT; }
}
function updateNow() {
  updating ??= (async () => {
    const bundle = await loadBundle();
    // the stored index must carry the id of the bundle it was built against
    const storage = { get: (k) => api.storage.local.get(k), set: (o) => api.storage.local.set(o.catalogIndex ? { ...o, catalogIndex: { ...o.catalogIndex, bundle: bundle.info.builtAt } } : o) };
    return runUpdate({ storage, loadBundle: async () => bundle, fetch: (...a) => fetch(...a), endpoint: await endpoint() });
  })().finally(() => { updating = null; });
  return updating;
}
async function catalogStatus() {
  const [{ catalogMeta = null, catalogIndex }, bundle] = await Promise.all([api.storage.local.get(['catalogMeta', 'catalogIndex']), getJSON('data/catalog-info.json')]);
  const live = catalogIndex?.bundle === bundle.builtAt;
  return { bundled: bundle.works, total: live ? catalogIndex.meta.ids.length : bundle.works, meta: catalogMeta, updating: !!updating };
}
async function schedule() {
  const [{ settings = {}, catalogMeta = {} }, existing] = await Promise.all([api.storage.local.get(['settings', 'catalogMeta']), api.alarms.get(ALARM)]);
  const plan = alarmPlan(settings.catalogUpdate ?? 'off', catalogMeta.lastCheck, Date.now());
  if (!plan) { if (existing) await api.alarms.clear(ALARM); return; }
  if (existing?.periodInMinutes !== plan.periodInMinutes) await api.alarms.create(ALARM, plan);
}
// Listeners are registered synchronously so the alarm wakes a suspended event page / service worker.
api.alarms.onAlarm.addListener(async (a) => {
  if (a.name !== ALARM) return;
  const { settings = {} } = await api.storage.local.get('settings');
  if (INTERVAL_ON(settings.catalogUpdate)) await updateNow(); // never fetch while the setting is off
});
const INTERVAL_ON = (v) => v === 'daily' || v === 'weekly' || v === 'monthly';
api.storage.onChanged.addListener((c, area) => {
  if (area === 'local' && c.settings && c.settings.oldValue?.catalogUpdate !== c.settings.newValue?.catalogUpdate) schedule();
});
api.runtime.onStartup?.addListener(schedule);
api.runtime.onInstalled.addListener(async () => {
  schedule();
  // extension updated with a newer bundle: rebuild the local index from the stored added works, offline
  const { catalogIndex, catalogAdded } = await api.storage.local.get(['catalogIndex', 'catalogAdded']);
  if (!catalogIndex || !catalogAdded?.length) return;
  const bundle = await loadBundle();
  if (catalogIndex.bundle === bundle.info.builtAt) return;
  const { bin, meta } = rebuild(bundle, catalogAdded);
  await api.storage.local.set({ catalogIndex: { builtAt: Date.now(), bin: toBase64(bin), meta, bundle: bundle.info.builtAt } });
});

async function tabStats() {
  // The active tab is the page, except when the popup itself is open as a tab (Firefox for Android, options page):
  // then use the most recently used web page.
  let [tab] = await api.tabs.query({ active: true, lastFocusedWindow: true });
  if (!/^https?:/.test(tab?.url ?? '')) {
    tab = (await api.tabs.query({})).filter((t) => /^https?:/.test(t.url ?? '')).sort((a, b) => (b.lastAccessed ?? 0) - (a.lastAccessed ?? 0))[0];
  }
  if (!tab) return { blocked: 0 };
  try { return { blocked: (await api.tabs.sendMessage(tab.id, { type: 'sb.stats' }))?.blocked ?? 0 }; } catch { return { blocked: 0 }; }
}

function route(msg) {
  switch (msg?.type) {
    case 'catalog.search': return search(msg.q, msg.limit).then((results) => ({ results }));
    case 'tab.stats': return tabStats();
    case 'catalog.update': return updateNow().then(() => catalogStatus());
    case 'catalog.status': return catalogStatus();
    case 'img.check': case 'img.ocr': case 'text.classify': return infer(msg);
  }
  return null;
}

api.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.target === 'offscreen') return false;
  const p = route(msg);
  if (!p) return false;
  // sendResponse + `return true` works on both Firefox and Chrome (Chrome ignores returned promises)
  p.then(sendResponse, (e) => { console.error('[SpolierBlocker]', msg.type, e); sendResponse({ error: String(e?.message ?? e) }); });
  return true;
});
