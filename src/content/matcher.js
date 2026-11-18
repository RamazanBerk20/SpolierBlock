// Text matcher shared by the content script, the background (OCR/search) and the build tool.
// Instead of an Aho-Corasick automaton (tens of MB of JS objects per tab for 50k works) catalog keys
// are stored as 64-bit hashes of normalized token n-grams in one flat Uint32Array that is loaded
// as-is: lookup cost is O(tokens * MAX_N) and per-tab memory is the size of the file.
(function () {
  'use strict';
  const MAX_N = 8; // keys longer than 8 tokens are dropped at build time
  // CHAR1 = single-token character name; PART = one token of a multi-token character name (corroboration only)
  const KIND = { TITLE: 0, ALIAS: 1, CHAR: 2, TAG: 3, CHAR1: 4, SERIES: 5, PART: 6 };
  const CONTEXT = new Set(('season seasons episode episodes ep eps movie movies film films trailer teaser ending endings ' +
    'finale spoiler spoilers series show sequel prequel remake reboot cast character characters scene scenes plot ' +
    'director chapter chapters volume book books novel manga anime game games dlc boss playthrough watched watching ' +
    'rewatch rewatching binge premiere cinema theater theatre netflix hbo disney pixar imdb streaming tv adaptation ' +
    'franchise saga trilogy episodic showrunner gameplay nintendo playstation xbox steam read reading').split(' '));
  const SXEX = /^s\d{1,2}e\d{1,3}$/;
  // shortcut: CJK/Thai text has no spaces, so whole runs become one token and titles inside them do not match; add per-script segmentation (Intl.Segmenter) for those locales.
  const WORD = /&|[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu;

  function normTok(s) {
    if (s === '&') return 'and';
    s = s.replace(/['’]/g, '').toLowerCase();
    // eslint-disable-next-line no-control-regex
    return /[^\x00-\x7f]/.test(s) ? s.normalize('NFKD').replace(/\p{M}/gu, '') : s;
  }

  // -> { toks: string[], starts: number[], ends: number[] } (char offsets into text)
  function tokenize(text) {
    const toks = [], starts = [], ends = [];
    WORD.lastIndex = 0;
    for (let m; (m = WORD.exec(text));) { toks.push(normTok(m[0])); starts.push(m.index); ends.push(m.index + m[0].length); }
    return { toks, starts, ends };
  }

  function tokHash(s) {
    let a = 0x811c9dc5, b = 0x01234567;
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      a = Math.imul(a ^ c, 16777619);
      b = Math.imul(b ^ c, 0x5bd1e995); b ^= b >>> 13;
    }
    return [a >>> 0, b >>> 0];
  }
  const mixA = (h, t) => { h = Math.imul(h ^ t, 0x85ebca6b); return (h ^ (h >>> 13)) >>> 0; };
  const mixB = (h, t) => { h = Math.imul(h ^ t, 0xc2b2ae35); return (h ^ (h >>> 16)) >>> 0; };
  const SEED_A = 0x9e3779b9, SEED_B = 0x7f4a7c15;

  function keyHash(toks) {
    let A = SEED_A, B = SEED_B;
    for (const t of toks) { const [a, b] = tokHash(t); A = mixA(A, a); B = mixB(B, b); }
    return [A, B];
  }

  // Binary index layout (Uint32Array): [magic, slotBits, 0, ...table(slots*3: hashA, hashB, value+1)]
  // value = groupIdx << 7 | cap << 6 | common << 5 | amb << 4 | kind. A group is every work carrying that name (shared titles like
  // "Dune", series like "Star Wars"), see tools/build-index.mjs.
  const MAGIC = 0x53424959;

  // entries: Map<keyString, value> -> ArrayBuffer
  function buildIndexBinary(entries) {
    const n = entries.size;
    let bits = 4; while ((1 << bits) < n * 1.6) bits++;
    const slots = 1 << bits, mask = slots - 1;
    const u = new Uint32Array(3 + slots * 3);
    u[0] = MAGIC; u[1] = bits;
    for (const [key, v] of entries) {
      const [A, B] = keyHash(key.split(' '));
      let s = A & mask;
      while (u[3 + s * 3 + 2]) s = (s + 1) & mask;
      u[3 + s * 3] = A; u[3 + s * 3 + 1] = B; u[3 + s * 3 + 2] = v + 1;
    }
    return u.buffer;
  }
  const TITLE_LIKE = (k) => k === KIND.TITLE || k === KIND.ALIAS || k === KIND.SERIES;

  class Matcher {
    // meta: { ids, titles, types, years, groups: [[label, workIdx...]...] } from data/index.json
    constructor(buf, meta) {
      this.u = new Uint32Array(buf);
      if (this.u[0] !== MAGIC) throw new Error('bad index');
      this.mask = (1 << this.u[1]) - 1;
      this.meta = meta;
    }

    lookup(A, B) {
      const u = this.u; let s = A & this.mask;
      for (;;) {
        const o = 3 + s * 3, ref = u[o + 2];
        if (!ref) return -1;
        if (u[o] === A && u[o + 1] === B) return ref - 1;
        s = (s + 1) & this.mask;
      }
    }

    // Raw hits: [{ i (first token), n (token count), v (value) }]
    scanTokens(tk) {
      const hits = [], { toks } = tk, ha = new Array(toks.length), hb = new Array(toks.length);
      for (let i = 0; i < toks.length; i++) [ha[i], hb[i]] = tokHash(toks[i]);
      for (let i = 0; i < toks.length; i++) {
        let A = SEED_A, B = SEED_B;
        for (let n = 1; n <= MAX_N && i + n <= toks.length; n++) {
          A = mixA(A, ha[i + n - 1]); B = mixB(B, hb[i + n - 1]);
          const v = this.lookup(A, B);
          if (v >= 0) hits.push({ i, n, v });
        }
      }
      return hits;
    }

    // Returns groupIdx[] (most popular first) that the text is about, applying the ambiguous-title rule.
    // groupSeen(groupIdx) -> true when every work of the group is seen.
    evaluate(text, groupSeen = () => false) {
      const tk = tokenize(text);
      const hits = this.scanTokens(tk);
      if (!hits.length) return [];
      const { years, groups } = this.meta;
      const cands = [];
      for (const h of hits) {
        const g = h.v >>> 7, cap = (h.v >>> 6) & 1, common = (h.v >>> 5) & 1, amb = (h.v >>> 4) & 1, kind = h.v & 15;
        const s = tk.starts[h.i], e = tk.ends[h.i + h.n - 1];
        const hashed = text[s - 1] === '#';
        if (kind === KIND.TAG && !hashed) continue;
        const firstTok = text.slice(s, tk.ends[h.i]);
        if ((kind === KIND.CHAR1 || kind === KIND.PART) && !/^\p{Lu}/u.test(firstTok)) continue; // bare names must be capitalized
        // "cap" names must appear in Title Case ("The Walk", "Siberia"), not "the walk" / "siberia"
        if (cap && !hashed && !isQuoted(text, s, e) &&
            tk.toks.slice(h.i, h.i + h.n).some((t, j) => (j === 0 || t.length > 3) && !/^[\p{Lu}\p{N}]/u.test(text.slice(tk.starts[h.i + j])))) continue;
        const weak = common || kind === KIND.CHAR1 || kind === KIND.PART || (TITLE_LIKE(kind) && ((amb && h.n <= 2) || (h.n === 1 && firstTok.length <= 3)));
        cands.push({ g, common, seen: groupSeen(g), weak, part: kind === KIND.PART, h, s, e, hashed, key: tk.toks.slice(h.i, h.i + h.n).join(' ') });
      }
      // Longest match wins: "Us" and "Last" inside "The Last of Us", "Potter" inside "Harry Potter".
      const inside = (c, o) => o !== c && o.h.i <= c.h.i && o.h.i + o.h.n >= c.h.i + c.h.n && o.h.n > c.h.n;
      const drop = cands.map((c) => c.seen || cands.some((o) => inside(c, o)));
      for (let k = cands.length - 1; k >= 0; k--) if (drop[k]) cands.splice(k, 1);
      const shares = (a, b) => a === b || groups[a].some((w, i) => i > 0 && groups[b].includes(w, 1));
      const out = new Set();
      let tokSet = null;
      for (const c of cands) {
        if (out.has(c.g)) continue;
        if (!c.weak || c.hashed || isQuoted(text, c.s, c.e) ||
            cands.some((o) => o.key !== c.key && shares(o.g, c.g))) { out.add(c.g); continue; }
        if (c.part || !/^\p{Lu}/u.test(text.slice(c.s))) continue; // remaining rules need a capitalized form
        tokSet ??= new Set(tk.toks);
        if (groups[c.g].some((w, i) => i > 0 && years[w] && tokSet.has(String(years[w])))) { out.add(c.g); continue; }
        const lo = Math.max(0, c.h.i - 3), hi = Math.min(tk.toks.length, c.h.i + c.h.n + 3);
        let near = false;
        for (let j = lo; j < hi && !near; j++) near = (j < c.h.i || j >= c.h.i + c.h.n) && isContext(tk.toks[j]);
        // everyday-word names only take an adjacent media word, and never at the start of a sentence
        if (c.common ? near && !sentenceStart(text, c.s) : near || (!sentenceStart(text, c.s) && tk.toks.some(isContext))) out.add(c.g);
      }
      // A group whose works are all inside another matched group adds nothing ("Potter" inside "Harry Potter").
      const res = [...out].filter((g) => ![...out].some((o) => o !== g && groups[g].length < groups[o].length &&
        groups[g].every((w, i) => i === 0 || groups[o].includes(w, 1))));
      return res.sort((a, b) => a - b);
    }
  }
  const isContext = (t) => CONTEXT.has(t) || SXEX.test(t);
  function isQuoted(text, s, e) {
    return /["“'‘«*_]/.test(text[s - 1] ?? '') && /["”'’»*_]/.test(text[e] ?? '');
  }
  function sentenceStart(text, s) {
    for (let i = s - 1; i >= 0; i--) {
      const c = text[i];
      if (c === '\n') return true; // a line break separates texts (UI labels such as YouTube's "Go to channel X" lines)
      if (/\s/.test(c)) continue;
      return /[.!?:;\n•|\-–—(\[]/.test(c);
    }
    return true;
  }

  const api = { Matcher, tokenize, normTok, keyHash, buildIndexBinary, KIND, MAX_N };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else globalThis.SBMatcher = api;
})();
