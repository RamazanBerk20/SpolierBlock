// Catalog rules shared by the full Wikidata build (tools/catalog/build.mjs) and the extension's opt-in delta
// update (src/background/catalog-update.js). Query texts are part of the contract: the Node build caches results
// by query text, so changing a string here invalidates that cache.

// roots queried directly; "deep" roots also pull all their P279+ subclasses (e.g. animated film under film)
export const TYPES = {
  movie: { roots: ['Q11424', 'Q202866', 'Q29168811', 'Q229390', 'Q506240'], deep: ['Q11424'] },
  tv: { roots: ['Q5398426', 'Q1259759', 'Q117467246'], deep: ['Q5398426', 'Q1259759'] },
  game: { roots: ['Q7889', 'Q4393107', 'Q209163'], deep: ['Q7889'] },
  book: { roots: ['Q7725634', 'Q8261', 'Q1667921', 'Q277759'], deep: ['Q8261', 'Q1667921', 'Q277759'] },
  anime: { roots: ['Q63952888', 'Q20650540'], deep: ['Q63952888', 'Q20650540'] },
  manga: { roots: ['Q21198342'], deep: ['Q21198342'] },
  comic: { roots: ['Q14406742'], deep: ['Q14406742'] },
};
export const EXCLUDE = new Set(['Q24856']); // film series
export const PRIORITY = ['anime', 'tv', 'movie', 'game', 'manga', 'comic', 'book']; // first wins when a work has several types
export const MIN_SITELINKS = 15;

export const qid = (uri) => uri.split('/').pop();
export const yearOf = (s) => { const m = /^(\d+)-/.exec(s ?? ''); return m ? Number(m[1]) : null; };
export const cleanTitle = (t) => !/^\d+$/.test(t.trim()) && [...t.trim()].length > 1;
export const batches = (arr, n = 200) => Array.from({ length: Math.ceil(arr.length / n) }, (_, i) => arr.slice(i * n, i * n + n));
const values = (b) => b.map((i) => 'wd:' + i).join(' ');

export const subclassQuery = (root) => `SELECT ?c WHERE { ?c wdt:P279+ wd:${root} }`;
export const yearsQuery = (b) => `SELECT ?w ?d WHERE { VALUES ?w { ${values(b)} } { ?w wdt:P577 ?d } UNION { ?w wdt:P580 ?d } UNION { ?w wdt:P571 ?d } }`;
export const aliasQuery = (b) => `SELECT ?w ?a WHERE { VALUES ?w { ${values(b)} } ?w skos:altLabel ?a . FILTER(LANG(?a) IN ("en", "mul")) }`;
// Characters that are real people (Q5: "Steve Jobs", "Charles de Gaulle") are left out: their names mean the person.
export const charQuery = (b) => `SELECT ?w ?cl ?cs WHERE { VALUES ?w { ${values(b)} } ?w wdt:P674 ?c . FILTER NOT EXISTS { ?c wdt:P31 wd:Q5 } ?c rdfs:label ?cl . FILTER(LANG(?cl) IN ("en", "mul")) OPTIONAL { ?c wikibase:sitelinks ?cs } }`;
export const charFallbackQuery = (b) => `SELECT ?w ?cl ?cs WHERE { VALUES ?w { ${values(b)} } ?c wdt:P1441 ?w ; wdt:P31 wd:Q95074 ; rdfs:label ?cl . FILTER(LANG(?cl) IN ("en", "mul")) OPTIONAL { ?c wikibase:sitelinks ?cs } }`;

// ---- what a work is: narrative or not (catalog build and update) ----
// Instance of (P31), genre (P136) and form (P7937) of works.
export const kindQuery = (b) => `SELECT ?w ?p ?v WHERE { VALUES ?w { ${values(b)} } VALUES ?p { wdt:P31 wdt:P136 wdt:P7937 } ?w ?p ?v }`;
// Works where a spoiler makes no sense: scripture, reference works, most non-fiction, documentaries, news and talk
// shows. An explicit list: Wikidata's subclass trees are too loose for this (they put "biographical film" under
// non-fiction and "mockumentary" under documentary). Matched against P31, P136 and P7937.
export const NOT_NARRATIVE = new Set((
  // scripture and religious texts
  'Q179461 Q29154430 Q6718887 Q10642135 Q170207 Q34274 Q1054662 Q1001051 Q1194040 Q47148 Q209680 Q188602 Q2986441 ' +
  'Q215495 Q63203971 Q21848887 Q1147354 Q3831847 Q7831615 Q938714 Q1377898 Q208628 Q12378012 Q1924246 ' +
  // reference works
  'Q13136 Q5292 Q23622 Q4942969 Q1787111 Q521983 Q1239328 Q975413 Q162827 Q1459574 Q2352616 Q18168594 Q223638 ' +
  'Q2191807 Q198614 Q1631107 Q615699 Q30721375 Q55594435 Q3136090 Q1429277 ' +
  // non-fiction books
  'Q213051 Q27801 Q35760 Q384515 Q864737 Q185363 Q11080698 Q30277550 Q4465563 Q116513838 Q124409385 Q36279 Q4184 ' +
  'Q112983 Q5891 Q13408937 Q1683266 Q995600 Q1129795 Q11826511 Q193495 Q6498453 Q58854 Q1748756 Q190399 ' +
  // documentaries, news, talk and factual shows
  'Q93204 Q7603925 Q133731271 Q133731263 Q1760864 Q110593123 Q1800833 Q3648909 Q4765076 Q430525 Q1358344 ' +
  'Q139850703 Q5401282 Q622812 Q986699 Q131762936 Q6645282 Q3546572 Q7257679 Q5428822 Q10676514 Q2670855 Q7832972 ' +
  'Q126914943 Q7551149 Q4677832 Q2096046 Q1371394 Q116763393 Q34682961 ' +
  // live events and non-story programmes: contests, award ceremonies, game and quiz shows, variety and sketch shows,
  // albums and music videos. Reality competitions, talent shows and wrestling stay: their results are spoilers.
  'Q1955280 Q4504495 Q846662 Q2123557 Q336181 Q743934 Q5778915 Q482994 Q209939 Q10590726 Q20089094 Q193977 Q20135338').split(' '));
// ...unless it is also told as a story: novel, novella, short story, play, light novel, novel series, fiction, or a
// fiction film genre (drama, comedy, comedy-drama, crime, thriller, action, romance, horror, science fiction)
// ...or a reality competition or talent show, whose results are spoilers
// ...or a graphic novel: a graphic memoir or biography ("Maus", "Persepolis") is told as a story
const NARRATIVE = new Set(('Q8261 Q149537 Q49084 Q25379 Q1279564 Q104213567 Q1667921 Q8253 ' +
  'Q130232 Q157443 Q859369 Q959790 Q2484376 Q188473 Q1054574 Q200092 Q471839 Q182415 Q1484397 Q106603795 Q725377').split(' '));
export const isNarrative = (vals) => !vals.some((v) => NOT_NARRATIVE.has(v)) || vals.some((v) => NARRATIVE.has(v));

// ---- names that mostly mean something else (catalog build and update) ----
// Items with the exact English or "mul" label (prop rdfs:label) or alias (skos:altLabel: "Oppenheimer", "Elvis",
// "PSG"), their sitelinks and classes.
export const senseQuery = (names, prop = 'rdfs:label') => `SELECT ?l ?e ?sl (GROUP_CONCAT(DISTINCT ?c) AS ?cs) WHERE { VALUES ?l { ${
  names.flatMap((n) => [JSON.stringify(n) + '@en', JSON.stringify(n) + '@mul']).join(' ')} } ?e ${prop} ?l ; wikibase:sitelinks ?sl . FILTER(?sl >= ${MIN_SITELINKS}) OPTIONAL { ?e wdt:P31 ?c } } GROUP BY ?l ?e ?sl`;
// Classes that are not a meaning of their own: disambiguation pages, lists, categories, templates, name lists
export const NOT_A_SENSE = new Set('Q4167410 Q13406463 Q4167836 Q11266439 Q15407973 Q22808320 Q17362920'.split(' '));
// Classes of works and fictional things: the same sense as a work (a franchise, a character, a series). With their
// subclasses they ship as catalog-classes.json "sameSense" for the update.
export const SAME_SENSE_ROOTS = ['Q14897293', 'Q196600', 'Q7058673', 'Q24856', 'Q15416'];
export const SENSE_BATCH = 150; // names per query
// aliases are looked up only for names of one or two words (a surname, "PSG"): longer ones make slow queries
export const shortName = (n) => n.trim().split(/\s+/).length <= 2;
// prefix: seriesPrefix of src/shared/build-index.js
export const senseNames = (w, prefix) => [w.title, ...(w.aliases ?? []), ...(w.characters ?? []), prefix(w.title)].filter(Boolean);
// rows: senseQuery answers -> otherPop (name -> sitelinks of its strongest sense that is not a work of the catalog
// (inCatalog), a disambiguation page or a work/fictional class (sameSense))
export function addSenses(otherPop, rows, inCatalog, sameSense) {
  for (const r of rows) {
    const cs = r.cs?.value ? r.cs.value.split(' ').map(qid) : [];
    // a work left out of the catalog (a contest, scripture) is a sense of its own
    if (inCatalog.has(qid(r.e.value)) || cs.some((c) => NOT_A_SENSE.has(c)) || (cs.some((c) => sameSense.has(c)) && isNarrative(cs))) continue;
    otherPop.set(r.l.value, Math.max(otherPop.get(r.l.value) ?? 0, Number(r.sl.value)));
  }
}
// The names of w that mostly mean something else. A name that could not be looked up (looked(n) false) counts as one
// when it has one or two words: fail safe, a wrongly weak title costs less than a Palestine-style false block.
export function otherNames(w, names, otherPop, looked = () => true) {
  return [...new Set(names.filter((n) => (looked(n) ? (otherPop.get(n) ?? 0) > w.pop : shortName(n))))];
}
export const CHAR_MIN_POP = 40; // characters are only fetched for works this popular

// text: contents of tools/catalog/common-words.txt (20k.txt plus subtitle words of seven languages, see words.mjs)
export function makeAmbiguous(text) {
  const lines = text.split(/\s+/).filter(Boolean);
  const common = new Set(lines), top1k = new Set(lines.slice(0, 1000));
  const words = (t) => t.toLowerCase().split(/\s+/).map((x) => x.replace(/[^\p{L}\p{N}]/gu, '')).filter(Boolean);
  return (t) => {
    const w = words(t);
    return [...t].length < 4 || (w.length === 1 && common.has(w[0])) || (w.length === 2 && w.every((x) => top1k.has(x)));
  };
}

// w: { id, title, type, years: number[], pop }; aliasPairs: [label, 0 for en | 1 for mul][]; charPairs: [label, sitelinks][]
export function finalizeWork(w, aliasPairs, charPairs, ambiguous) {
  const tl = w.title.toLowerCase();
  const seen = new Set();
  let aliases = (aliasPairs ?? []).sort((a, b) => a[1] - b[1]).map(([a]) => a) // en first, then mul
    .filter((a) => a.length >= 3 && a.toLowerCase() !== tl && !seen.has(a.toLowerCase()) && seen.add(a.toLowerCase()));
  if (aliases.length > 8) aliases = aliases.sort((a, b) => a.length - b.length); // abbreviations first
  aliases = aliases.slice(0, 8);
  const cs = (charPairs ?? []).filter(([n]) => n.trim().split(/\s+/).length >= 2 && n.length >= 6).sort((a, b) => b[1] - a[1]);
  const characters = [...new Set(cs.map(([n]) => n))].slice(0, 8);
  return { id: w.id, title: w.title, type: w.type, year: w.years.length ? Math.min(...w.years) : null, aliases, characters, pop: w.pop, ambiguous: ambiguous(w.title) };
}
export const compareWorks = (a, b) => b.pop - a.pop || a.id.localeCompare(b.id, 'en', { numeric: true });

// ---- series membership ("More from this series", docs/agents/contract.md) ----
// Wikidata "part of the series" (P179) and "media franchise" (P8345) of works. tools/catalog/series.mjs rolls them up
// to one series per franchise and writes the catalog's `series` table: { seriesId: [label, ...the Wikidata series ids
// that map to it] }. Works keep the series ids in `series`.
export const seriesQuery = (b) => `SELECT ?w ?p ?s WHERE { VALUES ?w { ${values(b)} } VALUES ?p { wdt:P179 wdt:P8345 } ?w ?p ?s }`;
const WORDCH = /[\p{L}\p{N}]/u;
// A work Wikidata links to no series joins one by its title. A name of two words or more (not counting a leading
// article) joins when the title starts with it followed by the end, a space, a digit, a colon or a dash ("Resident
// Evil: Vendetta"), or ends with it after a word boundary, with no colon or dash before it ("Return to Silent Hill";
// not "Ivan Vasilievich: Back to the Future"). shortcut: a title equal to a series name joins it whatever its type
// ("The House of the Dead", the novel, joins the game series); add a year or type check if such joins show up. A one-word name is weak
// ("Red", "Taxi", "Sherlock Holmes: A Game of Shadows" against BBC's "Sherlock"): it must not be an everyday word, the
// series must hold a work of the same type, and the title must be the name alone or the name followed by a number, a
// colon or a dash ("Underworld: Rise of the Lycans"). cands: [{ id, label, size, types: Set }] of series with 2+
// works; common(word) -> true for everyday words. -> series id or null; the longest name wins, then the bigger series.
export function titleSeries(title, type, cands, common = () => false) {
  const t = title.toLowerCase();
  let best = null;
  for (const c of cands) {
    const l = c.label.toLowerCase(), words = l.trim().split(/\s+/), n = words.length - (/^(the|a|an)$/.test(words[0]) ? 1 : 0);
    if (!l || (n < 2 && (!c.types.has(type) || common(words[words.length - 1])))) continue;
    let ok = t.startsWith(l) && (n >= 2 ? t.length === l.length || /[ 0-9:\-–—]/.test(t[l.length]) : /^( *[:\-–—]| *[0-9]|$)/.test(t.slice(l.length)));
    const i = t.length - l.length; // "Return to Silent Hill": the name ends the title and no subtitle comes before it
    if (n >= 2 && !ok && i > 0 && t.endsWith(l) && !WORDCH.test(t[i - 1]) && !/[:\-–—]/u.test(t.slice(0, i))) ok = true;
    if (ok && (!best || l.length > best.label.length || (l.length === best.label.length && c.size > best.size))) best = c;
  }
  return best?.id ?? null;
}
// The title-fallback candidates of a catalog: its series with 2+ works.
export function seriesCandidates(table, works) {
  const size = new Map(), types = new Map();
  for (const w of works) for (const s of w.series ?? []) {
    size.set(s, (size.get(s) ?? 0) + 1);
    (types.get(s) ?? types.set(s, new Set()).get(s)).add(w.type);
  }
  return Object.keys(table ?? {}).filter((s) => size.get(s) >= 2).map((s) => ({ id: s, label: table[s][0], size: size.get(s), types: types.get(s) }));
}
// New works (catalog update): Wikidata series ids (links: id -> raw ids) -> the catalog's series via its table, else
// the title fallback. Sets work.series.
export function assignSeries(works, links, table, cands, common) {
  const toSeries = new Map();
  for (const [s, [, ...raw]] of Object.entries(table ?? {})) for (const r of [s, ...raw]) (toSeries.get(r) ?? toSeries.set(r, []).get(r)).push(s);
  for (const w of works) {
    const ss = [...new Set((links.get(w.id) ?? []).flatMap((r) => toSeries.get(r) ?? []))];
    const t = ss.length ? null : titleSeries(w.title, w.type, cands, common);
    if (ss.length) w.series = ss; else if (t) w.series = [t];
  }
}
