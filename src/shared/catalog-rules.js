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
export const charQuery = (b) => `SELECT ?w ?cl ?cs WHERE { VALUES ?w { ${values(b)} } ?w wdt:P674 ?c . ?c rdfs:label ?cl . FILTER(LANG(?cl) IN ("en", "mul")) OPTIONAL { ?c wikibase:sitelinks ?cs } }`;
export const charFallbackQuery = (b) => `SELECT ?w ?cl ?cs WHERE { VALUES ?w { ${values(b)} } ?c wdt:P1441 ?w ; wdt:P31 wd:Q95074 ; rdfs:label ?cl . FILTER(LANG(?cl) IN ("en", "mul")) OPTIONAL { ?c wikibase:sitelinks ?cs } }`;
export const CHAR_MIN_POP = 40; // characters are only fetched for works this popular

// text: contents of tools/catalog/20k.txt
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
