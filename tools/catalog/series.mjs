// Series membership for the catalog build (step 6 of build.mjs): which works belong to one series or franchise, for
// the picker's "More from this series" (docs/agents/contract.md). Separate from the matcher's name groups.
//
// 1. Each work's Wikidata "part of the series" (P179) and "media franchise" (P8345).
// 2. Only items that are a series or franchise count (SERIES_CLASSES; not lists, rankings, broadcast slots or a
//    studio's whole film canon: NOT_A_SERIES).
// 3. Each series is rolled up through its own P179/P8345 to the topmost series ("Resident Evil" film series and game
//    series -> the "Resident Evil" franchise), but never into one of more than CAP works ("Mario": its works keep
//    "Super Mario", "Mario Kart"...).
// 4. A series most of whose works are in another one is merged into it (the "Gun Survivor" spin-offs into "Resident
//    Evil", Silent Hill's franchise item into its game series), within CAP.
// 5. Works with no series get one by title (titleSeries in src/shared/catalog-rules.js).
import { batches, qid, seriesQuery, titleSeries, seriesCandidates } from '../../src/shared/catalog-rules.js';

export const CAP = 80;
// What a series item is (P31). Checked against the catalog in tools/catalog/series.mjs's first run (2026-11): these
// cover 1,805 of the 1,890 linked items; the rest were lists, rankings, broadcast slots and single works.
export const SERIES_CLASSES = new Set(('Q7058673 Q196600 Q24856 Q277759 Q1667921 Q56884562 Q13593818 Q130371093 Q141546978 ' +
  'Q867335 Q3275581 Q29982285 Q13593966 Q14406742 Q559618 Q113791292 Q47068459 Q18591554 Q2656974 Q7725310 Q1443637 ' +
  'Q614101 Q2617970 Q17710986 Q17710980 Q149010 Q67655225 Q10608125 Q110940888 Q7502092 Q100707163 Q52269333 Q2621812 ' +
  'Q29428439 Q106974458 Q138511811 Q5398426 Q117467246 Q21198342 Q1259759 Q7725634 Q138337574').split(' '));
// lists, broadcast slots, editorial collections
const NOT_SERIES_CLASS = new Set(['Q13406463', 'Q80096233', 'Q2155186', 'Q20655472']);
// a studio's feature films, typed "animated film series" on Wikidata (Walt Disney Animation, DreamWorks, Ghibli)
export const NOT_A_SERIES = new Set(['Q56070713', 'Q26196748', 'Q104830727']);

const vs = (b) => b.map((x) => 'wd:' + x).join(' ');

// -> { links: Map(workId -> raw series ids), info: { id: { cls, up: { P179, P8345, P361 }, label } } }
export async function fetchSeries(ids, sparql) {
  const links = new Map();
  for (const b of batches(ids)) for (const r of await sparql(seriesQuery(b))) {
    const w = qid(r.w.value), s = qid(r.s.value), l = links.get(w) ?? links.set(w, []).get(w);
    if (!l.includes(s)) l.push(s);
  }
  const info = {};
  let todo = [...new Set([...links.values()].flat())];
  for (let depth = 0; depth < 4 && todo.length; depth++) {
    for (const id of todo) info[id] = { cls: [], up: {}, label: null };
    for (const b of batches(todo)) {
      for (const r of await sparql(`SELECT ?s ?c WHERE { VALUES ?s { ${vs(b)} } ?s wdt:P31 ?c }`)) info[qid(r.s.value)].cls.push(qid(r.c.value));
      for (const r of await sparql(`SELECT ?s ?p ?u WHERE { VALUES ?s { ${vs(b)} } VALUES ?p { wdt:P179 wdt:P8345 wdt:P361 } ?s ?p ?u }`)) {
        (info[qid(r.s.value)].up[qid(r.p.value)] ??= []).push(qid(r.u.value));
      }
      for (const r of await sparql(`SELECT ?s ?l WHERE { VALUES ?s { ${vs(b)} } ?s rdfs:label ?l FILTER(LANG(?l) IN ("en", "mul")) }`)) info[qid(r.s.value)].label ??= r.l.value;
    }
    todo = [...new Set(todo.flatMap((id) => Object.values(info[id].up).flat()))].filter((id) => !info[id]);
  }
  return { links, info };
}

const byQid = (a, b) => Number(a.slice(1)) - Number(b.slice(1));

// works: catalog works (sets work.series); common(word): everyday words (titleSeries); -> the catalog's series table { seriesId: [label, ...ids mapped to it] }
export function resolveSeries(works, links, info, common) {
  const good = (s) => !NOT_A_SERIES.has(s) && info[s]?.label && info[s].cls.some((c) => SERIES_CLASSES.has(c)) && !info[s].cls.some((c) => NOT_SERIES_CLASS.has(c));
  const big = new Set();
  const roots = (s, seen) => {
    seen.add(s);
    const ps = ['P179', 'P8345'].flatMap((p) => info[s].up[p] ?? []).filter((p) => good(p) && !seen.has(p) && !big.has(p));
    return ps.length ? [...new Set(ps.flatMap((p) => roots(p, seen)))] : [s];
  };
  let of, rootOf;
  for (let pass = 0; pass < 2; pass++) { // the second pass leaves out the series the first one made too big
    of = new Map(); rootOf = new Map();
    for (const w of works) {
      const raw = (links.get(w.id) ?? []).filter(good);
      for (const r of raw) if (!rootOf.has(r)) rootOf.set(r, roots(r, new Set()));
      if (raw.length) of.set(w.id, [...new Set(raw.flatMap((r) => rootOf.get(r)))]);
    }
    const size = new Map();
    for (const ss of of.values()) for (const s of ss) size.set(s, (size.get(s) ?? 0) + 1);
    for (const [s, n] of size) if (n > CAP) big.add(s);
  }
  // merge a series into the one holding most of its works (smallest first)
  const members = new Map();
  for (const [w, ss] of of) for (const s of ss) (members.get(s) ?? members.set(s, new Set()).get(s)).add(w);
  const into = new Map();
  for (const a of [...members.keys()].sort((x, y) => members.get(x).size - members.get(y).size || byQid(x, y))) {
    const A = members.get(a), count = new Map();
    for (const w of A) for (const b of of.get(w)) if (b !== a && members.has(b)) count.set(b, (count.get(b) ?? 0) + 1);
    let best = null;
    for (const [b, n] of count) if (!best || n > count.get(best) || (n === count.get(best) && byQid(b, best) < 0)) best = b;
    if (!best || count.get(best) * 2 <= A.size || members.get(best).size < A.size) continue;
    const B = members.get(best);
    if (new Set([...A, ...B]).size > CAP) continue;
    for (const w of A) { B.add(w); of.set(w, [...new Set(of.get(w).map((s) => (s === a ? best : s)))]); }
    members.delete(a); into.set(a, best);
  }
  const final = (s) => { while (into.has(s)) s = into.get(s); return s; };
  const table = {};
  for (const s of [...members.keys()].sort(byQid)) table[s] = [info[s].label];
  for (const [r, rs] of [...rootOf].sort((x, y) => byQid(x[0], y[0]))) {
    for (const s of new Set(rs.map(final))) if (r !== s && table[s] && !table[s].includes(r)) table[s].push(r);
  }
  for (const [a] of [...into].sort((x, y) => byQid(x[0], y[0]))) { const s = final(a); if (!table[s].includes(a)) table[s].push(a); }
  for (const w of works) { const ss = of.get(w.id); if (ss) w.series = [...ss].sort(byQid); else delete w.series; }
  // title fallback, against the series as Wikidata gives them
  const cands = seriesCandidates(table, works);
  for (const w of works) if (!w.series) { const t = titleSeries(w.title, w.type, cands, common); if (t) w.series = [t]; }
  return table;
}
