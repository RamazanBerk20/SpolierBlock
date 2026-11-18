// Second pass for series whose main article has no plot section: episode summaries from Wikipedia episode tables
// (td.description cells) of "List of X episodes" and "X season N" pages. Updates data/plots/plots.json (test only).
import fs from 'node:fs';
const R = new URL('..', import.meta.url).pathname;
const UA = { 'user-agent': 'sb-research-eval/0.1 (local evaluation script)' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function parse(page) {
  for (let i = 1; i <= 5; i++) {
    let r; try { r = await fetch(`https://en.wikipedia.org/w/api.php?format=json&action=parse&prop=text&redirects=1&page=${encodeURIComponent(page)}`, { headers: UA }); } catch { await sleep(4000 * i); continue; }
    if (r.status === 429 || r.status >= 500) { await sleep(5000 * i); continue; }
    await sleep(500);
    const j = r.ok ? await r.json() : null;
    return j?.parse?.text?.['*'] ?? null;
  }
  return null;
}
const strip = (h) => h.replace(/<sup[\s\S]*?<\/sup>/g, '').replace(/<[^>]+>/g, '').replace(/&#91;.*?&#93;/g, '').replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, ' ').trim();
const OUT = R + 'data/plots/plots.json';
const plots = JSON.parse(fs.readFileSync(OUT));
for (const [t, p] of Object.entries(plots)) {
  if (p.text.length >= 1500 || p.tv || !['tv', 'anime', null].includes(p.type)) continue;
  const base = p.page.replace(/ \((TV series|American TV series|\d{4} TV series|anime)\)$/, '');
  const pages = [`List of ${base} episodes`, ...[1, 2, 3, 4, 5].map((n) => `${base} season ${n}`)];
  const descs = [];
  for (const pg of pages) {
    const h = await parse(pg);
    if (!h) continue;
    for (const m of h.matchAll(/<td class="description"[^>]*>([\s\S]*?)<\/td>/g)) descs.push(strip(m[1]));
    if (descs.join(' ').length > 30000) break;
  }
  p.text = [p.text, ...new Set(descs)].join('\n').trim(); p.tv = descs.length;
  fs.writeFileSync(OUT, JSON.stringify(plots));
  console.log(t, 'episode summaries', descs.length, 'chars', p.text.length);
}
