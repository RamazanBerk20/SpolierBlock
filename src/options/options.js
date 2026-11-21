// The settings page (options_ui, opens in a tab). Reads and writes storage.local directly; every other page and tab
// follows through storage.onChanged. Config shapes: docs/agents/contract.md.
import { api, el, describe, toast, catalogLine, catalogSearch } from './ui.js';
import { withDefaults, parseImport, applyImport, exportFile, cleanCustom, nextCustomId, normHost, MAX_IMPORT_BYTES, cleanLearned, addName } from './config.js';

const $ = (id) => document.getElementById(id);
const KEYS = ['works', 'custom', 'settings', 'learned'];
let works = {}, custom = [], settings = withDefaults(), learned = cleanLearned();
let results = [], showAll = false, pendingImport = null;
const selected = new Set();
const PAGE = 200;

// ---------- storage ----------
const put = (o) => api.storage.local.set(o);
const saveSettings = (patch) => put({ settings: { ...settings, ...patch } });
async function snapshot() { return api.storage.local.get(KEYS); }
async function restore(snap) { // undo: put back exactly what was there, including keys that did not exist
  const missing = KEYS.filter((k) => !(k in snap));
  await put(snap);
  if (missing.length) await api.storage.local.remove(missing);
}
function setWorks(next, msg, prev = works) {
  put({ works: next });
  if (msg) toast(msg, () => put({ works: prev }));
}
const entry = (id, w, state) => ({ state, style: works[id]?.style ?? null, title: w.title, type: w.type ?? null, year: w.year ?? null, ts: Date.now() });

async function load() {
  const d = await api.storage.local.get(KEYS);
  works = d.works ?? {};
  custom = Array.isArray(d.custom) ? d.custom : [];
  settings = withDefaults(d.settings);
  learned = cleanLearned(d.learned);
  for (const id of selected) if (!works[id]) selected.delete(id);
  keepFocus(render);
  lookupTitles();
}
// Re-rendering replaces rows; put focus back on the same control so keyboard users keep their place.
function keepFocus(fn) {
  const k = document.activeElement?.dataset?.k;
  fn();
  if (k) document.querySelector(`[data-k="${CSS.escape(k)}"]`)?.focus();
}

function render() {
  $('enabled').checked = settings.enabled;
  $('state-line').textContent = !settings.enabled ? 'Blocking is off everywhere.'
    : settings.blockUnlisted ? 'On. Covers every work you have not marked as seen.' : 'On. Covers only the works you mark as blocked.';
  for (const id of ['blockUnlisted', 'scanImages', 'unknownImages']) $(id).checked = settings[id];
  for (const r of document.querySelectorAll('input[name="style"]')) r.checked = r.value === settings.style;
  $('catalogUpdate').value = settings.catalogUpdate;
  renderPreview();
  renderLibrary();
  renderResults();
  renderCustom();
  renderSites();
  renderLearned();
}

// ---------- library ----------
const STYLE_OPTS = () => [['', `Default (${settings.style === 'all' ? 'every mention' : 'only spoilers'})`], ['all', 'Every mention'], ['spoilers', 'Only spoilers']];
function stateSeg(id, w, i) {
  const name = 'st' + i;
  return el('div', { class: 'seg small', role: 'radiogroup', 'aria-label': `State of ${w.title}` },
    ...[['seen', 'Seen'], ['blocked', 'Blocked']].map(([v, label]) => el('label', { class: v },
      el('input', { type: 'radio', name, value: v, checked: w.state === v, 'data-k': id + '|' + v,
        onchange: () => setWorks({ ...works, [id]: { ...works[id], state: v } }) }),
      el('span', {}, label))));
}
function libRow(id, w, i) {
  const isCustom = id.startsWith('custom:');
  return el('li', { class: 'row ' + w.state },
    el('label', { class: 'pick' }, el('input', { type: 'checkbox', checked: selected.has(id), 'data-k': id + '|pick', 'aria-label': `Select ${w.title}`,
      onchange: (e) => { e.target.checked ? selected.add(id) : selected.delete(id); renderBulk(); } })),
    el('div', { class: 'what' }, el('span', { class: 'title' }, w.title), el('span', { class: 'meta' }, [describe(w), isCustom && 'added by hand'].filter(Boolean).join(' · '))),
    stateSeg(id, w, i),
    el('select', { class: 'style', 'aria-label': `How to cover ${w.title}`, 'data-k': id + '|style',
      onchange: (e) => setWorks({ ...works, [id]: { ...works[id], style: e.target.value || null } }) },
      STYLE_OPTS().map(([v, t]) => el('option', { value: v, selected: (w.style ?? '') === v }, t))),
    namesToggle(id),
    el('button', { type: 'button', class: 'icon quiet', 'aria-label': `Remove ${w.title}`, 'data-k': id + '|rm', title: 'Remove from library',
      onclick: () => { const { [id]: _, ...rest } = works; setWorks(rest, `Removed ${w.title}`); } }, '×'),
    namesEditor(id, w.title));
}
function shownWorks() {
  const q = $('filter').value.trim().toLowerCase(), type = $('f-type').value;
  const state = document.querySelector('input[name="f-state"]:checked').value;
  return Object.entries(works).filter(([, w]) => (!q || w.title.toLowerCase().includes(q)) && (!type || w.type === type) && (!state || w.state === state))
    .sort((a, b) => (b[1].ts || 0) - (a[1].ts || 0));
}
function renderLibrary() {
  const all = Object.values(works), seen = all.filter((w) => w.state === 'seen').length;
  $('lib-summary').textContent = all.length ? `${all.length} ${all.length === 1 ? 'work' : 'works'} · ${seen} seen · ${all.length - seen} blocked` : '';
  const shown = shownWorks();
  const list = showAll ? shown : shown.slice(0, PAGE);
  $('lib').replaceChildren(...list.map(([id, w], i) => libRow(id, w, i)));
  $('more').hidden = list.length === shown.length;
  $('more').textContent = `Show all ${shown.length}`;
  $('bulk').hidden = !shown.length;
  const empty = $('lib-empty');
  empty.hidden = shown.length > 0;
  if (!all.length) {
    empty.replaceChildren(el('p', {}, 'Nothing here yet.'),
      el('p', { class: 'soft' }, settings.blockUnlisted
        ? 'Search above and mark what you have seen. Everything you have not marked is covered.'
        : 'Search above and mark what you want covered. Blocking of unlisted works is off.'));
  } else if (!shown.length) {
    empty.replaceChildren(el('p', {}, 'No works match these filters.'),
      el('button', { type: 'button', onclick: clearFilters }, 'Clear filters'));
  }
  renderBulk(shown);
}
function renderBulk(shown = shownWorks()) {
  const ids = shown.map(([id]) => id), n = ids.filter((id) => selected.has(id)).length;
  $('select-all').checked = n > 0 && n === ids.length;
  $('select-all').indeterminate = n > 0 && n < ids.length;
  $('select-label').textContent = n ? `${n} selected` : `Select all ${ids.length} shown`;
  $('bulk-actions').hidden = !n;
}
function clearFilters() {
  $('filter').value = ''; $('f-type').value = '';
  document.querySelector('input[name="f-state"][value=""]').checked = true;
  renderLibrary();
  $('filter').focus();
}
$('filter').addEventListener('input', () => { showAll = false; renderLibrary(); });
$('f-type').addEventListener('change', renderLibrary);
for (const r of document.querySelectorAll('input[name="f-state"]')) r.addEventListener('change', renderLibrary);
$('more').addEventListener('click', () => { showAll = true; renderLibrary(); });
$('select-all').addEventListener('change', (e) => {
  for (const [id] of shownWorks()) e.target.checked ? selected.add(id) : selected.delete(id);
  renderLibrary();
});
for (const b of document.querySelectorAll('[data-bulk]')) b.addEventListener('click', () => {
  const act = b.dataset.bulk, ids = shownWorks().map(([id]) => id).filter((id) => selected.has(id));
  const next = { ...works };
  for (const id of ids) if (act === 'remove') delete next[id]; else next[id] = { ...next[id], state: act };
  selected.clear();
  setWorks(next, `${act === 'remove' ? 'Removed' : act === 'seen' ? 'Marked as seen:' : 'Blocked:'} ${ids.length} works`);
});

// ---------- catalog search (add to the library) ----------
function resultRow(w) {
  const cur = works[w.id]?.state;
  const act = (state, label) => el('button', { type: 'button', class: cur === state ? 'on ' + state : '', 'aria-pressed': String(cur === state), 'data-k': w.id + '|r' + state,
    onclick: () => {
      if (cur === state) { const { [w.id]: _, ...rest } = works; setWorks(rest, `Removed ${w.title}`); }
      else setWorks({ ...works, [w.id]: entry(w.id, w, state) }, `${state === 'seen' ? 'Marked as seen' : 'Blocked'}: ${w.title}`);
    } }, label);
  return el('li', {}, el('div', { class: 'what' }, el('span', { class: 'title' }, w.title), el('span', { class: 'meta' }, describe(w))),
    el('span', { class: 'acts' }, act('seen', "I've seen it"), act('blocked', 'Block'), namesToggle(w.id)), namesEditor(w.id, w.title));
}
function renderResults() { $('results').replaceChildren(...results.map(resultRow)); }
const search = catalogSearch($('search'), $('search-msg'), { limit: 12, none: 'No matches. You can add it by hand below.', onResults: (r) => { results = r; renderResults(); } });
const clearSearch = search.clear;
$('search').addEventListener('keydown', (e) => {
  const first = $('results').querySelector('button');
  if (e.key === 'Escape') clearSearch();
  else if (e.key === 'ArrowDown' && first) first.focus();
  else if (e.key === 'Enter' && first) first.click();
  else return;
  e.preventDefault();
});
$('results').addEventListener('keydown', (e) => { // arrows move between rows, Escape returns to the search box
  const btns = [...$('results').querySelectorAll('button')], i = btns.indexOf(document.activeElement);
  if (i < 0) return;
  if (e.key === 'ArrowDown') (btns[i + 2] ?? btns[i]).focus();
  else if (e.key === 'ArrowUp') (btns[i - 2] ?? $('search')).focus();
  else if (e.key === 'ArrowRight') (btns[i + 1] ?? btns[i]).focus();
  else if (e.key === 'ArrowLeft') (btns[i - 1] ?? btns[i]).focus();
  else if (e.key === 'Escape') { clearSearch(); $('search').focus(); }
  else return;
  e.preventDefault();
});
document.addEventListener('keydown', (e) => {
  if (e.key === '/' && !e.ctrlKey && !e.metaKey && !e.altKey && !/^(INPUT|SELECT|TEXTAREA)$/.test(document.activeElement?.tagName)) {
    e.preventDefault();
    $('search').focus();
  }
});

// ---------- added by hand ----------
function renderCustom() {
  $('custom-list').replaceChildren(...custom.map((c) => {
    const w = works[c.id];
    return el('li', { class: 'row' },
      el('div', { class: 'what' }, el('span', { class: 'title' }, c.title),
        el('span', { class: 'meta' }, [describe(c), c.aliases.length && 'also ' + c.aliases.join(', ')].filter(Boolean).join(' · '))),
      el('span', { class: 'mark ' + (w?.state ?? 'none') }, w?.state === 'seen' ? 'Seen' : w?.state === 'blocked' ? 'Blocked' : 'Default'),
      namesToggle(c.id),
      el('button', { type: 'button', class: 'icon quiet', 'aria-label': `Delete ${c.title}`, title: 'Delete', 'data-k': c.id + '|crm',
        onclick: async () => {
          const snap = await snapshot();
          const { [c.id]: _, ...rest } = works;
          await put({ custom: custom.filter((x) => x.id !== c.id), works: rest });
          toast(`Deleted ${c.title}`, () => restore(snap));
        } }, '×'),
      namesEditor(c.id, c.title));
  }));
}

// ---------- learned from reports (contract rule 11) ----------
const openNames = new Set(); // work ids whose "Other names" editor is open
let known = {}; // work id -> { title, type, year } from the index, for ids that are neither in the library nor added by hand
const workOf = (id) => works[id] ?? custom.find((c) => c.id === id) ?? known[id] ?? { title: id };
const learnedIds = () => [...new Set([...Object.keys(learned.names), ...Object.keys(learned.not)])];
async function lookupTitles() {
  const ids = learnedIds().filter((id) => !works[id] && !id.startsWith('custom:') && !known[id]);
  if (!ids.length) return;
  try { Object.assign(known, (await api.runtime.sendMessage({ type: 'catalog.titles', ids }))?.works); keepFocus(renderLearned); } catch {}
}
function saveLearned(next, msg) {
  const prev = learned;
  put({ learned: next });
  if (msg) toast(msg, () => put({ learned: prev }));
}
function namesToggle(id) {
  const n = learned.names[id]?.length ?? 0;
  return el('button', { type: 'button', class: 'quiet names-btn', 'aria-expanded': String(openNames.has(id)), 'data-k': id + '|names',
    onclick: () => { openNames.has(id) ? openNames.delete(id) : openNames.add(id); keepFocus(render); } }, n ? `Other names (${n})` : 'Other names');
}
// the "Other names" editor of one work: its learned.names as chips, and a field to add one
function namesEditor(id, title) {
  if (!openNames.has(id)) return null;
  const list = learned.names[id] ?? [];
  const input = el('input', { type: 'text', maxlength: 60, placeholder: 'Another name', 'aria-label': `Another name for ${title}`, 'data-k': id + '|nin' });
  const msg = el('span', { class: 'soft', 'aria-live': 'polite' });
  const without = (n) => { const rest = list.filter((x) => x !== n), names = { ...learned.names, [id]: rest }; if (!rest.length) delete names[id]; return { ...learned, names }; };
  return el('div', { class: 'names' },
    el('ul', { class: 'chips', 'aria-label': `Other names of ${title}` }, list.length ? list.map((n) => el('li', {}, el('span', {}, n),
      el('button', { type: 'button', class: 'icon quiet', 'aria-label': `Remove ${n}`, title: 'Remove', 'data-k': id + '|n|' + n,
        onclick: () => saveLearned(without(n), `Removed ${n}`) }, '×'))) : el('li', { class: 'none soft' }, 'No other names yet.')),
    el('form', { class: 'inline', onsubmit: (e) => {
      e.preventDefault();
      const r = addName(learned, id, input.value);
      if (r.error) msg.textContent = r.error; else saveLearned(r.learned);
    } }, input, el('button', { type: 'submit' }, 'Add name'), msg));
}
function renderLearned() {
  const rm = (label, next, msg, k) => el('button', { type: 'button', class: 'icon quiet', 'aria-label': label, title: 'Remove', 'data-k': k, onclick: () => saveLearned(next(), msg) }, '×');
  const nots = Object.entries(learned.not).flatMap(([id, keys]) => keys.map((k) => [id, k]));
  $('not-list').replaceChildren(...nots.map(([id, k]) => {
    const t = workOf(id).title;
    return el('li', { class: 'row' }, el('div', { class: 'what' }, el('span', { class: 'title' }, t), el('span', { class: 'meta' }, `Not this on ${k}`)),
      rm(`Remove "Not this" for ${t} on ${k}`, () => {
        const rest = learned.not[id].filter((x) => x !== k), not = { ...learned.not, [id]: rest };
        if (!rest.length) delete not[id];
        return { ...learned, not };
      }, `Removed: ${t} on ${k}`, id + '|not|' + k));
  }));
  $('not-empty').hidden = nots.length > 0;
  $('names-list').replaceChildren(...Object.entries(learned.names).map(([id, ns]) => {
    const t = workOf(id).title;
    return el('li', { class: 'row' }, el('div', { class: 'what' }, el('span', { class: 'title' }, t), el('span', { class: 'meta' }, ns.join(', '))),
      namesToggle(id), namesEditor(id, t));
  }));
  $('names-empty').hidden = Object.keys(learned.names).length > 0;
}
$('custom-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const title = $('c-title').value.trim();
  if (custom.some((c) => c.title.toLowerCase() === title.toLowerCase())) { $('c-msg').textContent = `${title} is already on your list.`; return; }
  const id = nextCustomId(custom);
  const c = cleanCustom({ id, title, type: $('c-type').value, aliases: $('c-aliases').value.split(',') });
  if (!c) { $('c-msg').textContent = 'Enter a title of up to 200 characters.'; return; }
  const state = $('c-state').value;
  await put({ custom: [...custom, c], ...(state ? { works: { ...works, [id]: { state, style: null, title: c.title, type: c.type, year: null, ts: Date.now() } } } : {}) });
  $('c-msg').textContent = `Added ${c.title}. Pages pick it up in a few seconds.`;
  $('c-title').value = ''; $('c-aliases').value = '';
  $('c-title').focus();
});

// ---------- blocking ----------
function renderPreview() {
  const sample = Object.values(works).filter((w) => w.state === 'blocked').sort((a, b) => b.ts - a.ts)[0]?.title ?? custom[0]?.title ?? 'Hollow Pines';
  $('preview-text').textContent = settings.style === 'spoilers' ? `Spoiler about ${sample}` : `Mentions ${sample}`;
}
$('enabled').addEventListener('change', (e) => saveSettings({ enabled: e.target.checked }));
for (const id of ['blockUnlisted', 'scanImages', 'unknownImages']) $(id).addEventListener('change', (e) => saveSettings({ [id]: e.target.checked }));
for (const r of document.querySelectorAll('input[name="style"]')) r.addEventListener('change', () => saveSettings({ style: r.value }));

// A list of host names in settings: paused sites, sites where videos with no caption are covered.
function siteList(key, listId, verb, none) {
  const list = settings[key];
  $(listId).replaceChildren(...list.map((s) => el('li', {}, el('span', {}, s),
    el('button', { type: 'button', class: 'icon quiet', 'aria-label': `${verb} ${s}`, title: verb, 'data-k': s + '|' + key, onclick: () => {
      saveSettings({ [key]: list.filter((x) => x !== s) });
      toast(`${verb === 'Resume' ? 'Resumed' : 'Removed'} ${s}`, () => saveSettings({ [key]: list }));
    } }, '×'))));
  if (!list.length) $(listId).append(el('li', { class: 'none soft' }, none));
}
function renderSites() {
  siteList('pausedSites', 'sites', 'Resume', 'No paused sites.');
  siteList('captionlessVideos', 'vsites', 'Remove', 'No sites.');
}
function siteForm(form, input, msg, key) {
  $(form).addEventListener('submit', (e) => {
    e.preventDefault();
    const h = normHost($(input).value);
    if (!h) { $(msg).textContent = 'Enter a site like example.com.'; return; }
    $(msg).textContent = '';
    $(input).value = '';
    if (!settings[key].includes(h)) saveSettings({ [key]: [...settings[key], h] });
  });
}
siteForm('site-form', 'site', 'site-msg', 'pausedSites');
siteForm('vsite-form', 'vsite', 'vsite-msg', 'captionlessVideos');

// ---------- data ----------
$('export').addEventListener('click', async () => {
  const d = await snapshot();
  const url = URL.createObjectURL(new Blob([JSON.stringify(exportFile(d), null, 2)], { type: 'application/json' }));
  const a = el('a', { href: url, download: 'spolierblock-config.json', hidden: true });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
});

const imode = () => document.querySelector('input[name="imode"]:checked').value;
function renderImportMode() {
  const replace = imode() === 'replace';
  $('imode-help').textContent = replace
    ? 'Your library, works added by hand, settings and what it learned from your reports are replaced by the file.'
    : 'Works from the file are added; where both have the same work, the file wins.';
  $('isettings-row').hidden = replace;
}
for (const r of document.querySelectorAll('input[name="imode"]')) r.addEventListener('change', renderImportMode);
$('import-file').addEventListener('change', async (e) => {
  const f = e.target.files[0];
  e.target.value = '';
  if (!f) return;
  $('import-msg').textContent = '';
  const r = f.size > MAX_IMPORT_BYTES ? { ok: false, error: 'This file is too large to be a SpolierBlock export.' } : parseImport(await f.text());
  if (!r.ok) { pendingImport = null; $('import-panel').hidden = true; $('import-msg').textContent = r.error; return; }
  pendingImport = r.data;
  const n = Object.values(r.data.works), seen = n.filter((w) => w.state === 'seen').length;
  $('import-summary').textContent = `${f.name}: ${n.length} works (${seen} seen, ${n.length - seen} blocked), ${r.data.custom.length} added by hand`
    + (Object.keys(r.data.settings).length ? ', settings' : '') + (r.skipped ? `. ${r.skipped} unreadable ${r.skipped === 1 ? 'entry' : 'entries'} will be skipped.` : '.');
  $('import-panel').hidden = false;
  renderImportMode();
  $('import-go').focus();
});
$('import-cancel').addEventListener('click', () => { pendingImport = null; $('import-panel').hidden = true; });
$('import-go').addEventListener('click', async () => {
  if (!pendingImport) return;
  const mode = imode();
  if (mode === 'replace' && !confirm('Replace your library, works added by hand, settings and what it learned with this file?')) return;
  const snap = await snapshot();
  const next = applyImport({ works: snap.works, custom: snap.custom, settings: snap.settings, learned: snap.learned }, pendingImport, { mode, withSettings: $('import-settings').checked });
  await put(next); // one write: the list is either the old one or the complete new one
  pendingImport = null;
  $('import-panel').hidden = true;
  toast(mode === 'replace' ? 'Replaced with the imported file' : 'Imported and merged', () => restore(snap));
});

$('catalogUpdate').addEventListener('change', (e) => saveSettings({ catalogUpdate: e.target.value }));
async function refreshCatalog() {
  try { $('catalogStatus').textContent = catalogLine(await api.runtime.sendMessage({ type: 'catalog.status' })); } catch {}
}
$('updateNow').addEventListener('click', async () => {
  // an explicit click is consent for this one download, even when automatic updates are off
  $('updateNow').disabled = true;
  $('catalogStatus').textContent = 'Checking Wikidata…';
  try { $('catalogStatus').textContent = catalogLine(await api.runtime.sendMessage({ type: 'catalog.update' })); }
  catch { $('catalogStatus').textContent = 'Update failed: the extension did not answer.'; }
  $('updateNow').disabled = false;
});

$('reset').addEventListener('click', async () => {
  if (!confirm('Reset SpolierBlock? This clears your library, works added by hand, settings and what it learned from your reports.')) return;
  const snap = await snapshot();
  await api.storage.local.remove(KEYS);
  toast('Everything was reset', () => restore(snap));
});

// ---------- about ----------
$('version').textContent = 'Version ' + api.runtime.getManifest().version;
api.commands?.getAll?.().then((cmds) => {
  const c = cmds.find((x) => x.name === 'toggle-blocking');
  if (c?.shortcut) $('shortcut').textContent = c.shortcut;
  else $('shortcut-line').textContent = 'You can set a shortcut to turn blocking on or off in the browser\'s extension shortcut settings.';
}).catch(() => {});

// The rail marks the section being read.
const links = [...document.querySelectorAll('nav a')];
const io = new IntersectionObserver((entries) => {
  for (const e of entries) if (e.isIntersecting) for (const a of links) a.classList.toggle('here', a.hash === '#' + e.target.id);
}, { rootMargin: '-30% 0px -60% 0px' });
for (const s of document.querySelectorAll('main section')) io.observe(s);

api.storage.onChanged.addListener((c, area) => {
  if (area !== 'local') return;
  if (KEYS.some((k) => c[k])) load();
  if (c.catalogMeta || c.catalogIndex) refreshCatalog();
});
load();
refreshCatalog();
