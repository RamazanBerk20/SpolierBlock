// Toolbar popup: a quick panel. On/off, pause this site, the page's cover count,
// search-and-mark, the page's text selection as a new name for a work (rule 11), a link to settings.
import { api, el, describe, toast, siteOf, pausedBy, catalogSearch } from '../options/ui.js';
import { withDefaults, addName } from '../options/config.js';

const $ = (id) => document.getElementById(id);
let works = {}, settings = withDefaults(), learned = {}, host = null, results = [];

async function load() {
  const d = await api.storage.local.get(['works', 'settings', 'learned']);
  works = d.works ?? {};
  settings = withDefaults(d.settings);
  learned = d.learned;
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

const search = catalogSearch($('search'), $('search-msg'), { limit: 8, none: 'No matches. Add it by hand in settings.', onResults: (r) => { results = r; renderResults(); } });
$('search').addEventListener('keydown', (e) => {
  const first = $('results').querySelector('button');
  if (e.key === 'Escape' && $('search').value) search.clear();
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

// ---------- a missing name (contract rule 11): the page's selection, which work? then confirm ----------
let page = {}, picking = false, chosen = null, picked = [];
const pickSearch = catalogSearch($('pick-search'), $('pick-msg'), { limit: 6, none: 'No matches.', onResults: (r) => { picked = r; renderPick(); } });
function renderTeach() {
  $('name-btn').textContent = `Add "${page.selection}" as a name for…`;
  $('teach').hidden = !page.selection;
}
function openPick() {
  picking = true; chosen = null; pickSearch.clear();
  $('pick-what').textContent = `Add "${page.selection}" as a name for…`;
  $('pick-done').textContent = '';
  $('pick').hidden = false;
  renderPick();
  $('pick-search').focus();
}
function renderPick() {
  $('pick-results').replaceChildren(...(chosen ? [] : picked).map((w) => el('li', {},
    el('div', { class: 'what' }, el('span', { class: 'title' }, w.title), el('span', { class: 'meta' }, describe(w))),
    el('button', { type: 'button', onclick: () => { chosen = w; renderPick(); $('pick-ok').focus(); } }, 'Choose'))));
  $('pick-ok').hidden = !chosen;
  $('pick-confirm').hidden = !picking;
  $('pick-search').hidden = !!chosen;
  if (chosen) $('pick-what').textContent = `Add "${page.selection}" as a name for ${chosen.title}?`;
}
$('name-btn').addEventListener('click', openPick);
$('pick-cancel').addEventListener('click', () => { $('pick').hidden = true; picking = false; });
$('pick-ok').addEventListener('click', async () => {
  const w = chosen, r = addName(learned, w.id, page.selection);
  if (r.learned) await api.storage.local.set({ learned: r.learned }); // the background re-indexes, every tab re-judges
  const done = r.error ?? `"${page.selection}" is now a name for ${w.title}.`;
  chosen = null; picking = false;
  renderPick();
  $('pick-search').hidden = true;
  $('pick-what').textContent = '';
  $('pick-done').textContent = done;
});

api.storage.onChanged.addListener((c, area) => { if (area === 'local' && (c.works || c.settings || c.learned)) load(); });

(async () => {
  try {
    const [tab] = await api.tabs.query({ active: true, currentWindow: true });
    host = siteOf(tab.url);
  } catch {}
  await load();
  $('search').focus();
  try { page = (await api.runtime.sendMessage({ type: 'tab.stats' })) ?? {}; } catch {}
  const blocked = page.blocked || 0;
  renderTeach();
  $('count').textContent = blocked;
  $('count-label').textContent = blocked === 1 ? 'cover on this page' : 'covers on this page';
})();
