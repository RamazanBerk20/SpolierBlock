// Toolbar popup: a quick panel. On/off, pause this site, the page's cover count, search-and-mark, a link to settings.
import { api, el, describe, toast, siteOf, pausedBy } from '../options/ui.js';
import { withDefaults } from '../options/config.js';

const $ = (id) => document.getElementById(id);
let works = {}, settings = withDefaults(), host = null, results = [], searchSeq = 0;

async function load() {
  const d = await api.storage.local.get(['works', 'settings']);
  works = d.works ?? {};
  settings = withDefaults(d.settings);
  render();
}
const saveSettings = (patch) => api.storage.local.set({ settings: { ...settings, ...patch } });

function render() {
  $('enabled').checked = settings.enabled;
  document.body.classList.toggle('off', !settings.enabled);
  $('pause-row').hidden = !host;
  if (host) {
    $('pause-label').textContent = 'Pause on ' + host;
    $('pause').checked = pausedBy(host, settings.pausedSites).length > 0;
  }
  const k = document.activeElement?.dataset?.k;
  renderResults();
  if (k) document.querySelector(`[data-k="${CSS.escape(k)}"]`)?.focus();
}

function mark(w, state) {
  const prev = works;
  if (works[w.id]?.state === state) {
    const { [w.id]: _, ...rest } = works;
    api.storage.local.set({ works: rest });
    return;
  }
  api.storage.local.set({ works: { ...works, [w.id]: { state, style: works[w.id]?.style ?? null, title: w.title, type: w.type, year: w.year ?? null, ts: Date.now() } } });
  toast(`${state === 'seen' ? 'Seen' : 'Blocked'}: ${w.title}`, () => api.storage.local.set({ works: prev }));
}
function renderResults() {
  $('results').replaceChildren(...results.map((w) => {
    const cur = works[w.id]?.state;
    const b = (state, label) => el('button', { type: 'button', class: cur === state ? 'on' : '', 'aria-pressed': String(cur === state),
      'data-k': w.id + state, onclick: () => mark(w, state) }, label);
    return el('li', {}, el('div', { class: 'what' }, el('span', { class: 'title' }, w.title), el('span', { class: 'meta' }, describe(w))),
      b('seen', 'Seen'), b('blocked', 'Block'));
  }));
}

function clearSearch() {
  $('search').value = ''; results = []; searchSeq++;
  $('search-msg').hidden = true;
  renderResults();
}
let timer;
$('search').addEventListener('input', () => {
  clearTimeout(timer);
  const q = $('search').value.trim();
  if (!q) return clearSearch();
  timer = setTimeout(async () => {
    const n = ++searchSeq;
    let msg = '';
    try {
      const r = await api.runtime.sendMessage({ type: 'catalog.search', q, limit: 8 });
      if (n !== searchSeq) return;
      results = r?.results ?? [];
      if (!results.length) msg = 'No matches. Add it by hand in settings.';
    } catch {
      if (n !== searchSeq) return;
      results = []; msg = 'Search is not available right now.';
    }
    $('search-msg').textContent = msg;
    $('search-msg').hidden = !msg;
    renderResults();
  }, 120);
});
$('search').addEventListener('keydown', (e) => {
  const first = $('results').querySelector('button');
  if (e.key === 'Escape' && $('search').value) clearSearch();
  else if (e.key === 'ArrowDown' && first) first.focus();
  else if (e.key === 'Enter' && first) first.click();
  else return;
  e.preventDefault();
});
$('results').addEventListener('keydown', (e) => {
  const btns = [...$('results').querySelectorAll('button')], i = btns.indexOf(document.activeElement);
  if (i < 0) return;
  if (e.key === 'ArrowDown') (btns[i + 2] ?? btns[i]).focus();
  else if (e.key === 'ArrowUp') (btns[i - 2] ?? $('search')).focus();
  else return;
  e.preventDefault();
});

$('enabled').addEventListener('change', (e) => saveSettings({ enabled: e.target.checked }));
$('pause').addEventListener('change', (e) => {
  const rest = settings.pausedSites.filter((s) => !pausedBy(host, [s]).length);
  saveSettings({ pausedSites: e.target.checked ? [...rest, host] : rest });
});
$('settings').addEventListener('click', async () => {
  await api.runtime.openOptionsPage();
  window.close();
});

api.storage.onChanged.addListener((c, area) => { if (area === 'local' && (c.works || c.settings)) load(); });

(async () => {
  try {
    const [tab] = await api.tabs.query({ active: true, currentWindow: true });
    host = siteOf(tab.url);
  } catch {}
  await load();
  $('search').focus();
  let blocked = 0;
  try { blocked = (await api.runtime.sendMessage({ type: 'tab.stats' }))?.blocked || 0; } catch {}
  $('count').textContent = blocked;
  $('count-label').textContent = blocked === 1 ? 'cover on this page' : 'covers on this page';
})();
