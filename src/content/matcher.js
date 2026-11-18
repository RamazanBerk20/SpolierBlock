// Text matcher shared by the content script, the background (OCR/search) and the build tool.
// Instead of an Aho-Corasick automaton (tens of MB of JS objects per tab for 50k works) catalog keys
// are stored as 64-bit hashes of normalized token n-grams in one flat Uint32Array that is loaded
// as-is: lookup cost is O(tokens * MAX_N) and per-tab memory is the size of the file.
(function () {
  'use strict';
  const MAX_N = 8; // keys longer than 8 tokens are dropped at build time
  // CHAR1 = single-token character name; PART = one token of a multi-token character name (corroboration only)
  const KIND = { TITLE: 0, ALIAS: 1, CHAR: 2, TAG: 3, CHAR1: 4, SERIES: 5, PART: 6 };
  // Media context words -> the work types they corroborate (bit per type, see TYPE_BIT). "Nintendo Switch" says nothing
  // about a film called "Switch", "the Warriors game" nothing about the "Warriors" novels. Tokens are normalised
  // (lowercase, no diacritics), so "bölüm" is "bolum" and "película" is "pelicula".
  const TYPE_BIT = { movie: 1, tv: 2, game: 4, book: 8, anime: 16, manga: 32, comic: 64 };
  const MOV = 1, EPIS = 2 | 16, SCREEN = 1 | 2 | 16, GAME = 4, READ = 8 | 32 | 64, ALL = 127;
  const CONTEXT = new Map();
  for (const [mask, words] of [
    [ALL, 'ending endings finale spoiler spoilers sequel prequel remake reboot character characters plot adaptation franchise saga trilogy premiere'],
    [SCREEN | GAME, 'trailer teaser scene scenes cast animation animated'],
    [SCREEN, 'director cinema theater theatre netflix hbo disney pixar imdb tv watched watching rewatch rewatched ' +
      'rewatching binge imax actor actress acting oscar oscars emmy emmys blockbuster screenplay cine kino'],
    [MOV, 'movie movies film films'],
    [EPIS, 'season seasons episode episodes ep eps show episodic showrunner sitcom miniseries'],
    [EPIS | READ, 'series'],
    [GAME, 'game games dlc boss playthrough gameplay nintendo playstation xbox steam played playing replayed roguelike ' +
      'roguelite metroidvania platformer rpg jrpg mmo mmorpg fps soulslike speedrun multiplayer'],
    [READ, 'chapter chapters volume book books novel read reading reread author comic comics webcomic'],
    [16 | 32, 'anime manga shonen seinen isekai manhwa webtoon'],
    // Turkish, Spanish, Portuguese, German, French, Italian
    [SCREEN | GAME, 'fragman fragmani'],
    [EPIS | READ, 'capitulo capitulos serie'],
    [EPIS, 'finali temporada episodio episodios staffel folge folgen saison stagione puntata'],
    [MOV, 'pelicula peliculas filme filmes'],
    [GAME, 'juego videojuego jogo spiel jeu gioco'],
    [READ, 'libro livro novela livre tome'],
  ]) for (const w of words.split(' ')) CONTEXT.set(w, (CONTEXT.get(w) ?? 0) | mask);
  // Turkish adds suffixes ("sezonunu", "bölümünde", "izliyorum"): these stems match any word they start
  const STEMS = [['sezon', EPIS], ['bolum', EPIS | READ], ['dizi', EPIS], ['fragman', SCREEN | GAME], ['film', MOV],
    ['izle', SCREEN], ['izli', SCREEN], ['oyun', GAME], ['oyn', GAME], ['kitap', READ], ['kitab', READ], ['okudu', READ],
    ['okuyor', READ], ['okuma', READ], ['cizgi', READ], ['serisi', EPIS | READ], ['manga', 16 | 32], ['anime', 16 | 32],
    ['sinema', SCREEN]];
  const SXEX = /^s\d{1,2}e\d{1,3}$/;
  // shortcut: CJK/Thai text has no spaces, so whole runs become one token and titles inside them do not match; add per-script segmentation (Intl.Segmenter) for those locales.
  // An apostrophe splits words, so a name keeps its tokens under a possessive or a suffix ("Interstellar's",
  // Turkish "Breaking Bad'i", French "d'Arcane"); the index also holds the apostrophe-less form ("Schindlers List").
  const WORD = /&|[\p{L}\p{N}]+/gu;

  function normTok(s) {
    if (s === '&') return 'and';
    s = s.toLowerCase();
    // eslint-disable-next-line no-control-regex
    return /[^\x00-\x7f]/.test(s) ? s.normalize('NFKD').replace(/\p{M}/gu, '') : s;
  }

  // -> { toks: string[], starts: number[], ends: number[] } (char offsets into text)
  // A suffix after an apostrophe ("'s", "'t", Turkish "'i", "'nin") is dropped when the word before it is longer than 2
  // letters (French "d'", "l'", "qu'" keep the word after them).
  function tokenize(text) {
    const toks = [], starts = [], ends = [];
    WORD.lastIndex = 0;
    for (let m; (m = WORD.exec(text));) {
      const k = toks.length - 1;
      if (k >= 0 && ends[k] === m.index - 1 && /['’]/.test(text[ends[k]]) && ends[k] - starts[k] > 2 && m[0].length <= 4) {
        ends[k] = m.index + m[0].length; // the suffix stays part of the word's span
        continue;
      }
      toks.push(normTok(m[0])); starts.push(m.index); ends.push(m.index + m[0].length);
    }
    return { toks, starts, ends };
  }
  // sentence number of each token: a new sentence after . ! ? or a line break between two tokens, except the dot of an
  // ordinal number ("2. sezon", "3. Staffel")
  function sentences(text, tk) {
    const out = new Array(tk.toks.length);
    let n = 0;
    for (let i = 0; i < out.length; i++) {
      const gap = i > 0 ? text.slice(tk.ends[i - 1], tk.starts[i]) : '';
      if (/[.!?\n]/.test(gap) && !(/^\. $/.test(gap) && /^\d{1,2}$/.test(tk.toks[i - 1]))) n++;
      out[i] = n;
    }
    return out;
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

  // Binary index layout (Uint32Array): [magic, slotBits, format, ...table(slots*3: hashA, hashB, value+1)]
  // format 1: value = groupIdx << 8 | rare << 7 | cap << 6 | common << 5 | amb << 4 | other << 3 | kind (3 bits).
  // format 0 (older builds): value = groupIdx << 7 | cap << 6 | common << 5 | amb << 4 | kind; read as other = rare = 0.
  // "other": the name mostly means something else (a place, a person, a brand); "rare": a single uncommon word naming
  // a less popular work. See src/shared/build-index.js. A group is every work carrying that name (shared titles like
  // "Dune", series like "Star Wars"), see tools/build-index.mjs.
  const MAGIC = 0x53424959;

  // entries: Map<keyString, value> -> ArrayBuffer
  function buildIndexBinary(entries) {
    const n = entries.size;
    let bits = 4; while ((1 << bits) < n * 1.6) bits++;
    const slots = 1 << bits, mask = slots - 1;
    const u = new Uint32Array(3 + slots * 3);
    u[0] = MAGIC; u[1] = bits; u[2] = 1;
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
      this.v1 = this.u[2] >= 1;
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
        const v1 = this.v1, g = h.v >>> (v1 ? 8 : 7), rare = v1 && (h.v >>> 7) & 1, cap = (h.v >>> 6) & 1, common = (h.v >>> 5) & 1;
        const amb = (h.v >>> 4) & 1, other = v1 && (h.v >>> 3) & 1, kind = h.v & (v1 ? 7 : 15);
        const s = tk.starts[h.i], e = tk.ends[h.i + h.n - 1];
        const hashed = text[s - 1] === '#';
        if (kind === KIND.TAG && !hashed) continue;
        const firstTok = text.slice(s, tk.ends[h.i]);
        if ((kind === KIND.CHAR1 || kind === KIND.PART) && !/^\p{Lu}/u.test(firstTok)) continue; // bare names must be capitalized
        // "cap" names must appear in Title Case ("The Walk", "Siberia"), not "the walk" / "siberia", quoted or not
        if (cap && !hashed &&
            tk.toks.slice(h.i, h.i + h.n).some((t, j) => (j === 0 || t.length > 3) && !/^[\p{Lu}\p{N}]/u.test(text.slice(tk.starts[h.i + j])))) continue;
        const weak = common || other || rare || kind === KIND.CHAR1 || kind === KIND.PART || (TITLE_LIKE(kind) && ((amb && h.n <= 2) || (h.n === 1 && firstTok.length <= 3)));
        cands.push({ g, common, other, rare, seen: groupSeen(g), weak, part: kind === KIND.PART, h, s, e, hashed, key: tk.toks.slice(h.i, h.i + h.n).join(' ') });
      }
      // Longest match wins: "Us" and "Last" inside "The Last of Us", "Potter" inside "Harry Potter".
      const inside = (c, o) => o !== c && o.h.i <= c.h.i && o.h.i + o.h.n >= c.h.i + c.h.n && o.h.n > c.h.n;
      const drop = cands.map((c) => c.seen || cands.some((o) => inside(c, o)));
      for (let k = cands.length - 1; k >= 0; k--) if (drop[k]) cands.splice(k, 1);
      const shares = (a, b) => a === b || groups[a].some((w, i) => i > 0 && groups[b].includes(w, 1));
      const out = new Set();
      let sent = null;
      for (const c of cands) {
        if (out.has(c.g)) continue;
        // a hashtag or quotes are no evidence for a name that mostly means something else (#Palestine, a song title)
        if (!c.weak || (!c.other && (c.hashed || isQuoted(text, c.s, c.e))) ||
            cands.some((o) => o.key !== c.key && shares(o.g, c.g))) { out.add(c.g); continue; }
        if (c.part || !/^\p{Lu}/u.test(text.slice(c.s))) continue; // remaining rules need a capitalized form
        // the rest only looks inside the name's own sentence, at words that fit the work's type
        sent ??= sentences(text, tk);
        const si = sent[c.h.i], mask = this.typeMask(c.g);
        const fits = (j) => sent[j] === si && (j < c.h.i || j >= c.h.i + c.h.n) && (contextMask(tk.toks[j]) & mask) !== 0;
        let near = false;
        for (let j = Math.max(0, c.h.i - 3), hi = Math.min(tk.toks.length, c.h.i + c.h.n + 3); j < hi && !near; j++) near = fits(j);
        // only a media word right next to it ("Lost season 6", "Lost 2. sezon")
        const after = c.h.i + c.h.n + (/^\d+$/.test(tk.toks[c.h.i + c.h.n] ?? '') ? 1 : 0);
        const adjacent = fits(c.h.i - 1) || fits(after);
        // a name that mostly means something else (Palestine, Napoleon) only takes a media word near it; as an everyday
        // word at the start of a sentence ("Go to channel TV") only one right next to it
        if (c.other) { if (c.common && sentenceStart(text, c.s) ? adjacent : near) out.add(c.g); continue; }
        let ok = false; // a release year of one of its works in the same sentence
        for (let j = 0; j < tk.toks.length && !ok; j++) {
          ok = sent[j] === si && groups[c.g].some((w, i) => i > 0 && years[w] && tk.toks[j] === String(years[w]));
        }
        // At the start of a sentence a capital means nothing, so everyday words there need a second capitalised word of
        // 3+ letters ("The Bear", not "Marley and Me")
        let capped = !c.common || !sentenceStart(text, c.s);
        for (let j = c.h.i + 1; j < c.h.i + c.h.n && !capped; j++) capped = tk.toks[j].length >= 3 && /^\p{Lu}/u.test(text.slice(tk.starts[j]));
        if (!ok && !capped) ok = adjacent;
        else if (!ok && c.common && c.h.n === 1) ok = near; // a single everyday word: within 3 words
        else for (let j = 0; j < tk.toks.length && !ok; j++) ok = fits(j); // other weak names: anywhere in their sentence
        if (ok) out.add(c.g);
      }
      // A group whose works are all inside another matched group adds nothing ("Potter" inside "Harry Potter").
      const res = [...out].filter((g) => ![...out].some((o) => o !== g && groups[g].length < groups[o].length &&
        groups[g].every((w, i) => i === 0 || groups[o].includes(w, 1))));
      return res.sort((a, b) => a - b);
    }

    // bit set of the work types in a group (TYPE_BIT)
    typeMask(g) {
      this.masks ??= new Map();
      let m = this.masks.get(g);
      if (m === undefined) {
        m = 0;
        for (const w of this.meta.groups[g].slice(1)) m |= TYPE_BIT[this.meta.types[w]] ?? 0;
        this.masks.set(g, m);
      }
      return m;
    }
  }
  function contextMask(t) {
    const m = CONTEXT.get(t);
    if (m !== undefined) return m;
    if (SXEX.test(t)) return EPIS;
    for (const [stem, mask] of STEMS) if (t.startsWith(stem)) return mask;
    return 0;
  }
  function isQuoted(text, s, e) {
    // a closing apostrophe followed by a letter is part of a word ("It's"), not a quote
    return /["“'‘«*_]/.test(text[s - 1] ?? '') && /["”'’»*_]/.test(text[e] ?? '') && !/^['’]\p{L}/u.test(text.slice(e, e + 3));
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

  const api = { Matcher, tokenize, normTok, keyHash, buildIndexBinary, KIND, MAX_N, TYPE_BIT };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else globalThis.SBMatcher = api;
})();
