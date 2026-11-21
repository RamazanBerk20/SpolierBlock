// Text matcher shared by the content script, the background (OCR/search) and the build tool.
// Instead of an Aho-Corasick automaton (tens of MB of JS objects per tab for 50k works) catalog keys
// are stored as 64-bit hashes of normalized token n-grams in one flat Uint32Array that is loaded
// as-is: lookup cost is O(tokens * MAX_N) and per-tab memory is the size of the file.
(function () {
  'use strict';
  const MAX_N = 8; // keys longer than 8 tokens are dropped at build time
  // CHAR1 = single-token character name; PART = one token of a multi-token character name (corroboration only);
  // ACRONYM = an alias written in capitals that is an everyday word in lowercase ("GTA", "GOT"): matches only in capitals
  const KIND = { TITLE: 0, ALIAS: 1, CHAR: 2, TAG: 3, CHAR1: 4, SERIES: 5, PART: 6, ACRONYM: 7 };
  // Media context words -> the work types they corroborate (bit per type, see TYPE_BIT). "Nintendo Switch" says nothing
  // about a film called "Switch", "the Warriors game" nothing about the "Warriors" novels. Tokens are normalised
  // (lowercase, no diacritics), so "bölüm" is "bolum" and "película" is "pelicula".
  const TYPE_BIT = { movie: 1, tv: 2, game: 4, book: 8, anime: 16, manga: 32, comic: 64 };
  const MOV = 1, EPIS = 2 | 16, SCREEN = 1 | 2 | 16, GAME = 4, READ = 8 | 32 | 64, ALL = 127, YT = 128, NOUN = 256;
  const CONTEXT = new Map();
  for (const [mask, words] of [
    [ALL, 'ending endings finale spoiler spoilers sequel prequel remake reboot character characters plot adaptation franchise saga trilogy premiere'],
    // video-title words ("Oppenheimer Review", "Halo Lore", "Midsommar Is A Masterpiece"): weak (YT), an everyday-word
    // name does not take them ("Switch 2 Review", "Telefon incelemesi", "Click Review")
    [ALL | YT, 'review reviews reaction reacts reacting soundtrack ost lore recap recaps breakdown masterpiece remastered inceleme incelemesi'],
    [GAME | YT, 'walkthrough mod mods modded'],
    // "scene" makes a compound with an everyday word before it ("Music scene in Lagos", "crime scene"): not right after one
    [SCREEN | GAME, 'trailer teaser cast animation animated'], [SCREEN | GAME | NOUN, 'scene scenes'],
    [SCREEN | READ, 'anthology anthologies'], [ALL, 'antihero antiheroes'],
    [SCREEN, 'director cinema theater theatre netflix hbo disney pixar imdb tv watched watching rewatch rewatched ' +
      'rewatching binge imax oscar oscars emmy emmys blockbuster screenplay cine kino'],
    [MOV, 'movie movies film films'],
    [EPIS, 'season seasons episode episodes ep eps show episodic showrunner sitcom miniseries'],
    [ALL, 'series'],
    [GAME, 'game games dlc boss playthrough gameplay nintendo playstation xbox steam played playing replayed roguelike ' +
      'roguelite metroidvania platformer rpg jrpg mmo mmorpg fps soulslike speedrun multiplayer simulator'],
    [READ, 'chapter chapters volume book books novel read reading reread author comic comics webcomic memoir'],
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
    ['sinema', SCREEN], ['bitir', ALL]];
  const SXEX = /^s\d{1,2}e\d{1,3}$/;
  // shortcut: CJK/Thai text has no spaces, so whole runs become one token and titles inside them do not match; add per-script segmentation (Intl.Segmenter) for those locales.
  // An apostrophe splits words, so a name keeps its tokens under a possessive or a suffix ("Interstellar's",
  // Turkish "Breaking Bad'i", French "d'Arcane"); the index also holds the apostrophe-less form ("Schindlers List").
  const WORD = /&|[\p{L}\p{N}]+/gu;
  // a handle: the run of [\w.-] after "@", or after "u/" or "r/" that does not follow a letter or digit
  const HANDLE = /(?:@|(?<![\p{L}\p{N}])[ur]\/)[\w.-]+/gu, WORDCH = /[\p{L}\p{Nd}]/u;

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
  // music words that also turn up in posts about a work ("the soundtrack album"): a song's title only in a text with no
  // media word ("Joker yeni albüm çıkardı", "Joker freestyle"); Turkish albüm, şarkı, konser with any suffix
  const MUSIC_WORDS = /(?:^|[^\p{L}])(?:albums?|freestyle|remix(?:es)?|mixtape|diss ?track|albüm\p{L}*|şark[ıI]\p{L}*|konser\p{L}*)(?:$|[^\p{L}])/iu;
  // English function words (unsure names, docs/agents/contract.md): left out are the frequent words of Turkish, German,
  // Spanish, French, Italian, Portuguese or Dutch written without accents ("a", "i", "in", "on", "so", "her", "can"),
  // except "is" and "was" (Dutch and German too), without which short English posts ("lost was peak tv") lose their name
  const EN_WORDS = new Set(('the of to and is was it its this that these those my you your we our they their them she his ' +
    'for with not but if when what who how why have had does did been being are were be just than then from by will would ' +
    'could should about there which because into through after like very really any some only never ever every').split(' '));
  // a channel name minus a trailing "Official", "VEVO", "Music", "Müzik" or "- Topic" (also glued: "JokerVEVO"), as tokens
  const UP_SUFFIX = ['official', 'vevo', 'music', 'muzik', 'topic'];
  function uploaderKey(s) {
    const toks = tokenize(s).toks;
    for (let t; (t = toks.at(-1));) {
      const x = UP_SUFFIX.find((x) => t.endsWith(x));
      if (!x || (t === x && toks.length === 1)) break;
      if (t === x) toks.pop(); else toks[toks.length - 1] = t.slice(0, -x.length);
    }
    return toks.join(' ');
  }
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
  // "ocr": the name is strong enough to count in text read from pictures (see build-index.js); a one-word name is never
  // that, so on one word the bit says "quiet": a top-1000 everyday word, or an everyday word naming a work below DISTINCT_POP
  // (never an unsure name);
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
  const NONE = () => false;
  const TITLE_LIKE = (k) => k === KIND.TITLE || k === KIND.ALIAS || k === KIND.SERIES || k === KIND.ACRONYM;

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
      const own = new Set(gs.flatMap((g) => groups[g].slice(1)));
      const out = new Set();
      for (const s of this.seriesIn(gs)) for (const w of series[s]) if (!own.has(w)) out.add(w);
      return [...out].sort((a, b) => (years[a] || 1e4) - (years[b] || 1e4) || a - b);
    }

    // the catalog series (indices into meta.series) of the works of the groups gs
    seriesIn(gs) {
      if (!this.seriesOf) {
        this.seriesOf = new Map(); // workIdx -> series indices
        (this.meta.series ?? []).forEach((l, s) => { for (const w of l) (this.seriesOf.get(w) ?? this.seriesOf.set(w, []).get(w)).push(s); });
      }
      return new Set(gs.flatMap((g) => this.meta.groups[g].slice(1)).flatMap((w) => this.seriesOf.get(w) ?? []));
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
    // Also fills the unsure names that unsure(text, groupSeen) returns for the same call.
    evaluate(text, groupSeen = NONE) {
      this.last = { text, groupSeen, unsure: [] };
      // The uploader's name (a YouTube channel) after U+0002, before any OCR part (contract rule 9): it names no work and
      // is no evidence, so it is blanked (a line break and spaces keep every offset) and kept only as a key.
      let upKey = '';
      const upAt = text.indexOf('\u0002'), upEnd = text.indexOf('\u0001') < 0 ? text.length : text.indexOf('\u0001');
      if (upAt >= 0 && upAt < upEnd) {
        upKey = uploaderKey(text.slice(upAt + 1, upEnd));
        text = text.slice(0, upAt) + '\n' + ' '.repeat(upEnd - upAt - 1) + text.slice(upEnd);
      }
      const tk = tokenize(text);
      const hits = this.scanTokens(tk);
      if (!hits.length) return [];
      const { years, groups } = this.meta;
      const mark = text.indexOf('\u0001');
      let ocrFrom = tk.toks.length; // first OCR token
      if (mark >= 0) ocrFrom = tk.starts.findIndex((st) => st > mark), ocrFrom = ocrFrom < 0 ? tk.toks.length : ocrFrom;
      let loud = null;
      const fmt = this.fmt, shift = fmt >= 2 ? 9 : fmt >= 1 ? 8 : 7;
      const cands = [], skipped = []; // skipped: title-like names of the own text the rules drop before judging them
      // [start, end) spans of @handles, u/ and r/ names; a token inside one is no evidence either ("r/movies")
      const handles = [...text.matchAll(HANDLE)].map((x) => [x.index, x.index + x[0].length]);
      tk.hid = tk.starts.map((st, j) => handles.some(([a, b]) => st >= a && tk.ends[j] <= b));
      for (const h of hits) {
        const v = h.v, ocrOk = fmt >= 2 && h.n > 1 && (v >>> 8) & 1, quiet = fmt >= 2 && h.n === 1 && (v >>> 8) & 1, rare = fmt >= 1 && (v >>> 7) & 1, cap = (v >>> 6) & 1;
        const amb = (v >>> 4) & 1, other = fmt >= 1 && (v >>> 3) & 1, kind = v & (fmt >= 1 ? 7 : 15);
        let common = (v >>> 5) & 1;
        const s = tk.starts[h.i], e = tk.ends[h.i + h.n - 1], ocr = h.i >= ocrFrom;
        // a name inside a handle or glued to a word by "_" is no text ("u/Altruistic_Mud_8425", "Name@Mud_Lover99")
        if (handles.some(([a, b]) => s >= a && e <= b) || (text[s - 1] === '_' && WORDCH.test(text[s - 2] ?? '')) ||
            (text[e] === '_' && WORDCH.test(text[e + 1] ?? ''))) continue;
        const typed = this.typeNear(tk, text, h), g = this.narrow(tk, h, kind, typed) ?? v >>> shift;
        // text read from pictures: only names strong without help count, whatever their case
        if (ocr) { if (ocrOk) cands.push({ g, ocr, h, s, e, key: tk.toks.slice(h.i, h.i + h.n).join(' ') }); continue; }
        if (h.i + h.n > ocrFrom) continue; // never across the marker
        const hashed = text[s - 1] === '#';
        if (kind === KIND.TAG && !hashed) continue;
        const firstTok = text.slice(s, tk.ends[h.i]);
        if ((kind === KIND.CHAR1 || kind === KIND.PART) && !/^\p{Lu}/u.test(firstTok)) continue; // bare names must be capitalized
        // an acronym only in capitals (2+ letters, before any apostrophe suffix: "GTA’yı"), outside a run where capitals
        // prove nothing ("I GOT THE GAME")
        const key = tk.toks.slice(h.i, h.i + h.n).join(' '), skip = () => skipped.push({ g, h, s, e, key, quiet, common, ocrOk, other, title: true });
        if (kind === KIND.ACRONYM && !(/^\p{Lu}{2,}$/u.test(firstTok.split(/['’]/)[0]) && !(loud ??= caseless(text, tk, ocrFrom))[h.i])) { skip(); continue; }
        // "cap" names must appear in Title Case ("The Walk", "Siberia", "Gone with the Wind"), not "the walk" / "siberia",
        // quoted or not. A title that is otherwise strong becomes a weak "lowercase" name instead ("playing resident evil 4").
        let lower = false;
        if (cap && !hashed &&
            tk.toks.slice(h.i, h.i + h.n).some((t, j) => (j === 0 || (t.length > 3 && !STOP.has(t))) && !/^[\p{Lu}\p{N}]/u.test(text.slice(tk.starts[h.i + j])))) {
          // an everyday name of 3+ words holding a name of the same catalog series stays a candidate ("dune part two")
          if (!TITLE_LIKE(kind) || (common && !(h.n >= 3 && this.seriesInside(hits, h, g, shift))) || amb || other || rare || (h.n === 1 && (firstTok.length <= 3 || /^\d+$/.test(tk.toks[h.i]))) ||
              (h.n === 2 && tk.toks[h.i] === 'the')) { if (TITLE_LIKE(kind)) skip(); continue; }
          lower = true;
        }
        // a capital proves nothing in an ALL-CAPS run or a Headline Case line: there a single word or two everyday
        // words ("KES", "Thirst", "The Master") need a media word right next to them
        loud ??= caseless(text, tk, ocrFrom);
        // and so does a single word joined by "&" to another one there, one of a pair of names ("KHONTKAR & JOKER")
        const amp = (j) => j >= 0 && j < ocrFrom && text[tk.starts[j]] === '&';
        const caseOnly = (cap && (common || amb || rare || other) && (h.n === 1 || (common && h.n === 2)) && loud.slice(h.i, h.i + h.n).some(Boolean)) ||
          (h.n === 1 && loud[h.i] && (amp(h.i - 1) || amp(h.i + 1)));
        const weak = lower || caseOnly || common || other || rare || kind === KIND.CHAR1 || kind === KIND.PART || (TITLE_LIKE(kind) && ((amb && h.n <= 2) || (h.n === 1 && firstTok.length <= 3)));
        // a single word that is everyday, ambiguous or obscure ("Verity", "Bolt"); a bare number (".45" in "45 minutes")
        const plain = TITLE_LIKE(kind) && h.n === 1 && (common || amb || rare), wordy = plain && !rare, bare = TITLE_LIKE(kind) && h.n === 1 && /^\d+$/.test(tk.toks[h.i]);
        // written as a title: 3+ words, or 2 that are no everyday pair (not "amb", not "The" and a word), in Title Case
        // outside a run where capitals prove nothing ("Horizon Zero Dawn", "Fall Guys", "Love, Death & Robots")
        const titled = TITLE_LIKE(kind) && !lower && !other && h.n >= 2 && !(h.n === 2 && (amb || tk.toks[h.i] === 'the')) &&
          !loud.slice(h.i, h.i + h.n).some(Boolean) && titleCase(text, tk, h);
        // the uploader's whole name: never strong by itself (rule 9 of the contract)
        const up = !!upKey && key === upKey;
        cands.push({ g, common, amb, other, rare, caseOnly, weak: weak || bare || up, up, typed, plain, wordy, bare, lower, titled, title: TITLE_LIKE(kind), part: kind === KIND.PART, h, s, e, hashed, key, quiet, ocrOk });
      }
      // Longest match wins, seen or not: "Us" and "Last" inside "The Last of Us", "Assassin" inside "Assassin's Creed".
      // A weak title holding a strong title of the text is vouched for by it ("Assassin's Creed Brotherhood").
      // A name inside a lowercase name only waits: it is judged when that name is not accepted.
      const inside = (c, o) => o !== c && o.h.i <= c.h.i && o.h.i + o.h.n >= c.h.i + c.h.n && o.h.n > c.h.n;
      for (const c of cands) {
        c.under = cands.filter((o) => inside(c, o));
        c.vouched = !c.ocr && c.title && !c.lower && cands.some((o) => inside(o, c) && !o.ocr && o.title && !o.weak);
      }
      const judged = cands.slice(); // with the names inside longer ones, for the unsure names
      for (let k = cands.length - 1; k >= 0; k--) if (cands[k].under.some((o) => !o.lower)) cands.splice(k, 1);
      // two names of one work, or one name inside the title of the other's work ("Fallout" and "New Vegas")
      const shares = (a, b) => a === b || groups[a].some((w, i) => i > 0 && groups[b].includes(w, 1));
      const apart = (a, b) => { const x = new Set(a.split(' ')); return !b.split(' ').some((t) => x.has(t)); }; // "Castle", "Castle Rock": no
      const within = (key, g) => groups[g].some((w, i) => i > 0 && (' ' + this.titleKey(w) + ' ').includes(' ' + key + ' '));
      const longest = new Map(), own = new Set(), pics = new Set(); // group -> longest accepted name; tiers
      const accept = (c) => { c.ok = true; (c.ocr ? pics : own).add(c.g); longest.set(c.g, Math.max(longest.get(c.g) ?? 0, c.h.n)); if (!c.ocr && !everyday(c)) named.add(line[c.h.i]); };
      let sent = null;
      // A music title ("Joker ft. Defkhan - Son Kale | official video") names a song: a single word there is no work.
      const ownText = mark >= 0 ? text.slice(0, mark) : text;
      const music = MUSIC.test(ownText) || (MUSIC_WORDS.test(ownText) && !tk.toks.some((t, j) => j < ocrFrom && contextMask(word(tk, j))));
      // A line that already names a work gives its media words to that work: a single everyday word beside it
      // ("DmC: Devil May Cry - All Boss Fights & Ending (No Damage") takes only a media word joined to it by a space
      // ("Watching Cars For The First Time") or a type word. Such words come last.
      const line = lines(text, tk, ocrFrom), named = new Set(), everyday = (c) => !c.ocr && c.wordy;
      const lowers = cands.filter((x) => x.lower).sort((a, b) => b.h.n - a.h.n); // longest first, before the names inside
      for (const c of [...lowers, ...cands.filter((x) => !x.lower && !everyday(x)), ...cands.filter((x) => !x.lower && everyday(x))]) {
        if (c.under.some((o) => o.ok)) continue;
        if (c.ocr) { accept(c); continue; }
        sent ??= sentences(text, tk);
        const si = sent[c.h.i], mask = this.typeMask(c.g), mine = (j) => j >= c.h.i && j < c.h.i + c.h.n;
        // Next to a sentence about music ("album", "listen", "sings") quotes hold a song: a quoted name there is no work
        // unless its sentence has a media word of its type ('If you only know "Jailhouse Rock," go listen to Elvis's
        // gospel albums'), and a weak name needs a media word right next to it ("a punk gig in Bushwick")
        const song = tk.toks.some((t, j) => Math.abs(sent[j] - si) <= 1 && !mine(j) && SONG.has(word(tk, j)));
        // next to a sentence about sport a season or a game is a sport's ("Groupama Stadium... Belle saison en vue")
        const sport = tk.toks.some((t, j) => Math.abs(sent[j] - si) <= 1 && !mine(j) && SPORT.has(word(tk, j)));
        const quoted = isQuoted(text, c.s, c.e);
        if (sent[c.h.i + c.h.n] === si && COMPANY.has(word(tk, c.h.i + c.h.n))) continue; // the company ("Roblox stock jumped")
        if (quoted && song && !tk.toks.some((t, j) => sent[j] === si && !mine(j) && (contextMask(word(tk, j)) & mask) !== 0)) { c.sung = true; continue; }
        // a hashtag or quotes are no evidence for a name that mostly means something else (#Palestine, a song title)
        // a hashtag alone does not make a plain single word a title (#verity); a part of a character's name only corroborates
        const firm = (!c.other && !c.part && ((c.hashed && !c.plain) || (quoted && !song))) || cands.some((o) => !o.ocr && !o.lower && !o.up && o.key !== c.key && !inside(o, c) && !inside(c, o) && (shares(o.g, c.g) || (apart(o.key, c.key) && (within(o.key, c.g) || within(c.key, o.g)))));
        if (music && c.h.n === 1) { if (firm && !c.up) accept(c); continue; }
        // the uploader's name takes media evidence only (below): no quotes, hashtag, other name or longer name vouches for it
        if (!c.up && (!c.weak || firm || c.vouched)) { accept(c); continue; }
        if (c.bare) continue; // a bare number is a title only in quotes or beside another name of its work
        if (c.part || (!c.lower && !c.up && !/^[\p{Lu}\p{N}]/u.test(text.slice(c.s)))) continue; // remaining rules need a capitalized form (or a number)
        // the rest only looks inside the name's own sentence, at words that fit the work's type
        const after = c.h.i + c.h.n + (/^\d+$/.test(tk.toks[c.h.i + c.h.n] ?? '') ? 1 : 0);
        // A Title-Case name of 3+ words, or of 2 before a possessive or a copula ("Fall Guys is", "Doom Eternal's combat"):
        // the capitals of its later words say it is a name. Not inside a longer name or a list of names ("Royal Air
        // Force", "Department of Parks and Recreation", "Marine Corps, and Coast Guard", "Old and New Worlds", "On the
        // Origin of Species"), and not in a sentence about music (a song). Measured with tools/fp-text.mjs: mid-sentence
        // 2-word names ("General Hospital", "Coast Guard") cost more than they found.
        const capAt = (j) => j >= 0 && j < tk.toks.length && sent[j] === si && /^[\p{Lu}\p{N}]/u.test(text.slice(tk.starts[j])) &&
          !(j < c.h.i && sentenceStart(text, tk.starts[j]));
        let b = c.h.i - 1;
        while (b >= 0 && sent[b] === si && LINK.has(tk.toks[b]) && !/^\p{Lu}/u.test(text.slice(tk.starts[b]))) b--;
        const end = c.h.i + c.h.n;
        const poss = /['’]/.test(text.slice(tk.starts[end - 1], c.e)); // "Tears of the Kingdom's Ultrahand"
        if (c.titled && !c.up && !song && !capAt(b) && !(capAt(end) && !poss && !COPULA.has(tk.toks[end])) && !(tk.toks[end] === 'of' && capAt(end + 1)) &&
            (c.h.n >= 3 || poss || (sent[end] === si && COPULA.has(tk.toks[end])))) { accept(c); continue; }
        // a determiner or pronoun takes nothing from the media word right after it ("No spoilers", "This movie")
        const det = c.h.n === 1 && QUANT.has(c.key), next = (j) => det && (j === c.h.i + 1 || j === after);
        // in another sentence (s) only a word of some work types counts, not one of every type ("characters") or a weak one
        const fits = (j, s = si) => {
          if (sent[j] !== s || (j >= c.h.i && j < c.h.i + c.h.n) || next(j) || (sport && SPORTY.test(word(tk, j)))) return false;
          const cm = contextMask(word(tk, j));
          if (s !== si && ((cm & ALL) === ALL || cm & (YT | NOUN))) return false;
          return (cm & mask) !== 0 && !(cm & YT && c.common) && !(cm & NOUN && c.wordy && j === c.h.i + 1);
        };
        // the sentence says what it is ("Portal is a perfect game") or that someone consumed it ("just beat Portal")
        const said = (c.h.n > 1 || !SUBJECT.has(c.key)) && described(tk, sent, c.h.i + c.h.n, si, mask, c.common) || (sent[c.h.i - 1] === si && ((VERBS.get(word(tk, c.h.i - 1)) ?? 0) & mask) !== 0);
        let near = said;
        for (let j = Math.max(0, c.h.i - 3), hi = Math.min(tk.toks.length, c.h.i + c.h.n + 3); j < hi && !near; j++) near = fits(j);
        if (c.lower) { if (near) accept(c); continue; } // lowercase: only near evidence in its own sentence
        // only a media word right next to it ("Lost season 6", "Lost 2. sezon")
        // (after a possessive, the word after the next one: "Succession's final season")
        const adjacent = said || fits(c.h.i - 1) || fits(after) || (poss && after === end && fits(end + 1));
        // a release year of one of its works in the same sentence
        let year = false;
        for (let j = 0; j < tk.toks.length && !year; j++) year = sent[j] === si && groups[c.g].some((w, i) => i > 0 && years[w] && tk.toks[j] === String(years[w]));
        // a name whose capitals prove nothing: a media word right next to it, or a type word of its works within the
        // next 3 words of its sentence ("Until Dawn | FULL HORROR GAME - No Commentary")
        let typedSoon = false;
        for (let j = c.h.i + c.h.n; j < Math.min(tk.toks.length, c.h.i + c.h.n + 3) && !typedSoon; j++) {
          typedSoon = sent[j] === si && !next(j) && ((TYPE_BIT[typeWord(word(tk, j))] ?? 0) & mask) !== 0;
        }
        // the uploader's name: a fitting media word within 3 words, a type word after it, or a release year of its works
        // ("Minecraft - Official Trailer" from the channel Minecraft; not "Joker - Mikrofon Şov" from the rapper Joker)
        if (c.up) { if (near || typedSoon || year) accept(c); continue; }
        if (song) { if (adjacent || year) accept(c); continue; }
        const joined = (a, b) => a >= 0 && b < tk.toks.length && /^ +$/.test(text.slice(tk.ends[a], tk.starts[b]));
        if (everyday(c) && named.has(line[c.h.i]) && !c.typed && !said &&
            !(joined(c.h.i - 1, c.h.i) && fits(c.h.i - 1)) && !(joined(c.h.i, c.h.i + 1) && fits(c.h.i + 1))) continue;
        if (c.caseOnly) { if (adjacent || typedSoon) accept(c); continue; }
        // a name that mostly means something else (Palestine, Napoleon) only takes a media word near it; as an everyday
        // word at the start of a sentence ("Go to channel TV") only one right next to it
        if (c.other) { if (c.common && sentenceStart(text, c.s) ? adjacent : near) accept(c); continue; }
        let ok = year;
        // a name of short words only ("Q & A", "Get Out"): a media word within 3 words, not anywhere in its sentence
        if (c.h.n > 1 && tk.toks.slice(c.h.i, c.h.i + c.h.n).every((t) => t.length <= 3)) { if (ok || near) accept(c); continue; }
        // At the start of a sentence a capital means nothing, so everyday words there need a second capitalised word of
        // 3+ letters ("The Bear", not "Marley and Me")
        // (a Turkish suffix after an apostrophe marks a proper name wherever it stands: "Succession'ı baştan sona bitirdim")
        let capped = !c.common || !sentenceStart(text, c.s) || PROPER.test(text.slice(tk.starts[c.h.i + c.h.n - 1], c.e));
        for (let j = c.h.i + 1; j < c.h.i + c.h.n && !capped; j++) capped = tk.toks[j].length >= 3 && /^\p{Lu}/u.test(text.slice(tk.starts[j]));
        if (!ok && !capped) ok = adjacent;
        else if (!ok && c.common && c.h.n === 1) ok = near; // a single everyday word: within 3 words
        else for (let j = 0; j < tk.toks.length && !ok; j++) ok = fits(j); // other weak names: anywhere in their sentence
        // a name that is no everyday word and starts its sentence: also the sentence before or after it ("Deltarune
        // chapter 2 had me grinning. Toby Fox gave us the best boss fight of the year.")
        if (!c.common && !c.amb && sentenceStart(text, c.s)) for (let j = 0; j < tk.toks.length && !ok; j++) ok = fits(j, si - 1) || fits(j, si + 1);
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
      this.last.unsure = music ? [] : this.unsureNames(mark >= 0 ? text.slice(0, mark) : text, tk, [...skipped, ...judged], [...own, ...pics], groupSeen, upKey); // a song title names no work
      return [...ownOpen.filter(keep).sort(order), ...picOnly.filter(keep).sort(order)];
    }

    // Names the matcher is unsure about (docs/agents/contract.md): title-like names of the own text the rules did not
    // accept -> [{ g, s, e, o }] (group, character offsets, o = 1 when the name is `other`: mostly a person, place or
    // brand), at most 4, most popular group first, one per group. text: the post's own text (before the OCR marker);
    // names: skipped and judged candidates (OCR ones carry c.ocr); accepted: the groups the rules accepted.
    unsureNames(text, tk, names, accepted, groupSeen, upKey = '') {
      const groups = this.meta.groups, okSpans = names.filter((c) => c.ok && !c.ocr);
      // shortcut: the context model is English-only, so a lowercase single word of a post with a non-ASCII letter
      // ("kaos", "turistas") is not asked; a non-English post written without diacritics is not caught. Lift it when the
      // model is multilingual.
      const foreign = /(?![a-zA-Z])\p{L}/u.test(text);
      // and a name typed all in lowercase only in a post with an English function word outside the name ("Gezinmeyi atla"
      // is Turkish written in ASCII); a name with a capital is not held to it ("Halo Lore Stanley Plays")
      const own = tk.starts.findIndex((st) => st >= text.length), ownEnd = own < 0 ? tk.toks.length : own;
      const english = (c) => /\p{Lu}/u.test(text.slice(c.s, c.e)) ||
        tk.toks.some((t, j) => j < ownEnd && (j < c.h.i || j >= c.h.i + c.h.n) && EN_WORDS.has(t));
      const pool = names.filter((c) => c.title && !c.ok && !c.ocr && !(upKey && c.key === upKey) && english(c) && // never the uploader's name
        !(foreign && c.h.n === 1 && !/^\p{Lu}/u.test(text.slice(c.s))) &&
        !tk.toks.slice(c.h.i, c.h.i + c.h.n).every((t) => /^\d+$/.test(t)) && // a bare number
        !(c.h.n === 1 && QUANT.has(c.key) && !/^\p{Lu}/u.test(text.slice(c.s))) && // "it", "her", "no"
        // volume guard: a one-word name that is a top-1000 everyday word or an everyday word naming a work below
        // DISTINCT_POP ("it", "species"); an everyday name of more words naming a less popular work ("the way", "last night"),
        // unless the index finds it strong enough for picture text (two real words: "ocr")
        !(c.h.n === 1 ? c.quiet : c.common && !c.ocrOk));
      // longest first; a name overlapping an accepted name or a longer unsure one is not asked
      pool.sort((a, b) => b.h.n - a.h.n || a.s - b.s);
      const over = (a, b) => a.h.i < b.h.i + b.h.n && b.h.i < a.h.i + a.h.n, taken = [];
      for (const c of pool) if (!okSpans.some((o) => over(c, o)) && !taken.some((o) => over(c, o))) taken.push(c);
      // not a group the rules accepted, a seen group, or a group whose works are all inside an accepted group
      const within = (g) => accepted.some((o) => o !== g && groups[g].length < groups[o].length && groups[g].every((w, i) => i === 0 || groups[o].includes(w, 1)));
      const out = new Map();
      for (const c of taken.sort((a, b) => a.g - b.g || a.s - b.s)) {
        // a quoted song (rule 5) is not asked, nor a name inside it
        if (!c.sung && !out.has(c.g) && !accepted.includes(c.g) && !groupSeen(c.g) && !within(c.g)) out.set(c.g, { g: c.g, s: c.s, e: c.e, o: c.other ? 1 : 0 });
      }
      return [...out.values()].slice(0, 4);
    }

    // The unsure names of text (see unsureNames); reuses the last evaluate() of the same text and groupSeen.
    unsure(text, groupSeen = NONE) {
      if (this.last?.text !== text || this.last.groupSeen !== groupSeen) this.evaluate(text, groupSeen);
      return this.last.unsure;
    }

    // a title-like name inside hit h (another raw hit) names a work of a catalog series that h's group g also has
    seriesInside(hits, h, g, shift) {
      const mine = this.seriesIn([g]);
      return mine.size > 0 && hits.some((o) => o.i >= h.i && o.i + o.n <= h.i + h.n && o.n < h.n &&
        TITLE_LIKE(o.v & (this.fmt >= 1 ? 7 : 15)) && [...this.seriesIn([o.v >>> shift])].some((s) => mine.has(s)));
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
      let type = j < tk.toks.length && tight(j - 1, j) ? typeWord(word(tk, j)) : undefined;
      if (!type && h.i > 0 && tight(h.i - 1, h.i)) type = typeWord(word(tk, h.i - 1));
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
  // Verbs of consuming a work, counted only right before the name ("beat Portal", "finished Severance"; Portuguese
  // "terminei", "zerei" (finished a game))
  const VERBS = new Map([...'beat beating'.split(' ').map((w) => [w, GAME]), ...'binged binging'.split(' ').map((w) => [w, SCREEN]),
    ...'finished finishing completed started starting terminei'.split(' ').map((w) => [w, ALL]), ['zerei', GAME]]);
  // "<name> is/was (such) a/the ... game": a copula, a determiner, then a media word of the work's type before any
  // preposition or conjunction ("Turkey is a great place to shoot a movie" stops at "to"). Turkish needs no copula
  // ("Portal harika bir oyun").
  // subject pronouns are the subject of "is a great movie" themselves ("It was a great movie"); "Us is" is a title
  const SUBJECT = new Set('it this that he she they we you i there here what who which'.split(' '));
  const COPULA = new Set('is was are were es ist war est etait'.split(' '));
  const DET = new Set('a an the such my our your his her their this one un una ein eine einen une um uma bir'.split(' '));
  // single-word names that are determiners, quantifiers or pronouns ("No", "Her", "It")
  const QUANT = new Set([...DET, ...SUBJECT, ...'no any all some more most every each both another other these those'.split(' ')]);
  const STOP = new Set('to of for in on at with about from that which who where when because but and or if than like as by while'.split(' '));
  // an apostrophe suffix that is not English ("'s", "'t", "'ll", "'re", "'ve", "'d", "'m"): Turkish writes one only
  // after a proper name ("Succession'ı", "Hades'e")
  const PROPER = /['’](?!(?:s|t|ll|re|ve|d|m)$)\p{L}+$/iu;
  // words of a sentence about music
  const SONG = new Set(('song songs album albums track tracks rendition renditions listen listened listening lyrics lyric ' +
    'sing sings sang singing singer singers verse verses chorus playlist gig gigs jazz punk bluegrass melody melodies').split(' '));
  const SPORT = new Set(('stadium stadiums stade estadio stadion league leagues ligue liga coach tournament playoffs playoff ' +
    'striker goalkeeper midfielder referee derby nba nfl nhl mlb uefa').split(' '));
  const SPORTY = /^(?:seasons?|saisons?|temporadas?|stagione|staffel|games?|jeux?|juego|jogo|spiel|gioco|match|sezon|oyun|oyn)/;
  const COMPANY = new Set('stock stocks shares earnings ipo'.split(' ')); // a name before these is the company's
  const LINK = new Set(['of', 'and', 'the']); // words inside a longer name ("Department of Parks and Recreation")
  function described(tk, sent, j, si, mask, everyday) {
    const cop = sent[j] === si && COPULA.has(tk.toks[j]);
    if (cop) j++;
    let det = false;
    for (let k = j; k < Math.min(tk.toks.length, j + 8) && sent[k] === si; k++) {
      const t = word(tk, k);
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
  // token j as evidence: nothing when it lies inside a handle (tk.hid, set by evaluate)
  const word = (tk, j) => (tk.hid?.[j] ? '' : tk.toks[j]);
  function contextMask(t) {
    const m = CONTEXT.get(t);
    if (m !== undefined) return m;
    if (SXEX.test(t)) return EPIS;
    for (const [stem, mask] of STEMS) if (t.startsWith(stem)) return mask;
    return 0;
  }
  // hit h is in Title Case: its first word and every other word not a function word capitalised, two of 3+ letters
  function titleCase(text, tk, h) {
    let caps = 0;
    for (let j = h.i; j < h.i + h.n; j++) {
      if (/^[\p{Lu}\p{N}]/u.test(text.slice(tk.starts[j]))) { if (tk.toks[j].length >= 3) caps++; }
      else if (j === h.i || !(STOP.has(tk.toks[j]) || DET.has(tk.toks[j]))) return false;
    }
    return caps >= 2;
  }
  function isQuoted(text, s, e) {
    // a closing apostrophe followed by a letter is part of a word ("It's"), not a quote; a comma or a full stop may come
    // before the closing quote ('"Jailhouse Rock,"')
    return /["“'‘«*_]/.test(text[s - 1] ?? '') && /^[,.!?;:]?["”'’»*_]/.test(text.slice(e, e + 2)) && !/^['’]\p{L}/u.test(text.slice(e, e + 3));
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
