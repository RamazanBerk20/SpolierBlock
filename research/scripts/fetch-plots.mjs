// Fetches English Wikipedia plot/synopsis/premise sections for eval works + popular distractors (build-time data, test only).
// out: data/plots/plots.json { title: { qid, page, text } }
import fs from 'node:fs';
const R = new URL('..', import.meta.url).pathname;
const UA = { 'user-agent': 'sb-research-eval/0.1 (local evaluation script)' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function get(url) {
  for (let i = 1; i <= 6; i++) {
    let r; try { r = await fetch(url, { headers: UA }); } catch { await sleep(4000 * i); continue; }
    if (r.status === 429 || r.status >= 500) { await sleep(5000 * i); continue; }
    await sleep(500);
    return r.ok ? r.json() : null;
  }
  return null;
}
const cat = JSON.parse(fs.readFileSync(R + '../data/catalog.json')).works;
const byTitle = new Map(); for (const w of [...cat].sort((a, b) => (b.pop ?? 0) - (a.pop ?? 0))) if (!byTitle.has(w.title)) byTitle.set(w.title, w);
const ev = fs.readFileSync(R + 'results/snap/spoiler-eval.jsonl', 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const want = new Set(ev.map((r) => r.work));
['Red Dead Redemption 2', 'Arcane', 'Attack on Titan', 'The Legend of Korra', 'Kaguya-sama: Love Is War'].forEach((t) => want.add(t));
// distractors: most popular catalog works of movie/tv/game/anime types
for (const w of [...byTitle.values()].filter((w) => ['movie', 'tv', 'game', 'anime', 'book'].includes(w.type)).slice(0, 400)) { if (want.size >= 160) break; want.add(w.title); }
const OUT = R + 'data/plots/plots.json';
const out = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT)) : {};
for (const t of want) {
  if (out[t]) continue;
  const w = byTitle.get(t) ?? [...byTitle.values()].find((x) => x.aliases?.includes(t) || x.title.replace(/[:,].*/, '') === t);
  let page = t;
  if (w?.id) { const e = await get(`https://www.wikidata.org/w/api.php?format=json&action=wbgetentities&props=sitelinks&sitefilter=enwiki&ids=${w.id}`); page = e?.entities?.[w.id]?.sitelinks?.enwiki?.title ?? t; }
  const j = await get(`https://en.wikipedia.org/w/api.php?format=json&action=query&prop=extracts&explaintext=1&exsectionformat=wiki&redirects=1&titles=${encodeURIComponent(page)}`);
  const ex = j ? Object.values(j.query.pages)[0]?.extract ?? '' : '';
  // keep sections whose top-level heading looks like a plot/synopsis/story/premise
  const parts = ex.split(/\n(?=== [^=])/), keep = parts.filter((p) => /^== *(Plot|Synopsis|Story|Premise|Summary|Narrative|Setting and plot|Plot summary|Characters and setting)/i.test(p));
  out[t] = { qid: w?.id ?? null, type: w?.type ?? null, page, text: keep.join('\n').replace(/^=+.*=+$/gm, '').trim(), lead: parts[0].slice(0, 1500) };
  fs.writeFileSync(OUT, JSON.stringify(out));
  console.log(t, '|', page, '|', out[t].text.length);
}
