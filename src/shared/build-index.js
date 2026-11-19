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
export const DISTINCT_POP = 45;
const RULES = !globalThis.process?.env?.SB_NO_COMMON_RULE; // measurement switch for tools/fp-text.mjs "before" numbers
export const isCommon = (t) => /^\d+$/.test(t) || commonWords().has(t);
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

const TIER = { [KIND.TITLE]: 0, [KIND.ALIAS]: 1, [KIND.SERIES]: 2, [KIND.CHAR]: 3, [KIND.CHAR1]: 4, [KIND.PART]: 4, [KIND.TAG]: 1 };
const TYPES = ['movie', 'tv', 'game', 'book', 'anime', 'manga', 'comic'];

// Kind precedence when one name plays several roles: the most title-like wins.
const RANK = { [KIND.TITLE]: 0, [KIND.SERIES]: 1, [KIND.ALIAS]: 2, [KIND.CHAR]: 3, [KIND.CHAR1]: 4, [KIND.PART]: 5, [KIND.TAG]: 6 };

export function buildIndex(catalog) {
  const works = sortWorks(catalog);
  const keys = new Map(); // key -> { works: Set, kind, amb, label, labelRank }
  // oth: this name of work w mostly means something else in the world (work.other, see tools/catalog/build.mjs). A key
  // is "other" only when that holds for every work carrying it: a more popular work of the same name outweighs it.
  // orig: the name as written (not a sequel-number swap or a joined form, which never count in OCR text)
  // tier: how close the name is to work w: 0 its title, 1 an alternative name, 2 the series it was derived from,
  // 3 a character, 4 a part of a character's name. A bare name refers to its closest works only (contract).
  const add = (str, w, kind, label, free = false, numbered = false, oth = false, orig = true, tier = TIER[kind]) => {
    const t = tokenize(String(str)).toks;
    if (!t.length || t.length > MAX_N || (t.length === 1 && t[0].length < 2)) return;
    if ((kind === KIND.CHAR || kind === KIND.PART) && t.length === 1) {
      if (t[0].length < 4) return;
      if (kind === KIND.CHAR) kind = KIND.CHAR1;
    }
    if (RULES && kind === KIND.ALIAS && t.length === 1 && isCommon(t[0])) return; // "Ultimate", "Family": never evidence
    const key = kind === KIND.TAG ? t.join('') : t.join(' ');
    let e = keys.get(key);
    if (!e) keys.set(key, e = { works: new Set(), tiers: [], kind, amb: 0, label, labelRank: RANK[kind], oth: true });
    e.works.add(w);
    (e.tiers[tier] ??= new Set()).add(w);
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
  // the series names that qualify; a title whose part before the colon is one of them joins it even when that part is
  // a single everyday word ("Halo: Reach" joins the series "Halo" of "Halo 2", "Halo 3"...)
  const qualified = new Set();
  for (const w of works) {
    const sp = seriesPrefix(w.title), p = sp ?? numberedStem(w.title), k = p && tokenize(p).toks.join(' ');
    if (p && prefixCount.get(k) >= (sp ? 2 : 3)) qualified.add(k);
  }
  const seriesOf = new Map(); // workIdx -> series label
  works.forEach((w, i) => {
    const low = (w.pop ?? 0) < COMMON_POP, other = new Set(w.other ?? []);
    for (const v of possessive(w.title).flatMap((f) => nameVariants(f, low))) {
      add(v.text, i, v.joined ? KIND.ALIAS : KIND.TITLE, w.title, v.free, v.numbered, other.has(w.title), !!v.orig, 0);
      if (!v.joined && v.text.includes(' ')) add(v.text, i, KIND.TAG, w.title, false, false, other.has(w.title), true, 0); // #GrandTheftAuto6
    }
    // a series: the part before a colon shared by 2+ titles ("Star Wars"), or a name numbered in 3+ titles ("Battlefield")
    const sp = seriesPrefix(w.title), raw = w.title.split(SERIES_SPLIT)[0].trim();
    const p = sp ?? numberedStem(w.title) ?? (raw !== w.title.trim() && qualified.has(tokenize(raw).toks.join(' ')) ? raw : null);
    if (p && qualified.has(tokenize(p).toks.join(' '))) {
      add(p, i, KIND.SERIES, p, false, false, other.has(p)); add(p, i, KIND.TAG, p, false, false, other.has(p), true, 2); seriesOf.set(i, p);
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

  // The works a bare name refers to: its closest tier. The name of a franchise also takes its series when the closest
  // works are entries of that series ("Star Wars" is an alternative name of Episode IV) or the series' best work is
  // at least 1.5 times as popular ("Halo": a TV series titled "Halo", the games "Halo: Combat Evolved", "Halo 3"...).
  const pop = (set) => Math.max(...[...set].map((w) => works[w].pop ?? 0));
  const closest = (e) => {
    const k = e.tiers.findIndex(Boolean), s = e.tiers[2];
    if (k < 2 && s && ([...e.tiers[k]].every((w) => s.has(w)) || pop(s) >= 1.5 * pop(e.tiers[k]))) return new Set([...e.tiers[k], ...s]);
    return e.tiers[k];
  };
  // Groups: dedupe identical (label, works); order by most popular member, bigger group first on ties.
  const gmap = new Map(), groups = [];
  const groupOf = (label, ws, titleLike) => {
    const id = label + '\u0001' + ws.join(',');
    if (!gmap.has(id)) { gmap.set(id, groups.length); groups.push({ label, ws, titleLike: false }); }
    const g = gmap.get(id);
    if (titleLike) groups[g].titleLike = true;
    return g;
  };
  const typed = []; // [key, group]: a type word next to the name narrows its group ("the Minecraft movie")
  for (const [key, e] of keys) {
    const near = closest(e), ws = [...near].sort((a, b) => a - b);
    // a character/alias spanning several works mostly of one series is labelled with it ("Darth Vader" -> "Star Wars")
    if (e.labelRank > RANK[KIND.SERIES] && ws.length > 1 && seriesOf.has(ws[0])) {
      const sl = seriesOf.get(ws[0]);
      if (ws.filter((w) => seriesOf.get(w) === sl || works[w].title === sl).length * 2 >= ws.length) e.label = sl; // majority
    }
    if (e.kind !== KIND.TAG && e.tiers.slice(0, 3).some(Boolean)) {
      const all = new Set(e.tiers.slice(0, 3).flatMap((x) => (x ? [...x] : [])));
      for (const type of TYPES) {
        // the closest works of that type, else any works of that type the name belongs to ("Minecraft movie")
        let tw = ws.filter((w) => works[w].type === type);
        if (!tw.length) tw = [...all].filter((w) => works[w].type === type).sort((a, b) => a - b);
        if (!tw.length || (tw.length === ws.length && tw.every((w, i) => w === ws[i]))) continue;
        typed.push([key + ' \u0002' + type, tw.length === 1 ? works[tw[0]].title : e.label, tw]);
      }
    }
    e.g = groupOf(e.label, ws, e.kind === KIND.TITLE || e.kind === KIND.SERIES);
  }
  for (const x of typed) x[1] = groupOf(x[1], x[2], false);
  const order = groups.map((_, i) => i).sort((a, b) => groups[a].ws[0] - groups[b].ws[0] || groups[b].ws.length - groups[a].ws.length);
  const newIdx = new Array(groups.length);
  order.forEach((old, i) => { newIdx[old] = i; });

  // A franchise is as known as its works together: no single "Resident Evil", "God of War" or "Dark Souls" work
  // reaches COMMON_POP, so their everyday-word names were "common" and needed a media word ("Resident Evil is scary"
  // matched nothing). fame: the popularity of the works a name titles, aliases or derives a series from, plus its
  // numbered sequels and subtitled entries ("Dark Souls II", "Dark Souls: Remastered"; not "The Ten Commandments" for
  // "The Ten").
  const startsWith = new Map();
  works.forEach((w, i) => {
    const p = seriesPrefix(w.title) ?? numberedStem(w.title), k = p && tokenize(p).toks.join(' ');
    if (k) (startsWith.get(k) ?? startsWith.set(k, []).get(k)).push(i);
  });
  const fame = (key, e) => {
    let sum = 0;
    for (const w of new Set([...e.tiers.slice(0, 3).flatMap((x) => (x ? [...x] : [])), ...(startsWith.get(key) ?? [])])) sum += works[w].pop ?? 0;
    return sum;
  };
  const entries = new Map();
  // "common": a name made only of everyday words whose most popular work is below COMMON_POP ("The Walk",
  // "In the Park", "Friday"). Such names need the Title-Case form plus corroboration, see matcher.
  // Single everyday-word aliases ("Forest", "Capital") and bare numbers ("2010") qualify at any popularity, as does
  // a single everyday-word title of a less popular work.
  for (const [key, e] of keys) {
    const t = key.split(' ');
    // popularity of a name: its most popular work at any tier (a name's flags do not depend on which works it names)
    const top = works[Math.min(...e.works)].pop ?? 0;
    const low = top < COMMON_POP, titleLike = e.kind === KIND.TITLE || e.kind === KIND.ALIAS || e.kind === KIND.SERIES;
    const one = t.length === 1;
    // a known franchise of two words or more is no everyday phrase; but "The" and one word stays everyday English ("THE
    // FALL OF CONSTANTINOPLE"), and so does a name with no later word of 3+ letters, whose capital the sentence's own
    // can hide ("What if we...")
    const famous = () => !one && !(t[0] === 'the' && t.length === 2) && t.slice(1).some((x) => x.length >= 3) && fame(key, e) >= COMMON_POP;
    // single-word titles are already flagged by the catalog's own ambiguity rule; aliases/series are not
    // a character name made of everyday words only ("The Sheep", "Thing One") is treated like such a title
    const plainChar = RULES && e.kind === KIND.CHAR && t.every(isCommon) && (t[0] === 'the' || t.every(isTop3k));
    const numeric = t.every((x) => !/\p{L}/u.test(x)); // "10.5", "1917", "300": need a media word or quotes
    const common = plainChar || (RULES && titleLike && (numeric || (!e.free && !e.numbered && (one ? isCommon(t[0]) && (low || e.kind !== KIND.TITLE || isTop3k(t[0])) : low && t.every(isCommon) && !famous())))) ? 1 : 0;
    // "rare": a single uncommon word naming a less popular work ("Bloodborne", "Telefon"). Not an everyday word, but
    // weak: it needs a media word in its sentence. When it mostly names something else the "other" flag says so.
    // "rare" (weak): a single uncommon word of a work below DISTINCT_POP. From DISTINCT_POP up such a word ("Arcane",
    // "Minecraft") is a title however it is written, headline or all caps (chosen with tools/fp-posts.mjs on
    // test/fixtures/headlines.jsonl and fp-posts.jsonl, and tools/fp-text.mjs; 45 keeps Arcane)
    const rare = RULES && titleLike && one && top < DISTINCT_POP && !common && !e.free ? 1 : 0;
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
    entries.set(key, (newIdx[e.g] << 9) | (ocr << 8) | (rare << 7) | (cap << 6) | (common << 5) | ((e.amb && !(RULES && famous())) << 4) | (other << 3) | e.kind);
  }
  for (const [key, g] of typed) entries.set(key, (newIdx[g] << 9) | KIND.TITLE); // looked up only next to a type word
  const sorted = order.map((i) => groups[i]);
  // Series (catalog `series` ids, not name groups): the works of each series with 2+ works, oldest first (no year
  // last), in order of each series' most popular work. Read by Matcher.moreFromSeries.
  const bySeries = new Map();
  works.forEach((w, i) => { for (const s of w.series ?? []) (bySeries.get(s) ?? bySeries.set(s, []).get(s)).push(i); });
  const older = (a, b) => (works[a].year || 1e4) - (works[b].year || 1e4) || a - b;
  const meta = {
    ids: works.map((w) => w.id),
    titles: works.map((w) => w.title),
    types: works.map((w) => w.type),
    years: works.map((w) => w.year ?? 0),
    groups: sorted.map((g) => [g.label, ...g.ws]),
    series: [...bySeries.values()].filter((l) => l.length > 1).map((l) => l.sort(older)),
  };
  // Groups that name a work or series (not characters/aliases), most popular first: the CLIP row candidates.
  const titleGroups = sorted.map((g, i) => (g.titleLike ? i : -1)).filter((i) => i >= 0);
  return { bin: buildIndexBinary(entries), meta, keys: keys.size, titleGroups, works };
}
