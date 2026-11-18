// SpolierBlocker content script (document_start). Matches catalog works in text synchronously from a
// MutationObserver (runs before paint), sends media to the background for CLIP/OCR verdicts, and covers
// the containing "post-like" block with an overlay.
(() => {
  'use strict';
  const api = globalThis.browser ?? globalThis.chrome;
  const root = document.documentElement;
  if (!root || window.__sbLoaded) return;
  window.__sbLoaded = true;

  // shortcut: top frame only (manifest has no all_frames) and open/closed shadow roots are not observed; embedded posts in iframes and web-component internals leak, add all_frames + shadow traversal when a target site needs it.
  // shortcut: CSS background-image heroes and document.title are not scanned, add when a target site shows spoilers there.
  const MIN_MEDIA = 96; // px; smaller images are icons/avatars and are never scanned
  const MAX_BLOCK_TEXT = 3000; // a "post-like" container larger than this is a page section, not a post
  const FRAME_EVERY_MS = 5000; // video re-check period during playback
  const DEFAULTS = { enabled: true, scanImages: true, pausedSites: [], mode: 'any' };

  let matcher = null, meta = null;
  let settings = DEFAULTS, seenIds = {}, seenIdx = new Set();
  let active = false;

  // Fail-safe: never leave a page invisible if something below throws or the index fails to load.
  const failSafe = setTimeout(() => root.setAttribute('data-sb-ready', ''), 2500);

  const host = location.hostname.replace(/^www\.|^mobile\.|^m\./, '');
  const SITE_BLOCKS = {
    'twitter.com': 'article[data-testid="tweet"], [data-testid="UserCell"], [data-testid="trend"]',
    'x.com': 'article[data-testid="tweet"], [data-testid="UserCell"], [data-testid="trend"]',
    'youtube.com': 'ytd-rich-item-renderer, ytd-video-renderer, ytd-compact-video-renderer, ytd-grid-video-renderer, ' +
      'ytd-playlist-video-renderer, ytd-playlist-panel-video-renderer, ytd-reel-item-renderer, ytd-comment-thread-renderer, ' +
      'ytd-watch-metadata, yt-lockup-view-model, ytm-shorts-lockup-view-model, ytm-video-with-context-renderer, ytm-comment-thread-renderer',
    'reddit.com': 'shreddit-post, shreddit-comment, [data-testid="post-container"], .thing, article',
  };
  const siteSel = SITE_BLOCKS[host] ?? null;
  const GENERIC = 'article, [role="article"], li, figure, blockquote, [class*="card" i], [class*="post" i], ' +
    '[class*="tweet" i], [class*="comment" i], [class*="item" i], [class*="entry" i]';
  const LEAFY = new Set(['P', 'LI', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'BLOCKQUOTE', 'TD', 'TH', 'DD', 'DT', 'FIGCAPTION', 'PRE', 'DIV', 'SECTION']);
  const SKIP_TEXT = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEXTAREA', 'TEMPLATE', 'SB-OVERLAY', 'TITLE', 'HEAD']);

  // ---------- block discovery ----------
  function findBlock(el) {
    let leaf = null;
    for (let e = el; e && e !== document.body && e !== root; e = e.parentElement) {
      if (siteSel && e.matches(siteSel)) return e;
      if (e.matches(GENERIC) && e.textContent.length <= MAX_BLOCK_TEXT) return e;
      if (!leaf && LEAFY.has(e.tagName)) leaf = e;
    }
    const b = leaf ?? (el === document.body ? null : el);
    // shortcut: loose text directly inside a huge container is not blocked (would black out the page); needs text-range overlays to fix.
    return b && b !== root && b !== document.body && b.textContent.length <= MAX_BLOCK_TEXT * 3 ? b : null;
  }
  function findMediaBlock(el) {
    const b = findBlock(el.parentElement);
    return b && b.textContent.length <= MAX_BLOCK_TEXT ? b : el.parentElement;
  }

  function blockText(block) {
    // text nodes joined with newlines: textContent would glue "<div>@late</div><p>Snape…" into "@lateSnape"
    let t = '';
    const tw = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
    for (let n; (n = tw.nextNode());) if (!SKIP_TEXT.has(n.parentElement?.tagName)) t += n.data + '\n';
    for (const e of block.querySelectorAll('img[alt], [aria-label], [title]')) {
      if (e.tagName === 'SB-OVERLAY') continue;
      t += '\n' + (e.getAttribute('alt') || '') + '\n' + (e.getAttribute('aria-label') || '') + '\n' + (e.getAttribute('title') || '');
    }
    const ocr = ocrText.get(block);
    return ocr ? t + '\n' + ocr : t;
  }

  // ---------- state ----------
  // Matches are name groups (index.json `groups`: [label, workIdx...]); a group is seen when all its works are.
  const scanned = new WeakMap(); // block -> { text, works: groupIdx[] }   (text-match cache)
  const imgHits = new WeakMap(); // block -> Set<bundled groupIdx> from CLIP; UNKNOWN = media image with no confident title
  // CLIP verdicts name groups of the bundled index; an updated index (opt-in catalog update) maps them via fromBundled.
  // shortcut: works added by a catalog update have no CLIP title rows (the text tower is not shipped), so their images
  // only get the generic "may contain a spoiler" verdict; ship rows for them if visual titles matter.
  const fromClip = (g) => (g === UNKNOWN || !meta.fromBundled ? g : meta.fromBundled[g] >= 0 ? meta.fromBundled[g] : UNKNOWN);
  const UNKNOWN = -1;
  const ocrText = new WeakMap(); // block -> string
  const shown = new WeakSet(); // "Show once"
  const blocked = new Map(); // block -> overlay host
  const verdicts = new Map(); // text -> true (spoiler) | false, "spoiler" mode classifier cache
  const classifying = new Set();
  const pending = new Set(); // blocks waiting for a scan

  const isSeen = (g) => meta.groups[g].every((w, i) => i === 0 || seenIdx.has(w));

  function scanBlock(block, force) {
    if (!block || !active || shown.has(block) || !block.isConnected) return;
    const text = blockText(block);
    const prev = scanned.get(block);
    if (!force && prev && prev.text === text) return;
    scanned.set(block, { text, works: matcher.evaluate(text, isSeen) });
    apply(block);
  }

  function apply(block) {
    if (!active || shown.has(block)) return unblock(block);
    const st = scanned.get(block);
    const img = [...(imgHits.get(block) ?? [])].map(fromClip).filter((w) => w === UNKNOWN || !isSeen(w));
    const textWorks = (st?.works ?? []).filter((w) => !isSeen(w));
    // the post's text names the work when it can; an unrecognised image only labels a block nothing else names
    let works = [...new Set([...textWorks.sort((a, b) => a - b), ...img.filter((w) => w !== UNKNOWN).sort((a, b) => a - b)])];
    if (!works.length && img.length) works = [UNKNOWN];
    // "spoiler" mode: text-only matches stay blocked (fail closed) until the classifier says "not a spoiler".
    // A purely visual match stays blocked: a still/frame from an unseen work is itself a potential spoiler.
    if (works.length && settings.mode === 'spoiler' && !img.length) {
      const v = verdicts.get(st.text);
      if (v === false) works = [];
      else if (v === undefined) classify(st.text, block);
    }
    if (works.length) showOverlay(block, works); else unblock(block);
  }

  function classify(text, block) {
    if (classifying.has(text)) return;
    classifying.add(text);
    setBusy(1);
    send({ type: 'text.classify', text: text.slice(0, 4000) })
      // fail closed: an engine error keeps the block
      .then((r) => verdicts.set(text, !r || r.error ? true : !!r.spoiler), () => verdicts.set(text, true))
      .finally(() => {
        setBusy(-1);
        classifying.delete(text);
        if (block.isConnected && scanned.get(block)?.text === text) apply(block);
      });
  }

  // ---------- overlay ----------
  const OVERLAY_CSS = `:host{all:initial;position:absolute;inset:0;z-index:2147483646;display:flex;align-items:center;justify-content:center;
    background:#111;color:#f2f2f2;border-radius:inherit;overflow:auto;font:14px/1.35 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
    .b{display:flex;flex-wrap:wrap;gap:8px;align-items:center;justify-content:center;padding:8px 12px;text-align:center}
    p{margin:0;width:100%}
    button{min-height:40px;min-width:44px;padding:6px 14px;border-radius:20px;border:1px solid #555;background:#262626;color:#f2f2f2;
    font:inherit;cursor:pointer;touch-action:manipulation}
    button:hover,button:focus-visible{background:#3a3a3a;outline:2px solid #8ab4f8;outline-offset:1px}`;

  function showOverlay(block, works) {
    const w = works[0], unknown = w === UNKNOWN, title = unknown ? '' : meta.groups[w][0];
    let ov = blocked.get(block);
    if (ov && ov.isConnected && ov.dataset.work === String(w)) return;
    if (!ov || !ov.isConnected) {
      ov = document.createElement('sb-overlay');
      const sr = ov.attachShadow({ mode: 'open' });
      sr.innerHTML = `<style>${OVERLAY_CSS}</style><div class="b" role="group"><p></p>` +
        `<button type="button" data-a="once">Show once</button><button type="button" data-a="seen"></button></div>`;
      for (const t of ['click', 'mousedown', 'mouseup', 'pointerdown', 'pointerup', 'touchstart', 'touchend', 'keydown']) {
        ov.addEventListener(t, (e) => { e.stopPropagation(); if (t === 'click') e.preventDefault(); });
      }
      sr.addEventListener('click', (e) => {
        const a = e.target.closest?.('button')?.dataset.a;
        if (a === 'once') { shown.add(block); unblock(block); }
        if (a === 'seen' && +ov.dataset.work !== UNKNOWN) markSeen(+ov.dataset.work);
      });
      if (getComputedStyle(block).position === 'static') block.setAttribute('data-sb-pos', '');
      block.setAttribute('data-sb-blocked', '');
      block.appendChild(ov);
      blocked.set(block, ov);
    }
    ov.dataset.work = String(w);
    const more = works.length > 1 ? ` (+${works.length - 1} more)` : '';
    const text = unknown ? 'May contain a spoiler (unrecognised film, show or game image)' : `Contains spoiler about ${title}${more}`;
    ov.shadowRoot.querySelector('p').textContent = text;
    const seenBtn = ov.shadowRoot.querySelector('[data-a="seen"]');
    seenBtn.hidden = unknown; // nothing to mark as seen when the work is not known
    seenBtn.textContent = unknown ? '' : `I've seen ${title}`;
    ov.setAttribute('aria-label', text);
  }

  function unblock(block) {
    const ov = blocked.get(block);
    if (!ov) return;
    ov.remove();
    block.removeAttribute('data-sb-blocked');
    block.removeAttribute('data-sb-pos');
    blocked.delete(block);
  }

  async function markSeen(w) { // every work carrying the name, in one storage write
    const { seen = {} } = await api.storage.local.get('seen');
    const ts = Date.now();
    for (const x of meta.groups[w].slice(1)) seen[meta.ids[x]] = { title: meta.titles[x], type: meta.types[x], year: meta.years[x] || null, ts };
    await api.storage.local.set({ seen }); // storage.onChanged re-evaluates every tab, including this one
  }

  // ---------- DOM walking ----------
  function collect(node) {
    if (node.nodeType === 3) { const p = node.parentElement; if (p && !SKIP_TEXT.has(p.tagName) && node.data.trim()) pending.add(p); return; }
    if (node.nodeType !== 1 || SKIP_TEXT.has(node.tagName)) return;
    if (node.tagName === 'IMG' || node.tagName === 'VIDEO') registerMedia(node);
    else if (node.firstElementChild) node.querySelectorAll('img, video').forEach(registerMedia);
    const tw = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
    for (let t; (t = tw.nextNode());) {
      const p = t.parentElement;
      if (p && !SKIP_TEXT.has(p.tagName) && t.data.trim()) pending.add(p);
    }
    if (node.hasAttribute('alt') || node.hasAttribute('aria-label')) pending.add(node);
  }

  function flush(force) {
    if (!active || !pending.size) return;
    const blocks = new Set();
    for (const el of pending) {
      if (!el.isConnected || el.closest('sb-overlay, head')) continue;
      const b = findBlock(el);
      if (b) blocks.add(b);
    }
    pending.clear();
    for (const b of blocks) scanBlock(b, force);
  }

  const mo = new MutationObserver((recs) => {
    for (const r of recs) {
      if (r.type === 'childList') r.addedNodes.forEach(collect);
      else if (r.type === 'characterData') collect(r.target);
      else if (r.type === 'attributes') {
        const el = r.target;
        if (el.tagName === 'IMG' || el.tagName === 'VIDEO') { if (r.attributeName !== 'alt') resetMedia(el); }
        if (r.attributeName === 'alt') pending.add(el);
      }
    }
    if (matcher) flush();
  });
  mo.observe(document, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['src', 'srcset', 'poster', 'alt'] });

  // ---------- media ----------
  const media = new WeakMap(); // el -> { src, busy }
  const io = new IntersectionObserver((entries) => {
    for (const e of entries) if (e.isIntersecting) { io.unobserve(e.target); checkMedia(e.target); }
  }, { rootMargin: '100% 0px' });
  const ok = (el) => el.setAttribute('data-sb-ok', '');
  const mediaOn = () => active && settings.scanImages;

  function registerMedia(el) {
    if (!mediaOn() || el.hasAttribute('data-sb-ok') || media.has(el)) return;
    const w = +el.getAttribute('width'), h = +el.getAttribute('height');
    if (w && h && Math.min(w, h) < MIN_MEDIA) return ok(el);
    media.set(el, { src: null });
    io.observe(el);
  }
  function resetMedia(el) {
    if (!mediaOn()) return;
    const src = mediaSrc(el);
    if (media.get(el)?.src === src) return;
    el.removeAttribute('data-sb-ok');
    media.delete(el);
    registerMedia(el);
  }
  const mediaSrc = (el) => (el.tagName === 'VIDEO' ? el.currentSrc || el.src || el.poster : el.currentSrc || el.src);

  function loaded(img) {
    if (img.complete) return Promise.resolve();
    return new Promise((r) => { img.addEventListener('load', r, { once: true }); img.addEventListener('error', r, { once: true }); });
  }

  // Readable pixels (same-origin / CORS / blob:) are sent as a data: URL so the background does not refetch;
  // tainted cross-origin images are sent by URL and fetched by the background (host permission, no CORS).
  function snapshot(src, w, h, maxSide = 768) {
    const s = Math.min(1, maxSide / Math.max(w, h));
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(w * s)); c.height = Math.max(1, Math.round(h * s));
    try {
      c.getContext('2d').drawImage(src, 0, 0, c.width, c.height);
      return c.toDataURL('image/jpeg', 0.85);
    } catch { return null; } // SecurityError: tainted canvas
  }

  async function checkMedia(el) {
    const st = media.get(el);
    if (!st || !mediaOn()) return;
    if (el.tagName === 'VIDEO') return checkVideo(el, st);
    await loaded(el);
    const src = el.currentSrc || el.src;
    st.src = src;
    const nw = el.naturalWidth, nh = el.naturalHeight;
    if (!nw || Math.min(nw, nh) < MIN_MEDIA || (el.clientWidth && Math.min(el.clientWidth, el.clientHeight) < MIN_MEDIA)) return ok(el);
    if (!/^(https?|data|blob):/.test(src)) return ok(el);
    const url = /^https?:/.test(src) && !sameOriginish(src) ? src : snapshot(el, nw, nh) ?? src;
    await verdictFor(el, src, url);
    if (media.get(el) === st && st.src === src) ok(el);
  }
  const sameOriginish = (src) => { try { return new URL(src).origin === location.origin; } catch { return false; } };

  // An image stays pending (blacked out) until BOTH its CLIP and its OCR verdict are in; the background runs
  // in-viewport images first (prio 0). OCR that fails or times out reveals the image and is counted in stats.
  const OCR_TIMEOUT_MS = 60000; // safety net for a lost message; the engine itself gives up on a recognition after 10 s
  const stats = { ocrTimeout: 0, ocrError: 0, clipError: 0 };
  let busy = 0; // media verdicts + text classifications in flight; data-sb-busy="0" = all verdicts in
  const setBusy = (d) => { busy += d; root.setAttribute('data-sb-busy', String(busy)); root.setAttribute('data-sb-stats', JSON.stringify(stats)); };
  const inView = (el) => { const r = el.getBoundingClientRect(); return r.bottom > 0 && r.top < innerHeight; };
  const clipCache = new Map(); // key -> Promise<hits>
  const ocrCache = new Map(); // key -> Promise<text>
  function clipFor(key, url, prio) {
    if (!clipCache.has(key)) {
      clipCache.set(key, send({ type: 'img.check', key, url, prio }).then((r) => {
        if (r?.error || !r) stats.clipError++;
        return r?.hits ?? [];
      }, () => { stats.clipError++; return []; }));
    }
    return clipCache.get(key);
  }
  function ocrFor(key, url, prio) {
    if (!ocrCache.has(key)) {
      let timer;
      ocrCache.set(key, Promise.race([
        send({ type: 'img.ocr', key, url, prio }).then((r) => {
          if (r?.error === 'ocr timeout') { stats.ocrTimeout++; return ''; }
          if (r?.error || !r) { stats.ocrError++; return ''; }
          return r.text ?? '';
        }, () => { stats.ocrError++; return ''; }),
        new Promise((res) => { timer = setTimeout(() => { stats.ocrTimeout++; res(''); }, OCR_TIMEOUT_MS); }),
      ]).finally(() => clearTimeout(timer)));
    }
    return ocrCache.get(key);
  }
  async function verdictFor(el, key, url, ocr = true) {
    const prio = inView(el) ? 0 : 1;
    setBusy(1);
    try {
      const [hits, text] = await Promise.all([clipFor(key, url, prio), ocr ? ocrFor(key, url, prio) : '']);
      const block = findMediaBlock(el);
      if (!block || !block.isConnected) return;
      const hit = hits.find(([w]) => { const g = fromClip(w); return g === UNKNOWN || !isSeen(g); }); // raw (bundled) group kept
      if (hit) {
        let s = imgHits.get(block);
        if (!s) imgHits.set(block, s = new Set());
        s.add(hit[0]);
      }
      if (text) {
        ocrText.set(block, ((ocrText.get(block) ?? '') + '\n' + text).slice(-4000));
        scanBlock(block, true);
      }
      if (hit) apply(block);
    } finally { setBusy(-1); }
  }

  async function checkVideo(v, st) {
    st.src = mediaSrc(v);
    if (v.poster) {
      const p = v.poster;
      await verdictFor(v, p, p);
    }
    const frame = async () => {
      if (v.readyState < 2 || !mediaOn()) return;
      const url = snapshot(v, v.videoWidth, v.videoHeight, 448);
      if (url) await verdictFor(v, `${st.src}#t=${Math.round(v.currentTime)}`, url, false);
    };
    if (!st.timer) {
      st.timer = true;
      let last = performance.now();
      v.addEventListener('timeupdate', () => {
        const now = performance.now();
        if (now - last < FRAME_EVERY_MS) return;
        last = now;
        const before = blocked.has(findMediaBlock(v));
        frame().then(() => { if (!before && blocked.has(findMediaBlock(v))) v.pause(); });
      });
    }
    // Fail closed: a video stays a placeholder until its first frame has a verdict (it loads on play at the latest).
    if (v.readyState < 2) await new Promise((r) => v.addEventListener('loadeddata', r, { once: true }));
    await frame(); // tainted (cross-origin, no CORS) videos cannot be sampled: poster + surrounding text only
    ok(v);
  }

  // ---------- messaging / settings ----------
  function send(msg) { return api.runtime.sendMessage(msg); }

  api.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type === 'sb.stats') {
      let n = 0;
      for (const b of blocked.keys()) if (b.isConnected) n++;
      sendResponse({ blocked: n });
    }
  });

  function computeActive() {
    const paused = (settings.pausedSites ?? []).some((s) => location.hostname === s || location.hostname.endsWith('.' + s));
    return settings.enabled !== false && !paused;
  }

  function rescanAll() {
    for (const b of [...blocked.keys()]) unblock(b);
    if (!active) return;
    collect(document.body ?? root);
    flush(true);
    // re-apply image verdicts for blocks that have no text match
    document.querySelectorAll('img[data-sb-ok], video[data-sb-ok]').forEach((el) => {
      const b = findMediaBlock(el);
      if (b && imgHits.has(b)) { if (!scanned.has(b)) scanned.set(b, { text: blockText(b), works: [] }); apply(b); }
    });
  }

  function applySettings() {
    active = computeActive();
    root.toggleAttribute('data-sb-off', !active);
    root.toggleAttribute('data-sb-noimg', !settings.scanImages);
    seenIdx = new Set();
    if (meta) meta.ids.forEach((id, i) => { if (seenIds[id]) seenIdx.add(i); });
  }

  api.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !meta) return;
    if (changes.catalogIndex) { // a catalog update finished: swap the index in this (already open) tab
      useIndex(changes.catalogIndex.newValue).then(() => { applySettings(); rescanAll(); });
      return;
    }
    if (!changes.seen && !changes.settings) return;
    if (changes.seen) seenIds = changes.seen.newValue ?? {};
    if (changes.settings) settings = { ...DEFAULTS, ...changes.settings.newValue };
    applySettings();
    rescanAll();
  });

  const t0 = performance.now();
  const getURL = (p) => api.runtime.getURL(p);
  // The index: the one rebuilt by an opt-in catalog update (storage.local catalogIndex) when it was built against this
  // bundle, else the bundled one.
  async function loadIndex(stored) {
    if (stored) {
      const info = await fetch(getURL('data/catalog-info.json')).then((r) => r.json()).catch(() => null);
      if (info && stored.bundle === info.builtAt) {
        const b = atob(stored.bin), u = new Uint8Array(b.length);
        for (let i = 0; i < b.length; i++) u[i] = b.charCodeAt(i);
        return [u.buffer, stored.meta];
      }
    }
    return Promise.all([fetch(getURL('data/index.bin')).then((r) => r.arrayBuffer()), fetch(getURL('data/index.json')).then((r) => r.json())]);
  }
  async function useIndex(stored) {
    const [bin, m] = await loadIndex(stored);
    matcher = new globalThis.SBMatcher.Matcher(bin, m);
    meta = m;
  }

  async function init() {
    const store = await api.storage.local.get(['seen', 'settings', 'catalogIndex']);
    await useIndex(store.catalogIndex);
    seenIds = store.seen ?? {};
    settings = { ...DEFAULTS, ...store.settings };
    applySettings();
    if (active) {
      if (document.body) collect(document.body);
      flush();
    }
    clearTimeout(failSafe);
    root.setAttribute('data-sb-ready', String(Math.round(performance.now() - t0))); // init time in ms, read by the e2e test
    setBusy(0);
  }
  init().catch((e) => { console.error('[SpolierBlocker]', e); clearTimeout(failSafe); root.setAttribute('data-sb-ready', ''); });
})();
