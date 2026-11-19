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
  const MOV = 1, EPIS = 2 | 16, SCREEN = 1 | 2 | 16, GAME = 4, READ = 8 | 32 | 64, ALL = 127, YT = 128;
  const CONTEXT = new Map();
  for (const [mask, words] of [
    [ALL, 'ending endings finale spoiler spoilers sequel prequel remake reboot character characters plot adaptation franchise saga trilogy premiere'],
    // video-title words ("Oppenheimer Review", "Halo Lore", "Midsommar Is A Masterpiece"): weak (YT), an everyday-word
    // name does not take them ("Switch 2 Review", "Telefon incelemesi", "Click Review")
    [ALL | YT, 'review reviews reaction reacts reacting soundtrack ost lore recap recaps breakdown masterpiece remastered inceleme incelemesi'],
    [GAME | YT, 'walkthrough mod mods modded'],
    [SCREEN | GAME, 'trailer teaser scene scenes cast animation animated'],
    [SCREEN, 'director cinema theater theatre netflix hbo disney pixar imdb tv watched watching rewatch rewatched ' +
      'rewatching binge imax oscar oscars emmy emmys blockbuster screenplay cine kino'],
    [MOV, 'movie movies film films'],
    [EPIS, 'season seasons episode episodes ep eps show episodic showrunner sitcom miniseries'],
    [ALL, 'series'],
    [GAME, 'game games dlc boss playthrough gameplay nintendo playstation xbox steam played playing replayed roguelike ' +
      'roguelite metroidvania platformer rpg jrpg mmo mmorpg fps soulslike speedrun multiplayer'],
    [READ, 'chapter chapters volume book books novel read reading reread author comic comics webcomic'],
    [16 | 32, 'anime manga shonen seinen isekai manhwa webtoon'],
    // Turkish, Spanish, Portuguese, German, French, Italian
    [SCREEN | GAME, 'fragman fragmani'],
    [EPIS | READ, 'capitulo capitulos'],
    [ALL, 'serie seri serien'],
    [EPIS, 'finali temporada episodio episodios staffel folge folgen saison stagione puntata'],
    [MOV, 'pelicula peliculas filme filmes'],
    [GAME, 'juego videojuego jogo spiel jeu gioco'],
    [READ, 'libro livro novela livre tome'],
  ]) for (const w of words.split(' ')) CONTEXT.set(w, (CONTEXT.get(w) ?? 0) | mask);
  // Turkish adds suffixes ("sezonunu", "bölümünde", "izliyorum"): these stems match any word they start
  const STEMS = [['sezon', EPIS], ['bolum', EPIS | READ], ['dizi', EPIS], ['fragman', SCREEN | GAME], ['film', MOV],
    ['izle', SCREEN], ['izli', SCREEN], ['oyun', GAME], ['oyn', GAME], ['kitap', READ], ['kitab', READ], ['okudu', READ],
    ['okuyor', READ], ['okuma', READ], ['cizgi', READ], ['serisi', ALL], ['serinin', ALL], ['seriye', ALL], ['manga', 16 | 32], ['anime', 16 | 32],
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
  // sentence number of each token: a new sentence after . ! ? a line break or the OCR marker between two tokens, except
  // the dot of an ordinal number ("2. sezon", "3. Staffel")
  function sentences(text, tk) {
    const out = new Array(tk.toks.length);
    let n = 0;
    for (let i = 0; i < out.length; i++) {
      const gap = i > 0 ? text.slice(tk.ends[i - 1], tk.starts[i]) : '';
      if (/[.!?\n\u0001]/.test(gap) && !(/^\. $/.test(gap) && /^\d{1,2}$/.test(tk.toks[i - 1]))) n++;
      out[i] = n;
    }
    return out;
  }
  // line number of each token before `end` (a line break or the OCR marker starts a new one)
  function lines(text, tk, end) {
    const out = new Array(end);
    let n = 0;
    for (let i = 0; i < end; i++) { if (i > 0 && /[\n\u0001]/.test(text.slice(tk.ends[i - 1], tk.starts[i]))) n++; out[i] = n; }
    return out;
  }
  // a song's title: "ft.", "feat.", "prod.", "official (music) video/audio", "music/lyric video", "(lyrics)", Turkish "klip"
  const MUSIC = /(?:^|[^\p{L}])(?:ft|feat|prod)\.|official (?:music )?(?:video|audio)|(?:music|lyric) video|\(lyrics?\)|(?:^|[^\p{L}])klip(?:$|[^\p{L}])/iu;
  // Tokens [0, end) whose capital letters prove nothing: inside a run of ALL-CAPS words, or on a Headline Case line
  // (at least 4 words of 4+ letters, 70% of them capitalised: "Grace Ashcroft's Voice Actress Reacts to Thirst Comments").
  function caseless(text, tk, end) {
    const out = new Array(end).fill(false), line = new Array(end);
    let n = 0;
    for (let i = 0; i < end; i++) { if (i > 0 && /[\n\u0001]/.test(text.slice(tk.ends[i - 1], tk.starts[i]))) n++; line[i] = n; }
    const caps = (i) => { const w = text.slice(tk.starts[i], tk.ends[i]); return w.length >= 2 && /\p{L}/u.test(w) && w === w.toUpperCase() && w !== w.toLowerCase(); };
    for (let i = 0; i < end; i++) {
      out[i] = caps(i) && ((i > 0 && line[i - 1] === line[i] && caps(i - 1)) || (i + 1 < end && line[i + 1] === line[i] && caps(i + 1)));
    }
    for (let a = 0, b; a < end; a = b) {
      let words = 0, up = 0;
      for (b = a; b < end && line[b] === line[a]; b++) {
        if (tk.toks[b].length >= 4 && /\p{L}/u.test(tk.toks[b])) { words++; if (/^\p{Lu}/u.test(text.slice(tk.starts[b]))) up++; }
      }
      if (words >= 4 && up >= 0.7 * words) for (let i = a; i < b; i++) out[i] = true;
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
  // format 2: value = groupIdx << 9 | ocr << 8 | rare << 7 | cap << 6 | common << 5 | amb << 4 | other << 3 | kind (3 bits).
  // format 3: as 2, and a name's group narrowed to one work type is stored under the name + "\u0002" + type.
  // format 1: no ocr bit, groupIdx << 8. format 0: groupIdx << 7 | cap << 6 | common << 5 | amb << 4 | kind.
  // Older formats read as ocr = other = rare = 0.
  // "ocr": the name is strong enough to count in text read from pictures (see build-index.js);
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
    u[0] = MAGIC; u[1] = bits; u[2] = 3;
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
    // meta: { ids, titles, types, years, groups: [[label, workIdx...]...], series: [[workIdx...]...] } from data/index.json
    constructor(buf, meta) {
      this.u = new Uint32Array(buf);
      if (this.u[0] !== MAGIC) throw new Error('bad index');
      this.mask = (1 << this.u[1]) - 1;
      this.fmt = this.u[2];
      this.meta = meta;
    }

    // "More from this series" (docs/agents/contract.md): the works sharing a catalog series with any work of the
    // groups gs, minus the groups' own works, oldest first (no year last). Seen works are the caller's to drop.
    moreFromSeries(gs) {
      const { groups, years, series = [] } = this.meta;
      if (!this.seriesOf) {
        this.seriesOf = new Map(); // workIdx -> series indices
        series.forEach((l, s) => { for (const w of l) (this.seriesOf.get(w) ?? this.seriesOf.set(w, []).get(w)).push(s); });
      }
      const own = new Set(gs.flatMap((g) => groups[g].slice(1)));
      const out = new Set();
      for (const s of new Set([...own].flatMap((w) => this.seriesOf.get(w) ?? []))) for (const w of series[s]) if (!own.has(w)) out.add(w);
      return [...out].sort((a, b) => (years[a] || 1e4) - (years[b] || 1e4) || a - b);
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

    // Returns the groups (indices) the text is about, in label order: groups named by the post's own text first, then
    // groups named only by OCR text; within each, the one matched by a longer name first, then the more popular.
    // text: the post's own text, optionally followed by U+0001 and the text read from its pictures (OCR).
    // groupSeen(groupIdx) -> true when every work of the group is seen.
    evaluate(text, groupSeen = () => false) {
      const tk = tokenize(text);
      const hits = this.scanTokens(tk);
      if (!hits.length) return [];
      const { years, groups } = this.meta;
      const mark = text.indexOf('\u0001');
      let ocrFrom = tk.toks.length; // first OCR token
      if (mark >= 0) ocrFrom = tk.starts.findIndex((st) => st > mark), ocrFrom = ocrFrom < 0 ? tk.toks.length : ocrFrom;
      let loud = null;
      const fmt = this.fmt, shift = fmt >= 2 ? 9 : fmt >= 1 ? 8 : 7;
      const cands = [];
      for (const h of hits) {
        const v = h.v, ocrOk = fmt >= 2 && (v >>> 8) & 1, rare = fmt >= 1 && (v >>> 7) & 1, cap = (v >>> 6) & 1;
        const amb = (v >>> 4) & 1, other = fmt >= 1 && (v >>> 3) & 1, kind = v & (fmt >= 1 ? 7 : 15);
        let common = (v >>> 5) & 1;
        const s = tk.starts[h.i], e = tk.ends[h.i + h.n - 1], ocr = h.i >= ocrFrom;
        const typed = this.typeNear(tk, text, h), g = this.narrow(tk, h, kind, typed) ?? v >>> shift;
        // text read from pictures: only names strong without help count, whatever their case
        if (ocr) { if (ocrOk) cands.push({ g, ocr, h, s, e, key: tk.toks.slice(h.i, h.i + h.n).join(' ') }); continue; }
        if (h.i + h.n > ocrFrom) continue; // never across the marker
        const hashed = text[s - 1] === '#';
        if (kind === KIND.TAG && !hashed) continue;
        const firstTok = text.slice(s, tk.ends[h.i]);
        if ((kind === KIND.CHAR1 || kind === KIND.PART) && !/^\p{Lu}/u.test(firstTok)) continue; // bare names must be capitalized
        // "cap" names must appear in Title Case ("The Walk", "Siberia"), not "the walk" / "siberia", quoted or not
        if (cap && !hashed &&
            tk.toks.slice(h.i, h.i + h.n).some((t, j) => (j === 0 || t.length > 3) && !/^[\p{Lu}\p{N}]/u.test(text.slice(tk.starts[h.i + j])))) continue;
        // a capital proves nothing in an ALL-CAPS run or a Headline Case line: there a single word or two everyday
        // words ("KES", "Thirst", "The Master") need a media word right next to them
        loud ??= caseless(text, tk, ocrFrom);
        const caseOnly = cap && (common || amb || rare || other) && (h.n === 1 || (common && h.n === 2)) && loud.slice(h.i, h.i + h.n).some(Boolean);
        const weak = caseOnly || common || other || rare || kind === KIND.CHAR1 || kind === KIND.PART || (TITLE_LIKE(kind) && ((amb && h.n <= 2) || (h.n === 1 && firstTok.length <= 3)));
        // a single word that is everyday, ambiguous or obscure ("Verity", "Bolt"); a bare number (".45" in "45 minutes")
        const plain = TITLE_LIKE(kind) && h.n === 1 && (common || amb || rare), wordy = plain && !rare, bare = TITLE_LIKE(kind) && h.n === 1 && /^\d+$/.test(tk.toks[h.i]);
        cands.push({ g, common, other, rare, caseOnly, weak: weak || bare, typed, plain, wordy, bare, part: kind === KIND.PART, h, s, e, hashed, key: tk.toks.slice(h.i, h.i + h.n).join(' ') });
      }
      // Longest match wins, seen or not: "Us" and "Last" inside "The Last of Us", "Assassin" inside "Assassin's Creed".
      const inside = (c, o) => o !== c && o.h.i <= c.h.i && o.h.i + o.h.n >= c.h.i + c.h.n && o.h.n > c.h.n;
      const drop = cands.map((c) => cands.some((o) => inside(c, o)));
      for (let k = cands.length - 1; k >= 0; k--) if (drop[k]) cands.splice(k, 1);
      // two names of one work, or one name inside the title of the other's work ("Fallout" and "New Vegas")
      const shares = (a, b) => a === b || groups[a].some((w, i) => i > 0 && groups[b].includes(w, 1));
      const apart = (a, b) => { const x = new Set(a.split(' ')); return !b.split(' ').some((t) => x.has(t)); }; // "Castle", "Castle Rock": no
      const within = (key, g) => groups[g].some((w, i) => i > 0 && (' ' + this.titleKey(w) + ' ').includes(' ' + key + ' '));
      const longest = new Map(), own = new Set(), pics = new Set(); // group -> longest accepted name; tiers
      const accept = (c) => { (c.ocr ? pics : own).add(c.g); longest.set(c.g, Math.max(longest.get(c.g) ?? 0, c.h.n)); if (!c.ocr && !everyday(c)) named.add(line[c.h.i]); };
      let sent = null;
      // A music title ("Joker ft. Defkhan - Son Kale | official video") names a song: a single word there is no work.
      const music = MUSIC.test(mark >= 0 ? text.slice(0, mark) : text);
      // A line that already names a work gives its media words to that work: a single everyday word beside it
      // ("DmC: Devil May Cry - All Boss Fights & Ending (No Damage") takes only a media word joined to it by a space
      // ("Watching Cars For The First Time") or a type word. Such words come last.
      const line = lines(text, tk, ocrFrom), named = new Set(), everyday = (c) => !c.ocr && c.wordy;
      for (const c of [...cands.filter((x) => !everyday(x)), ...cands.filter(everyday)]) {
        if (c.ocr) { accept(c); continue; }
        // a hashtag or quotes are no evidence for a name that mostly means something else (#Palestine, a song title)
        // a hashtag alone does not make a plain single word a title (#verity)
        const firm = (!c.other && ((c.hashed && !c.plain) || isQuoted(text, c.s, c.e))) || cands.some((o) => !o.ocr && o.key !== c.key && (shares(o.g, c.g) || (apart(o.key, c.key) && (within(o.key, c.g) || within(c.key, o.g)))));
        if (music && c.h.n === 1) { if (firm) accept(c); continue; }
        if (!c.weak || firm) { accept(c); continue; }
        if (c.bare) continue; // a bare number is a title only in quotes or beside another name of its work
        if (c.part || !/^[\p{Lu}\p{N}]/u.test(text.slice(c.s))) continue; // remaining rules need a capitalized form (or a number)
        // the rest only looks inside the name's own sentence, at words that fit the work's type
        sent ??= sentences(text, tk);
        const si = sent[c.h.i], mask = this.typeMask(c.g);
        const fits = (j) => {
          if (sent[j] !== si || (j >= c.h.i && j < c.h.i + c.h.n)) return false;
          const cm = contextMask(tk.toks[j]);
          return (cm & mask) !== 0 && !(cm & YT && c.common);
        };
        // the sentence says what it is ("Portal is a perfect game") or that someone consumed it ("just beat Portal")
        const said = (c.h.n > 1 || !SUBJECT.has(c.key)) && described(tk, sent, c.h.i + c.h.n, si, mask, c.common) || (sent[c.h.i - 1] === si && ((VERBS.get(tk.toks[c.h.i - 1]) ?? 0) & mask) !== 0);
        let near = said;
        for (let j = Math.max(0, c.h.i - 3), hi = Math.min(tk.toks.length, c.h.i + c.h.n + 3); j < hi && !near; j++) near = fits(j);
        // only a media word right next to it ("Lost season 6", "Lost 2. sezon")
        const after = c.h.i + c.h.n + (/^\d+$/.test(tk.toks[c.h.i + c.h.n] ?? '') ? 1 : 0);
        const adjacent = said || fits(c.h.i - 1) || fits(after);
        const joined = (a, b) => a >= 0 && b < tk.toks.length && /^ +$/.test(text.slice(tk.ends[a], tk.starts[b]));
        if (everyday(c) && named.has(line[c.h.i]) && !c.typed &&
            !(joined(c.h.i - 1, c.h.i) && fits(c.h.i - 1)) && !(joined(c.h.i, c.h.i + 1) && fits(c.h.i + 1))) continue;
        if (c.caseOnly) { if (adjacent) accept(c); continue; }
        // a name that mostly means something else (Palestine, Napoleon) only takes a media word near it; as an everyday
        // word at the start of a sentence ("Go to channel TV") only one right next to it
        if (c.other) { if (c.common && sentenceStart(text, c.s) ? adjacent : near) accept(c); continue; }
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
        if (ok) accept(c);
      }
      // The post's own text outranks its pictures: when it names a seen work and no other, OCR names do not count.
      const ownOpen = [...own].filter((g) => !groupSeen(g));
      const picOnly = own.size && !ownOpen.length ? [] : [...pics].filter((g) => !own.has(g) && !groupSeen(g));
      // A group whose works are all inside another matched group adds nothing ("Potter" inside "Harry Potter").
      const all = [...ownOpen, ...picOnly];
      const keep = (g) => !all.some((o) => o !== g && groups[g].length < groups[o].length &&
        groups[g].every((w, i) => i === 0 || groups[o].includes(w, 1)));
      const order = (a, b) => longest.get(b) - longest.get(a) || a - b;
      return [...ownOpen.filter(keep).sort(order), ...picOnly.filter(keep).sort(order)];
    }

    // A type word right next to a work's name narrows its group to works of that type ("the Minecraft movie",
    // "Assassin's Creed oyunu"): the index holds those groups under the name plus "\u0002" + type. -> group or undefined
    narrow(tk, h, kind, type) {
      if (this.fmt < 3 || !TITLE_LIKE(kind) || !type) return undefined;
      const [A, B] = keyHash([...tk.toks.slice(h.i, h.i + h.n), '\u0002' + type]), v = this.lookup(A, B);
      return v >= 0 ? v >>> 9 : undefined;
    }

    // the type word right after the name, else right before it, with no sentence break between -> type or undefined
    typeNear(tk, text, h) {
      const tight = (a, b) => !/[.!?\n\u0001]/.test(text.slice(tk.ends[a], tk.starts[b]));
      const j = h.i + h.n;
      let type = j < tk.toks.length && tight(j - 1, j) ? typeWord(tk.toks[j]) : undefined;
      if (!type && h.i > 0 && tight(h.i - 1, h.i)) type = typeWord(tk.toks[h.i - 1]);
      return type;
    }

    // a work's title as tokens joined by spaces (cached)
    titleKey(w) {
      this.tkeys ??= new Map();
      let k = this.tkeys.get(w);
      if (k === undefined) this.tkeys.set(w, k = tokenize(this.meta.titles[w]).toks.join(' '));
      return k;
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
  // Verbs of consuming a work, counted only right before the name ("beat Portal", "finished Severance")
  const VERBS = new Map([...'beat beating'.split(' ').map((w) => [w, GAME]), ...'binged binging'.split(' ').map((w) => [w, SCREEN]),
    ...'finished finishing completed started starting'.split(' ').map((w) => [w, ALL])]);
  // "<name> is/was (such) a/the ... game": a copula, a determiner, then a media word of the work's type before any
  // preposition or conjunction ("Turkey is a great place to shoot a movie" stops at "to"). Turkish needs no copula
  // ("Portal harika bir oyun").
  // subject pronouns are the subject of "is a great movie" themselves ("It was a great movie"); "Us is" is a title
  const SUBJECT = new Set('it this that he she they we you i there here what who which'.split(' '));
  const COPULA = new Set('is was are were es ist war est etait'.split(' '));
  const DET = new Set('a an the such my our your his her their this one un una ein eine einen une um uma bir'.split(' '));
  const STOP = new Set('to of for in on at with about from that which who where when because but and or if than like as by while'.split(' '));
  function described(tk, sent, j, si, mask, everyday) {
    const cop = sent[j] === si && COPULA.has(tk.toks[j]);
    if (cop) j++;
    let det = false;
    for (let k = j; k < Math.min(tk.toks.length, j + 8) && sent[k] === si; k++) {
      const t = tk.toks[k];
      if (DET.has(t)) { det ||= cop || t === 'bir'; continue; }
      const cm = contextMask(t);
      if (det && (cm & mask) !== 0 && !(everyday && cm & YT)) return true;
      if (STOP.has(t) && !(t === 'of' && tk.toks[k - 1] === 'one')) return false; // "one of the best films"
    }
    return false;
  }
  // type words for narrowing (normalised tokens; Turkish suffixed forms by stem)
  const TYPE_WORDS = new Map();
  for (const [type, words] of [['movie', 'movie movies film films pelicula peliculas filme filmes'],
    ['tv', 'show tv dizi'], ['game', 'game games juego videojuego jogo spiel jeu gioco oyun'],
    ['book', 'book books novel novels kitap libro livro novela livre'], ['anime', 'anime'], ['manga', 'manga'], ['comic', 'comic comics']]) {
    for (const w of words.split(' ')) TYPE_WORDS.set(w, type);
  }
  const TYPE_STEMS = [['film', 'movie'], ['dizi', 'tv'], ['oyun', 'game'], ['kitap', 'book'], ['kitab', 'book']];
  function typeWord(t) {
    const x = TYPE_WORDS.get(t);
    if (x) return x;
    for (const [stem, type] of TYPE_STEMS) if (t.startsWith(stem)) return type;
    return undefined;
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
      if (c === '\n' || c === '\u0001') return true; // a line break separates texts (UI labels such as YouTube's "Go to channel X" lines)
      if (/\s/.test(c)) continue;
      return /[.!?:;\n•|\-–—(\[]/.test(c);
    }
    return true;
  }

  const api = { Matcher, tokenize, normTok, keyHash, buildIndexBinary, KIND, MAX_N, TYPE_BIT };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else globalThis.SBMatcher = api;
})();
