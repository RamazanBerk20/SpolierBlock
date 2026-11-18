// Small helpers shared by the settings page and the popup.
export const api = globalThis.browser ?? globalThis.chrome; // MV3 chrome.* returns promises too

export function el(tag, props = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (k in e && typeof v !== 'string') e[k] = v;
    else e.setAttribute(k, v === true ? '' : v);
  }
  e.append(...kids.flat().filter((k) => k != null && k !== false));
  return e;
}

export const TYPE_NAMES = { movie: 'Film', tv: 'Series', game: 'Game', book: 'Book', anime: 'Anime', manga: 'Manga', comic: 'Comic' };
export const describe = (w) => [TYPE_NAMES[w.type] ?? w.type, w.year].filter(Boolean).join(' · ');

// One toast at a time, with an optional undo. undo() restores whatever the caller captured.
let toastTimer;
export function toast(text, undo) {
  document.querySelector('.toast')?.remove();
  clearTimeout(toastTimer);
  const t = el('div', { class: 'toast', role: 'status' }, el('span', {}, text));
  if (undo) t.append(el('button', { type: 'button', onclick: () => { t.remove(); undo(); } }, 'Undo'));
  document.body.append(t);
  toastTimer = setTimeout(() => t.remove(), undo ? 8000 : 4000);
}

// "https://www.example.com/x" -> "example.com", for pausing: a paused entry covers its subdomains.
export const siteOf = (url) => {
  try { const u = new URL(url); return /^https?:$/.test(u.protocol) ? u.hostname.replace(/^www\./, '') : null; } catch { return null; }
};
export const pausedBy = (host, list) => list.filter((s) => host === s || host.endsWith('.' + s));

export const ago = (t) => {
  const m = Math.round((Date.now() - t) / 60000);
  if (m < 2) return 'just now';
  if (m < 120) return m + ' minutes ago';
  const h = Math.round(m / 60);
  if (h < 48) return h + ' hours ago';
  return Math.round(h / 24) + ' days ago';
};

// Catalog update status: "25,467 titles + 312 new · updated 3 days ago", or the last error in plain words.
export function catalogLine(st) {
  if (!st || typeof st.bundled !== 'number') return '';
  const m = st.meta || {};
  let text = st.bundled.toLocaleString('en-US') + ' titles';
  if (st.total > st.bundled) text += ' + ' + (st.total - st.bundled).toLocaleString('en-US') + ' new';
  if (st.updating) text += ' · checking Wikidata…';
  else if (m.lastError) text += ' · last update failed: ' + m.lastError;
  else if (m.lastSuccess) text += ' · updated ' + ago(m.lastSuccess);
  else text += ' · never updated';
  return text;
}
