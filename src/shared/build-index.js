// Compiles a catalog into the matcher index: index.bin (hash table, see src/content/matcher.js) and
// index.json (per-work columns sorted by popularity, plus name groups).
// A name (title, alias, character, derived series prefix) maps to ONE group: every work carrying it.
// "Dune" -> book + both films + game; "Star Wars" (derived from "Star Wars: Episode IV – ...") -> all films.
// Pure ESM, shared by the Node build (tools/build-index.mjs) and the extension's in-browser catalog update
// (src/background/catalog-update.js), so both produce byte-identical indexes from the same catalog.
import '../content/matcher.js';
const { tokenize, buildIndexBinary, KIND, MAX_N } = globalThis.SBMatcher;

export function sortWorks(catalog) {
  return [...catalog.works].sort((a, b) => (b.pop ?? 0) - (a.pop ?? 0));
}

let common = new Set(); // the catalog's common-word list (tools/catalog/common-words.txt), used by the ambiguity rules
let everyday = null, top1k = null;
// text: the contents of common-words.txt (one word per line; the first 20k are English, most frequent first)
export function setCommonWords(text) {
  common = new Set(text.split('\n').map((w) => w.trim().toLowerCase()));
  everyday = top1k = top3k = null;
}
const commonWords = () => common;
export const COMMON_POP = 60; // measured with tools/fp-text.mjs
const RULES = !globalThis.process?.env?.SB_NO_COMMON_RULE; // measurement switch for tools/fp-text.mjs "before" numbers
const isCommon = (t) => /^\d+$/.test(t) || commonWords().has(t);
// "everyday word" for numbered short names: the 10k most frequent words (the 20k list also holds "gta", "halo")
const isEveryday = (t) => (everyday ??= new Set([...commonWords()].slice(0, 10000))).has(t);
// the most frequent words ("it", "lost", "home"): as a single-word name always "common", however popular the work
let top3k = null;
const isTop3k = (t) => (top3k ??= new Set([...commonWords()].slice(0, 3000))).has(t);
const isTop1k = (t) => (top1k ??= new Set([...commonWords()].slice(0, 1000))).has(t);
export const SERIES_SPLIT = /:| – | — | - /;
// Series prefix of a title, or null. Ambiguous prefixes (single common word or < 4 chars) are never derived.
export function seriesPrefix(title) {
  const parts = title.split(SERIES_SPLIT);
  if (parts.length < 2) return null;
  const p = parts[0].trim(), t = tokenize(p).toks;
  if (!t.length || (t.length === 1 && (t[0].length < 4 || commonWords().has(t[0])))) return null;
  return p;
}

// Sequel numerals 2..20. "I" is never one, and a numeral only counts after at least one other word.
const ROMAN = ['ii', 'iii', 'iv', 'v', 'vi', 'vii', 'viii', 'ix', 'x', 'xi', 'xii', 'xiii', 'xiv', 'xv', 'xvi', 'xvii', 'xviii', 'xix', 'xx'];
const TO_ARABIC = new Map(ROMAN.map((r, i) => [r, String(i + 2)]));
const TO_ROMAN = new Map(ROMAN.map((r, i) => [String(i + 2), r]));
const isSeq = (t, j) => j > 0 && (TO_ARABIC.has(t) || TO_ROMAN.has(t));
// Written forms of a title/alias: the original, Roman <-> Arabic sequel numbers ("Grand Theft Auto VI" ->
// "grand theft auto 6"), and for "<one word> <number>" the joined forms ("GTA VI" -> "gta6", "gtavi").
// free: the name may match in any case ("gta 6", "gta6") - a numbered name of a popular work, or a non-everyday
// short word + number of at least 4 characters. Everything else keeps the usual case/corroboration rules.
export function nameVariants(str, low) {
  const t = tokenize(String(str)).toks;
  if (!t.some(isSeq)) return [{ text: t.join(' '), free: false, orig: true }];
  const base = t.filter((x, j) => !isSeq(x, j));
  const free = base.length >= 2 ? !low : base.length === 1 && !(RULES && isEveryday(base[0])) && base[0].length >= 3;
  // numbered: a sequel number after a word outside the 1k most frequent ("Rocky 2", "Final Fantasy 7") is evidence
  // enough not to need corroboration; "Chapter 6", "Windows 11", "Part 2" keep needing it.
  const numbered = !(RULES && base.every(isTop1k));
  const swapped = t.map((x, j) => (isSeq(x, j) ? TO_ARABIC.get(x) ?? TO_ROMAN.get(x) : x));
  const out = [{ text: t.join(' '), free, numbered, orig: true }, { text: swapped.join(' '), free, numbered }];
  if (t.length === 2 && isSeq(t[1], 1)) for (const n of [t[1], swapped[1]]) out.push({ text: t[0] + n, free, numbered, joined: true });
  return out;
}

// The tokenizer splits words at an apostrophe ("Schindler's List" -> "schindler s list"); text written without it
// ("Schindlers List") needs the joined form too.
const possessive = (s) => (/['’]/.test(s) ? [s, s.replace(/['’]/g, '')] : [s]);

// "Battlefield" of "Battlefield 4", "Battlefield V", "Battlefield 2042": the title without a final number, or null.
export function numberedStem(title) {
  const m = /^(.*\S)\s+(\d+|[IVXivx]+)$/u.exec(title.trim());
  if (!m || (!/^\d+$/.test(m[2]) && !TO_ARABIC.has(m[2].toLowerCase()))) return null;
  return tokenize(m[1]).toks.some((x) => x.length >= 4 && /^\p{L}+$/u.test(x)) ? m[1] : null;
}
// function words that do not make a name strong in text read from pictures ("THE MASTER" has one real word)
const LIGHT = new Set('the and for you are was his her its our not but all any who how why what with from this that new one two'.split(' '));

// Kind precedence when one name plays several roles: the most title-like wins.
const RANK = { [KIND.TITLE]: 0, [KIND.SERIES]: 1, [KIND.ALIAS]: 2, [KIND.CHAR]: 3, [KIND.CHAR1]: 4, [KIND.PART]: 5, [KIND.TAG]: 6 };

export function buildIndex(catalog) {
  const works = sortWorks(catalog);
  const keys = new Map(); // key -> { works: Set, kind, amb, label, labelRank }
  // oth: this name of work w mostly means something else in the world (work.other, see tools/catalog/build.mjs). A key
  // is "other" only when that holds for every work carrying it: a more popular work of the same name outweighs it.
  // orig: the name as written (not a sequel-number swap or a joined form, which never count in OCR text)
  const add = (str, w, kind, label, free = false, numbered = false, oth = false, orig = true) => {
    const t = tokenize(String(str)).toks;
    if (!t.length || t.length > MAX_N || (t.length === 1 && t[0].length < 2)) return;
    if ((kind === KIND.CHAR || kind === KIND.PART) && t.length === 1) {
      if (t[0].length < 4) return;
      if (kind === KIND.CHAR) kind = KIND.CHAR1;
    }
    if (RULES && kind === KIND.ALIAS && t.length === 1 && isCommon(t[0])) return; // "Ultimate", "Family": never evidence
    const key = kind === KIND.TAG ? t.join('') : t.join(' ');
    let e = keys.get(key);
    if (!e) keys.set(key, e = { works: new Set(), kind, amb: 0, label, labelRank: RANK[kind], oth: true });
    e.works.add(w);
    if (kind !== KIND.PART && kind !== KIND.CHAR1) e.oth &&= oth;
    if (free) e.free = true;
    if (numbered) e.numbered = true;
    if (orig) e.orig = true;
    if (RANK[kind] < RANK[e.kind]) e.kind = kind;
    if (RANK[kind] < e.labelRank) { e.label = label; e.labelRank = RANK[kind]; }
    if ((kind === KIND.TITLE || kind === KIND.ALIAS) && works[w].ambiguous) e.amb = 1;
  };

  const prefixCount = new Map();
  for (const w of works) {
    const p = seriesPrefix(w.title) ?? numberedStem(w.title);
    if (p) { const k = tokenize(p).toks.join(' '); prefixCount.set(k, (prefixCount.get(k) ?? 0) + 1); }
  }
  const seriesOf = new Map(); // workIdx -> series label
  works.forEach((w, i) => {
    const low = (w.pop ?? 0) < COMMON_POP, other = new Set(w.other ?? []);
    for (const v of possessive(w.title).flatMap((f) => nameVariants(f, low))) {
      add(v.text, i, v.joined ? KIND.ALIAS : KIND.TITLE, w.title, v.free, v.numbered, other.has(w.title), !!v.orig);
      if (!v.joined && v.text.includes(' ')) add(v.text, i, KIND.TAG, w.title, false, false, other.has(w.title)); // #GrandTheftAuto6
    }
    // a series: the part before a colon shared by 2+ titles ("Star Wars"), or a name numbered in 3+ titles ("Battlefield")
    const sp = seriesPrefix(w.title), p = sp ?? numberedStem(w.title);
    if (p && prefixCount.get(tokenize(p).toks.join(' ')) >= (sp ? 2 : 3)) {
      add(p, i, KIND.SERIES, p, false, false, other.has(p)); add(p, i, KIND.TAG, p, false, false, other.has(p)); seriesOf.set(i, p);
    }
    for (const a of w.aliases ?? []) for (const v of possessive(a).flatMap((f) => nameVariants(f, low))) add(v.text, i, KIND.ALIAS, w.title, v.free, v.numbered, other.has(a), !!v.orig);
    for (const c of w.characters ?? []) {
      add(c, i, KIND.CHAR, w.title, false, false, other.has(c));
      // "Snape", "Dumbledore": parts of full names are weak signals (need corroboration, see matcher)
      const parts = tokenize(c).toks;
      // everyday-word parts ("King", "Charles", "England") are too frequent to be evidence
      if (parts.length > 1) for (const t of parts) if (t.length >= 4 && !(RULES && isCommon(t))) add(t, i, KIND.PART, w.title);
    }
  });

  // Groups: dedupe identical (label, works); order by most popular member, bigger group first on ties.
  const gmap = new Map(), groups = [];
  for (const e of keys.values()) {
    const ws = [...e.works].sort((a, b) => a - b);
    // a character/alias spanning several works mostly of one series is labelled with it ("Darth Vader" -> "Star Wars")
    if (e.labelRank > RANK[KIND.SERIES] && ws.length > 1 && seriesOf.has(ws[0])) {
      const sl = seriesOf.get(ws[0]);
      if (ws.filter((w) => seriesOf.get(w) === sl || works[w].title === sl).length * 2 >= ws.length) e.label = sl; // majority
    }
    const id = e.label + '\u0001' + ws.join(',');
    if (!gmap.has(id)) { gmap.set(id, groups.length); groups.push({ label: e.label, ws, titleLike: false }); }
    e.g = gmap.get(id);
    if (e.kind === KIND.TITLE || e.kind === KIND.SERIES) groups[e.g].titleLike = true;
  }
  const order = groups.map((_, i) => i).sort((a, b) => groups[a].ws[0] - groups[b].ws[0] || groups[b].ws.length - groups[a].ws.length);
  const newIdx = new Array(groups.length);
  order.forEach((old, i) => { newIdx[old] = i; });

  const entries = new Map();
  // "common": a name made only of everyday words whose most popular work is below COMMON_POP ("The Walk",
  // "In the Park", "Friday"). Such names need the Title-Case form plus corroboration, see matcher.
  // Single everyday-word aliases ("Forest", "Capital") and bare numbers ("2010") qualify at any popularity, as does
  // a single everyday-word title of a less popular work.
  for (const [key, e] of keys) {
    const t = key.split(' ');
    const low = (works[groups[e.g].ws[0]].pop ?? 0) < COMMON_POP, titleLike = e.kind === KIND.TITLE || e.kind === KIND.ALIAS || e.kind === KIND.SERIES;
    const one = t.length === 1;
    // single-word titles are already flagged by the catalog's own ambiguity rule; aliases/series are not
    // a character name made of everyday words only ("The Sheep", "Thing One") is treated like such a title
    const plainChar = RULES && e.kind === KIND.CHAR && t.every(isCommon) && (t[0] === 'the' || t.every(isTop3k));
    const numeric = t.every((x) => !/\p{L}/u.test(x)); // "10.5", "1917", "300": need a media word or quotes
    const common = plainChar || (RULES && titleLike && (numeric || (!e.free && !e.numbered && (one ? isCommon(t[0]) && (low || e.kind !== KIND.TITLE || isTop3k(t[0])) : low && t.every(isCommon))))) ? 1 : 0;
    // "rare": a single uncommon word naming a less popular work ("Bloodborne", "Telefon"). Not an everyday word, but
    // weak: it needs a media word in its sentence. When it mostly names something else the "other" flag says so.
    const rare = RULES && titleLike && one && low && !common && !e.free ? 1 : 0;
    // "cap": must appear in Title Case; only popular multi-word names with a distinctive word ("game of thrones")
    // may be written in lowercase
    const cap = plainChar || (RULES && titleLike && !e.free && (one || low || t.every(isCommon))) ? 1 : 0;
    const other = RULES && e.oth && e.kind !== KIND.PART && e.kind !== KIND.CHAR1 ? 1 : 0;
    // "ocr": strong enough in text read from pictures, where case proves nothing. Two words or more as written, and:
    // two real words ("RESIDENT EVIL"; for a less popular work not two very frequent ones), one rare word in a popular
    // name ("THE MANDALORIAN"), or a numbered title whose name is not an everyday word ("BATTLEFIELD 4"; not "GEN 5",
    // which only exists as the swapped form of "Gen V"). Never a name that mostly means something else.
    const real = t.filter((x) => x.length >= 3 && /^\p{L}+$/u.test(x) && !LIGHT.has(x));
    const num = t.length >= 2 && (/^\d+$/.test(t[t.length - 1]) || TO_ARABIC.has(t[t.length - 1]));
    const ocr = RULES && e.orig && !other && t.length >= 2 && (titleLike || e.kind === KIND.CHAR) &&
      ((real.length >= 2 && !(e.amb && low)) || (real.length === 1 && !low && !isCommon(real[0])) ||
       (num && real.some((x) => x.length >= 4 && !isTop3k(x)))) ? 1 : 0;
    entries.set(key, (newIdx[e.g] << 9) | (ocr << 8) | (rare << 7) | (cap << 6) | (common << 5) | (e.amb << 4) | (other << 3) | e.kind);
  }
  const sorted = order.map((i) => groups[i]);
  const meta = {
    ids: works.map((w) => w.id),
    titles: works.map((w) => w.title),
    types: works.map((w) => w.type),
    years: works.map((w) => w.year ?? 0),
    groups: sorted.map((g) => [g.label, ...g.ws]),
  };
  // Groups that name a work or series (not characters/aliases), most popular first: the CLIP row candidates.
  const titleGroups = sorted.map((g, i) => (g.titleLike ? i : -1)).filter((i) => i >= 0);
  return { bin: buildIndexBinary(entries), meta, keys: keys.size, titleGroups, works };
}
