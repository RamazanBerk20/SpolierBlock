// Builds a held-out image eval set from Wikimedia Commons (test only, never shipped):
// for each work, files from a "Cosplay of <work>"-style category + the work's English Wikipedia lead image.
// out: data/commons/<slug>/{c0..cN}.jpg (Commons) and lead.jpg (Wikipedia page image), data/commons/index.json
import fs from 'node:fs';
const OUT = new URL('../data/commons/', import.meta.url).pathname;
const UA = { 'user-agent': 'sb-research-eval/0.1 (local evaluation script)' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function get(url, json = true) {
  for (let i = 1; i <= 5; i++) {
    let r; try { r = await fetch(url, { headers: UA }); } catch { await sleep(5000 * i); continue; }
    if (r.status === 429 || r.status >= 500) { await sleep(5000 * i); continue; }
    if (!r.ok) return null;
    await sleep(700);
    return json ? r.json() : Buffer.from(await r.arrayBuffer());
  }
  return null;
}
const C = 'https://commons.wikimedia.org/w/api.php?format=json&action=query';
// [catalog title, wikipedia page, commons category search]
const WORKS = JSON.parse(fs.readFileSync(new URL('../data/commons-works.json', import.meta.url)));
const index = fs.existsSync(OUT + 'index.json') ? JSON.parse(fs.readFileSync(OUT + 'index.json')) : {};
for (const [title, wp, q] of WORKS) {
  const slug = title.replace(/\W+/g, '_');
  if (index[slug]) continue;
  fs.mkdirSync(OUT + slug, { recursive: true });
  const e = { title, files: [], lead: null };
  // Wikipedia lead image (poster / cover / key art), 400 px thumbnail
  const pi = await get(`https://en.wikipedia.org/w/api.php?format=json&action=query&prop=pageimages&piprop=thumbnail&pilicense=any&pithumbsize=400&redirects=1&titles=${encodeURIComponent(wp)}`);
  const page = pi && Object.values(pi.query.pages)[0];
  if (page?.thumbnail) { const b = await get(page.thumbnail.source, false); if (b) { fs.writeFileSync(`${OUT}${slug}/lead.jpg`, b); e.lead = page.thumbnail.source; } }
  // Commons category
  const s = await get(`${C}&list=search&srnamespace=14&srlimit=5&srsearch=${encodeURIComponent(q)}`);
  const cats = (s?.query?.search ?? []).map((x) => x.title);
  for (const cat of cats) {
    if (e.files.length >= 8) break;
    const m = await get(`${C}&generator=categorymembers&gcmtitle=${encodeURIComponent(cat)}&gcmtype=file&gcmlimit=40&prop=imageinfo&iiprop=url|mime&iiurlwidth=400`);
    const files = Object.values(m?.query?.pages ?? {}).filter((p) => /jpeg|png/.test(p.imageinfo?.[0]?.mime ?? ''));
    for (const f of files.slice(0, 8 - e.files.length)) {
      const b = await get(f.imageinfo[0].thumburl, false);
      if (!b) continue;
      const name = `c${e.files.length}.jpg`;
      fs.writeFileSync(`${OUT}${slug}/${name}`, b);
      e.files.push({ name, src: f.title, cat });
    }
  }
  index[slug] = e;
  fs.writeFileSync(OUT + 'index.json', JSON.stringify(index, null, 1));
  console.log(title, 'lead', !!e.lead, 'files', e.files.length, cats[0]);
}
