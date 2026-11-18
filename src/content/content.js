// SpolierBlock content script (document_start, every frame). Matches catalog works in text synchronously from a
// MutationObserver (runs before paint), sends media to the background for CLIP/OCR verdicts, and covers the
// containing "post-like" block. Config and decision rule: docs/agents/contract.md.
//
// Layout rule: the page may have measured anything we touch (virtualised feeds position posts by measured height), so
// the blocker never changes the size of a box: covers are absolutely positioned inside their block, content is hidden
// with visibility, pending media with a filter. A cover is recomputed from what its block shows now (text and the
// verdicts of the pictures it shows now), so a recycled node never keeps a cover meant for its previous post.
(() => {
  'use strict';
  const api = globalThis.browser ?? globalThis.chrome;
  const root = document.documentElement;
  if (!root || window.__sbLoaded) return;
  window.__sbLoaded = true;

  // shortcut: CSS backgrounds are scanned only when set inline on an element without element children (X, React Native
  // Web photos); stylesheet backgrounds and hero sections with content are not, add when a target site shows spoilers there.
  // shortcut: loose text directly inside a very large container is not covered (would black out the page); needs
  // text-range covers to fix.
  const MIN_MEDIA = 96; // px; smaller images are icons/avatars and are never scanned
  const MAX_BLOCK_TEXT = 3000; // a "post-like" container larger than this is a page section, not a post
  const FRAME_EVERY_MS = 5000; // video re-check period during playback
  const DEFAULTS = { enabled: true, scanImages: true, blockUnlisted: true, style: 'all', unknownImages: false, pausedSites: [], catalogUpdate: 'off' };

  let matcher = null, meta = null;
  let settings = DEFAULTS, works = {}, workState = new Map(); // workIdx -> works entry
  let active = false;

  // Fail-safe: never leave a page invisible if something below throws or the index fails to load.
  const failSafe = setTimeout(() => root.setAttribute('data-sb-ready', ''), 2500);

  // about:blank / srcdoc frames have no host of their own; they belong to their parent's site
  const hostname = location.hostname || (() => { try { return parent.location.hostname; } catch { return ''; } })();
  const host = hostname.replace(/^www\.|^mobile\.|^m\./, '');
  const X = 'article, [data-testid="UserCell"], [data-testid="trend"], [data-testid="messageEntry"], [data-testid="conversation"], ' +
    '[data-testid="typeaheadResult"], [data-testid="HoverCard"]';
  const SITE_BLOCKS = {
    'twitter.com': X,
    'x.com': X,
    'youtube.com': 'ytd-rich-item-renderer, ytd-video-renderer, ytd-compact-video-renderer, ytd-grid-video-renderer, ' +
      'ytd-playlist-video-renderer, ytd-playlist-panel-video-renderer, ytd-reel-item-renderer, ytd-comment-thread-renderer, ' +
      'ytd-watch-metadata, yt-lockup-view-model, ytm-shorts-lockup-view-model, ytm-video-with-context-renderer, ytm-comment-thread-renderer, ' +
      'ytd-notification-renderer, ytd-post-renderer, yt-live-chat-text-message-renderer, yt-live-chat-paid-message-renderer, ' +
      'yt-live-chat-membership-item-renderer',
    'reddit.com': 'shreddit-post, shreddit-comment, [data-testid="post-container"], .thing, article',
  };
  const siteSel = SITE_BLOCKS[host] ?? null;
  // role=row/listitem/option: chat messages, notification and conversation lists, search suggestions
  const GENERIC = 'article, [role="article"], li, figure, blockquote, [role="row"], [role="listitem"], [role="option"], ' +
    '[class*="card" i], [class*="post" i], [class*="tweet" i], [class*="comment" i], [class*="message" i], [class*="item" i], [class*="entry" i]';
  const LEAFY = new Set(['P', 'LI', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'BLOCKQUOTE', 'TD', 'TH', 'DD', 'DT', 'FIGCAPTION', 'PRE', 'DIV', 'SECTION']);
  const SKIP_TEXT = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEXTAREA', 'TEMPLATE', 'SB-OVERLAY', 'TITLE', 'HEAD']);

  // ---------- shadow DOM ----------
  // Open and closed roots: Firefox exposes openOrClosedShadowRoot to content scripts, Chrome has dom.openOrClosedShadowRoot.
  const closedRoot = api.dom?.openOrClosedShadowRoot?.bind(api.dom);
  const shadowOf = (e) => e.openOrClosedShadowRoot ?? e.shadowRoot ?? (closedRoot && e.localName.includes('-') ? closedRoot(e) : null);
  const up = (e) => e.parentElement ?? e.parentNode?.host ?? null; // crosses shadow boundaries
  const roots = new WeakSet();
  let anyRoot = false; // most pages have no shadow roots: skip the per-block host lookups
  const ROOT_CSS = '[data-sb-blocked]>:not(sb-overlay),:host([data-sb-blocked])>:not(sb-overlay){visibility:hidden!important}' +
    '[data-sb-blocked][data-sb-pos]{position:relative!important}';
  function adopt(hostEl, sr) {
    if (roots.has(sr)) return;
    roots.add(sr);
    anyRoot = true;
    hostEl.setAttribute('data-sb-host', '');
    // content.css does not reach into shadow trees.
    // shortcut: pending media inside shadow roots is not darkened before its verdict (covered after it), add the
    // filter rule here if a target site puts media in shadow DOM.
    const st = document.createElement('style');
    st.textContent = ROOT_CSS;
    sr.appendChild(st);
    mo.observe(sr, OBSERVE);
  }
  // Custom elements seen before they are defined get their shadow root on upgrade, which no mutation reports.
  const later = new Map(); // element -> give-up time
  let laterTimer = 0;
  function retryLater() {
    laterTimer = 0;
    const now = Date.now();
    for (const [el, until] of later) {
      const sr = el.isConnected ? shadowOf(el) : null;
      if (sr) { later.delete(el); adopt(el, sr); collect(sr); } else if (!el.isConnected || now > until) later.delete(el);
    }
    if (matcher) flush();
    if (later.size) laterTimer = setTimeout(retryLater, 1000);
  }

  // ---------- block discovery ----------
  function findBlock(el, maxLeaf = MAX_BLOCK_TEXT * 3) {
    let leaf = null;
    for (let e = el; e && e !== document.body && e !== root; e = up(e)) {
      if (siteSel && e.matches(siteSel)) return e;
      if (e.matches(GENERIC) && e.textContent.length <= MAX_BLOCK_TEXT) return e;
      if (!leaf && LEAFY.has(e.tagName)) leaf = e;
    }
    const b = leaf ?? (el === document.body ? null : el);
    return b && b !== root && b !== document.body && b.textContent.length <= maxLeaf ? b : null;
  }
  // The post around a picture; only a picture outside any post gets its own box covered.
  const findMediaBlock = (el) => { const p = up(el); return p && (findBlock(p, MAX_BLOCK_TEXT) ?? p); };
  const hostsIn = (node) => {
    if (!anyRoot) return [];
    const hs = [...node.querySelectorAll('[data-sb-host]')];
    if (node.nodeType === 1 && node.hasAttribute('data-sb-host')) hs.push(node);
    return hs;
  };

  function domText(node) {
    // text nodes joined with newlines: textContent would glue "<div>@late</div><p>Snape…" into "@lateSnape"
    let t = '';
    const tw = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
    for (let n; (n = tw.nextNode());) if (!SKIP_TEXT.has(n.parentElement?.tagName)) t += n.data + '\n';
    for (const e of node.querySelectorAll('img[alt], [aria-label], [title]')) {
      t += '\n' + (e.getAttribute('alt') || '') + '\n' + (e.getAttribute('aria-label') || '') + '\n' + (e.getAttribute('title') || '');
    }
    for (const h of hostsIn(node)) { const sr = shadowOf(h); if (sr) t += domText(sr); }
    return t;
  }

  // ---------- state ----------
  // Matches are name groups (index.json `groups`: [label, workIdx...]).
  const UNKNOWN = -1;
  // CLIP verdicts name groups of the bundled index; an updated index (opt-in catalog update) maps them via fromBundled.
  // shortcut: works added by a catalog update have no CLIP title rows (the text tower is not shipped), so their images
  // only get the generic verdict; ship rows for them if visual titles matter.
  const fromClip = (g) => (g === UNKNOWN || !meta.fromBundled ? g : meta.fromBundled[g] >= 0 ? meta.fromBundled[g] : UNKNOWN);
  const scanned = new WeakMap(); // block -> { dom, text, key, hits, groups }
  const verdict = new WeakMap(); // media element -> { src, hits: raw groups, ocr } for the picture it showed when judged
  let haveVerdicts = false;
  const shown = new WeakMap(); // block -> its text when "Show once" was pressed (a recycled node shows other text)
  const blocked = new Map(); // block -> overlay host
  const verdicts = new Map(); // text -> true (spoiler) | false, classifier cache
  const waiting = new Map(); // text -> callbacks for a classification in flight
  const pending = new Set(); // elements whose block needs a scan

  function groupState(g) {
    const ws = meta.groups[g];
    let seen = true;
    for (let i = 1; i < ws.length; i++) {
      const s = workState.get(ws[i])?.state;
      if (s === 'blocked') return 'blocked';
      if (s !== 'seen') seen = false;
    }
    return seen ? 'seen' : 'unlisted';
  }
  const isSeenGroup = (g) => groupState(g) === 'seen';
  const covers = (g) => { const s = groupState(g); return s === 'blocked' || (s === 'unlisted' && settings.blockUnlisted !== false); };
  function groupStyle(g) {
    const ws = meta.groups[g];
    for (let i = 1; i < ws.length; i++) {
      const e = workState.get(ws[i]);
      if (e?.state !== 'seen' && (e?.style ?? settings.style) === 'all') return 'all';
    }
    return 'spoilers';
  }
  const names = (gs) => meta.groups[gs[0]][0] + (gs.length > 1 ? ` and ${gs.length - 1} more` : '');

  // The decision rule of docs/agents/contract.md. Returns null or { label, marks } (marks: groups "I've seen it" marks).
  function decide(st, onVerdict) {
    const tg = st.groups.filter(covers);
    const img = st.hits.map(fromClip).filter((g) => g !== UNKNOWN && covers(g));
    const marks = [...new Set([...tg, ...img])];
    const all = tg.filter((g) => groupStyle(g) === 'all');
    if (all.length) return { label: `Mentions ${names(all)}`, marks };
    let v; // style "spoilers": covered while the classifier runs (fail closed), kept only if it says spoiler
    if (tg.length && (v = verdicts.get(st.text)) === undefined) classify(st.text, onVerdict);
    if (v === true) return { label: `Spoiler about ${names(tg)}`, marks };
    if (img.length) return { label: `Image from ${names(img)}`, marks };
    if (tg.length && v === undefined) return { label: `Checking ${names(tg)} for spoilers…`, marks };
    if (settings.unknownImages && st.hits.some((h) => fromClip(h) === UNKNOWN) &&
        (tg.length || !matcher.evaluate(st.text).some(isSeenGroup))) return { label: 'Possible film, show or game image', marks: [] };
    return null;
  }

  function mediaInfo(block) {
    let ocr = '';
    const hits = new Set();
    if (!haveVerdicts) return { ocr, hits: [] };
    const visit = (n) => {
      for (const m of n.querySelectorAll('img, video, [data-sb-bg]')) {
        const v = verdict.get(m);
        if (v && v.src === mediaSrc(m) && findMediaBlock(m) === block) { ocr += v.ocr; v.hits.forEach((g) => hits.add(g)); }
      }
    };
    visit(block);
    for (const h of hostsIn(block)) { const sr = shadowOf(h); if (sr) visit(sr); }
    return { ocr, hits: [...hits] };
  }

  function scanBlock(block, force) {
    if (!block || !active || !block.isConnected) return;
    const dom = domText(block), mi = mediaInfo(block);
    const text = mi.ocr ? dom + '\n' + mi.ocr : dom;
    const key = text + '\0' + mi.hits.join();
    if (!force && scanned.get(block)?.key === key) return;
    scanned.set(block, { dom, text, key, hits: mi.hits, groups: matcher.evaluate(text, isSeenGroup) });
    apply(block);
  }

  function apply(block) {
    const st = scanned.get(block);
    if (!active || !st || shown.get(block) === st.dom) return unblock(block);
    const d = decide(st, () => { if (block.isConnected && scanned.get(block)?.text === st.text) apply(block); });
    if (d) showOverlay(block, d); else unblock(block);
  }

  function classify(text, cb) {
    if (waiting.has(text)) return void waiting.get(text).add(cb);
    waiting.set(text, new Set([cb]));
    setBusy(1);
    send({ type: 'text.classify', text: text.slice(0, 4000) })
      // fail closed: an engine error keeps the cover
      .then((r) => verdicts.set(text, !r || r.error ? true : !!r.spoiler), () => verdicts.set(text, true))
      .finally(() => {
        setBusy(-1);
        const cbs = waiting.get(text);
        waiting.delete(text);
        cbs.forEach((f) => f());
      });
  }

  // ---------- cover ----------
  // Every rule is !important on :host so page CSS can never put the cover in flow; size containment keeps it to its block.
  const OVERLAY_CSS = `:host{all:initial!important;position:absolute!important;inset:0!important;z-index:2147483646!important;
    display:block!important;box-sizing:border-box!important;overflow:hidden!important;
    container-type:size;border-radius:inherit;--bg:#eef1f4;--fg:#1f2328;--line:#b9c0c8;--ring:#0b57d0;
    background:var(--bg);color:var(--fg);font:13px/1.35 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
    :host([data-dark]){--bg:#22272e;--fg:#e6e8eb;--line:#59616b;--ring:#8ab4f8}
    .b{box-sizing:border-box;height:100%;display:flex;flex-wrap:wrap;align-content:center;align-items:center;
      justify-content:center;gap:6px 8px;padding:6px 10px;text-align:center}
    p{margin:0;flex:0 0 100%;overflow-wrap:anywhere}
    button{font:inherit;color:inherit;background:transparent;border:1px solid var(--line);border-radius:999px;
      min-height:28px;padding:0 12px;cursor:pointer;white-space:nowrap;touch-action:manipulation}
    button:hover{background:color-mix(in srgb,currentColor 10%,transparent)}
    button:focus-visible{outline:2px solid var(--ring);outline-offset:1px}
    [data-a=menu]{border-color:transparent;min-width:28px;padding:0 6px;font-size:16px;line-height:1}
    @container (max-height:76px){.b{flex-wrap:nowrap;justify-content:flex-start;padding:2px 8px}
      p{flex:1 1 auto;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;text-align:start}}
    @container (max-height:34px){button{min-height:22px;padding:0 8px}.b{gap:4px}}`;

  function isDark(el) {
    for (let e = el; e; e = up(e)) {
      const m = getComputedStyle(e).backgroundColor.match(/[\d.]+/g);
      if (m && (m[3] === undefined || +m[3] > 0.5)) return 0.2126 * m[0] + 0.7152 * m[1] + 0.0722 * m[2] < 128;
    }
    return getComputedStyle(root).colorScheme.includes('dark') && matchMedia('(prefers-color-scheme: dark)').matches;
  }

  function showOverlay(block, d) {
    let ov = blocked.get(block);
    if (!ov || !ov.isConnected) {
      ov?.remove();
      ov = document.createElement('sb-overlay');
      const sr = ov.attachShadow({ mode: 'open' });
      sr.innerHTML = `<style>${OVERLAY_CSS}</style><div class="b" role="group" aria-labelledby="l"><p id="l"></p>` +
        `<button type="button" data-a="once">Show once</button><button type="button" data-a="seen">I've seen it</button>` +
        `<button type="button" data-a="menu" aria-label="SpolierBlock settings" title="SpolierBlock settings">⋮</button></div>`;
      for (const t of ['click', 'mousedown', 'mouseup', 'pointerdown', 'pointerup', 'touchstart', 'touchend', 'keydown']) {
        ov.addEventListener(t, (e) => { e.stopPropagation(); if (t === 'click') e.preventDefault(); });
      }
      sr.addEventListener('click', (e) => {
        const a = e.target.closest?.('button')?.dataset.a;
        if (a === 'once') { const st = scanned.get(block); if (st) shown.set(block, st.dom); unblock(block); }
        if (a === 'seen') markSeen(ov.marks);
        if (a === 'menu') send({ type: 'ui.openSettings' }).catch(() => {});
      });
      block.toggleAttribute('data-sb-pos', getComputedStyle(block).position === 'static');
      ov.toggleAttribute('data-dark', isDark(block));
      block.setAttribute('data-sb-blocked', '');
      (shadowOf(block) ?? block).appendChild(ov); // a shadow host does not render unslotted light children
      blocked.set(block, ov);
    }
    ov.marks = d.marks;
    const p = ov.shadowRoot.querySelector('p');
    if (p.textContent !== d.label) p.textContent = d.label;
    ov.shadowRoot.querySelector('[data-a="seen"]').hidden = !d.marks.length; // nothing to mark for an unidentified image
  }

  function unblock(block) {
    const ov = blocked.get(block);
    if (!ov) return;
    ov.remove();
    block.removeAttribute('data-sb-blocked');
    block.removeAttribute('data-sb-pos');
    blocked.delete(block);
  }

  const migrateSeen = (seen) => Object.fromEntries(Object.entries(seen ?? {}).map(([id, e]) => [id, { ...e, state: 'seen', style: null }]));
  async function markSeen(groups) { // every work of the groups, in one storage write
    const st = await api.storage.local.get(['works', 'seen']);
    const w = st.works ?? migrateSeen(st.seen);
    const ts = Date.now();
    for (const g of groups) {
      for (const x of meta.groups[g].slice(1)) {
        const id = meta.ids[x];
        w[id] = { ...w[id], state: 'seen', style: w[id]?.style ?? null, title: meta.titles[x], type: meta.types[x], year: meta.years[x] || null, ts };
      }
    }
    await api.storage.local.set({ works: w }); // storage.onChanged re-evaluates every tab, including this one
  }

  // ---------- document.title ----------
  // The tab title cannot be covered; while it names a covered work it is replaced by the cover's text.
  let titleOrig = null, titleSet = null, titleDirty = false;
  function scanTitle(force) {
    if (window !== top || !matcher) return;
    const cur = document.title;
    if (!force && (cur === titleSet || (titleSet === null && cur === titleOrig))) return; // our own write, or unchanged
    if (cur !== titleSet) titleOrig = cur;
    const groups = active && titleOrig ? matcher.evaluate(titleOrig, isSeenGroup) : [];
    const d = groups.length ? decide({ text: titleOrig, hits: [], groups }, () => scanTitle(true)) : null;
    const want = d?.label ?? titleOrig;
    titleSet = d ? want : null;
    if (cur !== want) document.title = want;
  }

  // ---------- DOM walking ----------
  const MEDIA_SEL = 'img, video, [style*="url("]';
  function addText(t) {
    const p = t.parentElement ?? t.parentNode?.host;
    if (p && !SKIP_TEXT.has(t.parentElement?.tagName) && t.data.trim()) pending.add(t.parentElement ?? p);
  }
  function collect(node) {
    if (node.nodeType === 3) return addText(node);
    if (node.nodeType === 1 ? SKIP_TEXT.has(node.tagName) : node.nodeType !== 11) return;
    if (mediaOn()) {
      if (node.nodeType === 1 && node.matches(MEDIA_SEL)) registerMedia(node);
      if (node.firstElementChild) node.querySelectorAll(MEDIA_SEL).forEach(registerMedia);
    }
    const tw = document.createTreeWalker(node, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
    for (let n = node; n; n = tw.nextNode()) {
      if (n.nodeType === 3) { addText(n); continue; }
      if (n.nodeType !== 1 || n.localName === 'sb-overlay') continue;
      const sr = shadowOf(n);
      if (sr) { adopt(n, sr); collect(sr); } else if (n.localName.includes('-') && !later.has(n) && n.matches(':not(:defined)')) {
        later.set(n, Date.now() + 30000);
        if (!laterTimer) laterTimer = setTimeout(retryLater, 500);
      }
    }
    if (node.nodeType === 1 && (node.hasAttribute('alt') || node.hasAttribute('aria-label'))) pending.add(node);
  }

  function flush(force) {
    if (titleDirty) { titleDirty = false; scanTitle(); }
    if (!active || !pending.size) return;
    const blocks = new Set();
    for (const el of pending) {
      if (!el.isConnected || el.closest('head')) continue;
      const b = findBlock(el);
      if (b) blocks.add(b);
    }
    pending.clear();
    for (const b of blocks) scanBlock(b, force);
  }

  const OBSERVE = { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ['src', 'srcset', 'poster', 'alt', 'style'] };
  const mo = new MutationObserver((recs) => {
    for (const r of recs) {
      const t = r.target;
      if (r.type === 'childList') {
        r.addedNodes.forEach(collect);
        if (t.nodeName === 'TITLE' || t.nodeName === 'HEAD') titleDirty = true;
      } else if (r.type === 'characterData') {
        collect(t);
        if (t.parentNode?.nodeName === 'TITLE') titleDirty = true;
      } else if (r.attributeName === 'alt') pending.add(t);
      else if (r.attributeName === 'style') { if (t.hasAttribute('data-sb-bg') || (!t.firstElementChild && t.getAttribute('style')?.includes('url('))) resetMedia(t); }
      else if (t.tagName === 'IMG' || t.tagName === 'VIDEO') resetMedia(t);
    }
    if (matcher) flush();
  });
  mo.observe(document, OBSERVE);

  // ---------- media ----------
  const media = new WeakMap(); // el -> { src } of the current check
  const io = new IntersectionObserver((entries) => {
    for (const e of entries) if (e.isIntersecting) { io.unobserve(e.target); checkMedia(e.target); }
  }, { rootMargin: '100% 0px' });
  const ok = (el) => el.setAttribute('data-sb-ok', '');
  const mediaOn = () => active && settings.scanImages;
  const bgUrl = (el) => {
    const u = /url\(\s*(['"]?)(.*?)\1\s*\)/.exec(el.style.backgroundImage)?.[2];
    try { return u ? new URL(u, document.baseURI).href : ''; } catch { return ''; }
  };
  const mediaSrc = (el) => (el.tagName === 'VIDEO' ? el.currentSrc || el.src || el.poster : el.tagName === 'IMG' ? el.currentSrc || el.src : bgUrl(el));

  function registerMedia(el) {
    if (!mediaOn() || el.hasAttribute('data-sb-ok') || media.has(el)) return;
    if (el.tagName !== 'IMG' && el.tagName !== 'VIDEO') {
      if (el.firstElementChild || !bgUrl(el)) return;
      el.setAttribute('data-sb-bg', '');
    }
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
    // the element shows another picture now: a cover based on the old one must go
    if (verdict.delete(el) && matcher) scanBlock(findMediaBlock(el));
  }

  function loaded(img) {
    if (img.complete) return Promise.resolve();
    return new Promise((r) => { img.addEventListener('load', r, { once: true }); img.addEventListener('error', r, { once: true }); });
  }

  // Readable pixels (same-origin / CORS / blob:) are sent as a data: URL so the background does not refetch;
  // tainted cross-origin images and CSS backgrounds are sent by URL and fetched by the background (host permission, no CORS).
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
    if (el.tagName !== 'IMG') { // inline CSS background
      const src = st.src = bgUrl(el);
      if (!/^(https?|data):/.test(src) || Math.min(el.clientWidth, el.clientHeight) < MIN_MEDIA) return ok(el);
      await verdictFor(el, st, src, src);
      if (media.get(el) === st) ok(el);
      return;
    }
    await loaded(el);
    if (media.get(el) !== st) return;
    const src = el.currentSrc || el.src;
    st.src = src;
    const nw = el.naturalWidth, nh = el.naturalHeight;
    if (!nw || Math.min(nw, nh) < MIN_MEDIA || (el.clientWidth && Math.min(el.clientWidth, el.clientHeight) < MIN_MEDIA)) return ok(el);
    if (!/^(https?|data|blob):/.test(src)) return ok(el);
    const url = /^https?:/.test(src) && !sameOriginish(src) ? src : snapshot(el, nw, nh) ?? src;
    await verdictFor(el, st, src, url);
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
  async function verdictFor(el, st, key, url, ocr = true) {
    const prio = inView(el) ? 0 : 1;
    setBusy(1);
    try {
      const [hits, text] = await Promise.all([clipFor(key, url, prio), ocr ? ocrFor(key, url, prio) : '']);
      // A recycled element may show another picture by now: this verdict belongs to the picture it judged only.
      if (media.get(el) !== st || mediaSrc(el) !== st.src || (!hits.length && !text)) return;
      let v = verdict.get(el);
      if (v?.src !== st.src) verdict.set(el, v = { src: st.src, hits: [], ocr: '' });
      for (const [g] of hits) if (!v.hits.includes(g)) v.hits.push(g);
      if (text && !v.ocr.includes(text)) v.ocr = (v.ocr + '\n' + text).slice(-4000);
      haveVerdicts = true;
      scanBlock(findMediaBlock(el));
    } finally { setBusy(-1); }
  }

  async function checkVideo(v, st) {
    st.src = mediaSrc(v);
    if (v.poster) await verdictFor(v, st, v.poster, v.poster);
    const frame = async () => {
      if (v.readyState < 2 || !mediaOn() || media.get(v) !== st) return;
      const url = snapshot(v, v.videoWidth, v.videoHeight, 448);
      if (url) await verdictFor(v, st, `${st.src}#t=${Math.round(v.currentTime)}`, url, false);
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
    if (media.get(v) === st) ok(v);
  }

  // ---------- messaging / settings ----------
  function send(msg) { return api.runtime.sendMessage(msg); }

  api.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (msg?.type === 'sb.stats' && window === top) {
      let n = 0;
      for (const b of blocked.keys()) if (b.isConnected) n++;
      sendResponse({ blocked: n });
    }
  });

  function computeActive() {
    const paused = (settings.pausedSites ?? []).some((s) => hostname === s || hostname.endsWith('.' + s));
    return settings.enabled !== false && !paused;
  }

  function rescanAll() {
    for (const b of [...blocked.keys()]) unblock(b);
    scanTitle(true);
    if (!active) return;
    collect(document.body ?? root);
    flush(true);
    // blocks that only a picture names (no text to queue them)
    document.querySelectorAll('img[data-sb-ok], video[data-sb-ok], [data-sb-bg][data-sb-ok]').forEach((el) => {
      if (verdict.has(el)) scanBlock(findMediaBlock(el), true);
    });
  }

  // 0.1 stored `seen` and settings.mode; read them as 0.2 when the new keys are absent (the background migrates storage).
  function readConfig(s) {
    const raw = s.settings ?? {};
    settings = { ...DEFAULTS, ...raw, style: raw.style ?? (raw.mode === 'spoiler' ? 'spoilers' : 'all') };
    works = s.works ?? migrateSeen(s.seen);
  }

  function applySettings() {
    active = computeActive();
    root.toggleAttribute('data-sb-off', !active);
    root.toggleAttribute('data-sb-noimg', !settings.scanImages);
    workState = new Map();
    if (meta) meta.ids.forEach((id, i) => { if (works[id]) workState.set(i, works[id]); });
  }

  const CONFIG_KEYS = ['works', 'seen', 'settings'];
  api.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !meta) return;
    if (changes.catalogIndex) { // a catalog update finished: swap the index in this (already open) tab
      useIndex(changes.catalogIndex.newValue).then(() => { applySettings(); rescanAll(); });
      return;
    }
    if (!CONFIG_KEYS.some((k) => changes[k])) return;
    api.storage.local.get(CONFIG_KEYS).then((s) => { readConfig(s); applySettings(); rescanAll(); });
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
    const store = await api.storage.local.get([...CONFIG_KEYS, 'catalogIndex']);
    await useIndex(store.catalogIndex);
    readConfig(store);
    applySettings();
    if (active) {
      if (document.body) collect(document.body);
      flush();
    }
    scanTitle(true);
    clearTimeout(failSafe);
    root.setAttribute('data-sb-ready', String(Math.round(performance.now() - t0))); // init time in ms, read by the e2e test
    setBusy(0);
  }
  init().catch((e) => { console.error('[SpolierBlock]', e); clearTimeout(failSafe); root.setAttribute('data-sb-ready', ''); });
})();
