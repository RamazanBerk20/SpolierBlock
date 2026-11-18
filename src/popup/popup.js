// Dev mock: lets the page work when opened as a plain file.
if (!globalThis.browser) {
  const db = {}, subs = [];
  const works = `Blade Runner|movie|1982;Arrival|movie|2016;The Matrix|movie|1999;Breaking Bad|tv|2008;Severance|tv|2022;The Wire|tv|2002;Elden Ring|game|2022;Hades|game|2020;Portal 2|game|2011;Dune|book|1965;Neuromancer|book|1984;Fullmetal Alchemist|anime|2003;Berserk|manga|1989;Watchmen|comic|1986;Cowboy Bebop|anime|`
    .split(";").map((s, i) => { const [title, type, y] = s.split("|"); return { id: "w" + i, title, type, year: y ? +y : null }; });
  globalThis.browser = {
    storage: {
      local: {
        get: async (k) => (typeof k === "string" ? { [k]: db[k] } : { ...db }),
        set: async (o) => { const ch = {}; for (const k in o) { ch[k] = { oldValue: db[k], newValue: o[k] }; db[k] = o[k]; } subs.forEach((f) => f(ch, "local")); },
      },
      onChanged: { addListener: (f) => subs.push(f) },
    },
    runtime: {
      sendMessage: async (m) => m.type === "tab.stats" ? { blocked: 3 }
        : { results: works.filter((w) => w.title.toLowerCase().includes(m.q.toLowerCase())).slice(0, m.limit) },
    },
    tabs: { query: async () => [{ url: "https://example.com/reviews" }] },
  };
}

const $ = (id) => document.getElementById(id);
const DEFAULTS = { enabled: true, scanImages: true, mode: "any", pausedSites: [], catalogUpdate: "off" };
let seen = {}, settings = { ...DEFAULTS }, host = null, results = [], searchSeq = 0;

const el = (tag, cls, text) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
};
const meta = (w) => [w.type, w.year].filter(Boolean).join(" · ");

async function load() {
  const d = await browser.storage.local.get(["seen", "settings"]);
  seen = d.seen || {};
  settings = { ...DEFAULTS, ...(d.settings || {}) };
  if (!Array.isArray(settings.pausedSites)) settings.pausedSites = [];
  render();
}

function saveSettings(patch) {
  settings = { ...settings, ...patch };
  return browser.storage.local.set({ settings });
}

function render() {
  $("enabled").checked = settings.enabled;
  $("scanImages").checked = settings.scanImages;
  $("spoilerMode").checked = settings.mode === "spoiler";
  $("catalogUpdate").value = settings.catalogUpdate;
  $("pause-row").hidden = !host;
  if (host) {
    $("pause-label").textContent = "Pause on " + host;
    $("pause").checked = settings.pausedSites.includes(host);
  }
  renderSeen();
  renderResults();
}

function renderSeen() {
  const all = Object.entries(seen).sort((a, b) => (b[1].ts || 0) - (a[1].ts || 0));
  const q = $("filter").value.trim().toLowerCase();
  $("filter").hidden = all.length <= 8;
  const shown = all.length > 8 && q ? all.filter(([, w]) => w.title.toLowerCase().includes(q)) : all;
  $("count").textContent = all.length ? "(" + all.length + ")" : "";
  $("empty").hidden = all.length > 0;
  $("seen").replaceChildren(...shown.map(([id, w]) => {
    const li = el("li");
    const t = el("span", "title grow", w.title);
    const m = el("span", "meta", meta(w));
    const b = el("button", "rm", "×");
    b.type = "button";
    b.setAttribute("aria-label", "Remove " + w.title);
    b.addEventListener("click", () => {
      delete seen[id];
      browser.storage.local.set({ seen });
    });
    li.append(t, m, b);
    return li;
  }));
}

function renderResults() {
  $("results").replaceChildren(...results.map((w) => {
    const li = el("li");
    if (seen[w.id]) {
      li.append(el("span", "title grow", w.title), el("span", "meta", meta(w)), el("span", "tag done", "Seen"));
      return li;
    }
    const b = el("button", "add");
    b.type = "button";
    b.append(el("span", "title", w.title), el("span", "meta", meta(w)), el("span", "tag", "Add"));
    b.addEventListener("click", () => {
      seen[w.id] = { title: w.title, type: w.type, year: w.year, ts: Date.now() };
      browser.storage.local.set({ seen });
      $("search").focus();
    });
    b.addEventListener("keydown", (e) => {
      const btns = [...$("results").querySelectorAll("button")];
      const i = btns.indexOf(b);
      if (e.key === "ArrowDown") (btns[i + 1] || b).focus();
      else if (e.key === "ArrowUp") (btns[i - 1] || $("search")).focus();
      else if (e.key === "Escape") clearSearch();
      else return;
      e.preventDefault();
    });
    li.append(b);
    return li;
  }));
}

function clearSearch() {
  $("search").value = "";
  results = [];
  searchSeq++;
  $("search-msg").hidden = true;
  renderResults();
  $("search").focus();
}

let timer;
$("search").addEventListener("input", () => {
  clearTimeout(timer);
  const q = $("search").value.trim();
  if (!q) return clearSearch();
  timer = setTimeout(async () => {
    const n = ++searchSeq;
    let msg = "";
    try {
      const r = await browser.runtime.sendMessage({ type: "catalog.search", q, limit: 20 });
      if (n !== searchSeq) return;
      results = (r && r.results) || [];
      if (!results.length) msg = "No matches.";
    } catch {
      if (n !== searchSeq) return;
      results = [];
      msg = "Search unavailable";
    }
    $("search-msg").textContent = msg;
    $("search-msg").hidden = !msg;
    renderResults();
  }, 150);
});
$("search").addEventListener("keydown", (e) => {
  if (e.key === "Escape") { clearSearch(); e.preventDefault(); }
  else if (e.key === "ArrowDown") {
    const first = $("results").querySelector("button");
    if (first) { first.focus(); e.preventDefault(); }
  } else if (e.key === "Enter") {
    const first = $("results").querySelector("button");
    if (first) first.click();
  }
});
$("filter").addEventListener("input", renderSeen);

$("enabled").addEventListener("change", (e) => saveSettings({ enabled: e.target.checked }));
$("scanImages").addEventListener("change", (e) => saveSettings({ scanImages: e.target.checked }));
$("spoilerMode").addEventListener("change", (e) => saveSettings({ mode: e.target.checked ? "spoiler" : "any" }));
$("catalogUpdate").addEventListener("change", (e) => saveSettings({ catalogUpdate: e.target.value }));

// Catalog update status: "25,467 titles + 312 new · updated 3 days ago", or the last error in plain words.
const ago = (t) => {
  const m = Math.round((Date.now() - t) / 60000);
  if (m < 2) return "just now";
  if (m < 120) return m + " minutes ago";
  const h = Math.round(m / 60);
  if (h < 48) return h + " hours ago";
  return Math.round(h / 24) + " days ago";
};
function renderCatalog(st) {
  if (!st || typeof st.bundled !== "number") { $("catalogStatus").textContent = ""; return; }
  const m = st.meta || {};
  let text = st.bundled.toLocaleString("en-US") + " titles";
  if (st.total > st.bundled) text += " + " + (st.total - st.bundled).toLocaleString("en-US") + " new";
  if (st.updating) text += " · checking Wikidata…";
  else if (m.lastError) text += " · last update failed: " + m.lastError;
  else if (m.lastSuccess) text += " · updated " + ago(m.lastSuccess);
  else text += " · never updated";
  $("catalogStatus").textContent = text;
}
async function refreshCatalog() {
  try { renderCatalog(await browser.runtime.sendMessage({ type: "catalog.status" })); } catch {}
}
$("updateNow").addEventListener("click", async () => {
  // an explicit click is consent for this one download, even when automatic updates are off
  $("updateNow").disabled = true;
  $("catalogStatus").textContent = "Checking Wikidata…";
  try { renderCatalog(await browser.runtime.sendMessage({ type: "catalog.update" })); }
  catch { $("catalogStatus").textContent = "Update failed: the extension did not answer"; }
  $("updateNow").disabled = false;
});
$("pause").addEventListener("change", (e) => {
  const rest = settings.pausedSites.filter((h) => h !== host);
  saveSettings({ pausedSites: e.target.checked ? [...rest, host] : rest });
});

browser.storage.onChanged.addListener(load);
browser.storage.onChanged.addListener((c) => { if (c.catalogMeta || c.catalogIndex) refreshCatalog(); });

(async () => {
  try {
    const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
    const u = new URL(tab.url);
    if (/^https?:$/.test(u.protocol)) host = u.hostname;
  } catch {}
  await load();
  refreshCatalog();
  let blocked = 0;
  try { blocked = (await browser.runtime.sendMessage({ type: "tab.stats" })).blocked || 0; } catch {}
  $("status").textContent = blocked + " blocked on this page";
})();
