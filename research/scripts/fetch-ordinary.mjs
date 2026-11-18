// Ordinary (non-media) hard-negative photos from Wikimedia Commons, test only. out: data/ordinary/*.jpg + index.json
import fs from 'node:fs';
const OUT = new URL('../data/ordinary/', import.meta.url).pathname;
fs.mkdirSync(OUT, { recursive: true });
const UA = { 'user-agent': 'sb-research-eval/0.1 (local evaluation script)' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function get(url, json = true) {
  for (let i = 1; i <= 5; i++) {
    let r; try { r = await fetch(url, { headers: UA }); } catch { await sleep(4000 * i); continue; }
    if (r.status === 429 || r.status >= 500) { await sleep(5000 * i); continue; }
    if (!r.ok) return null;
    await sleep(600);
    return json ? r.json() : Buffer.from(await r.arrayBuffer());
  }
  return null;
}
const CATS = ['Halloween costumes', 'Carnival costumes', 'Renaissance fairs', 'Rodeo in the United States', 'Cowboys', 'Historical reenactment',
  'Castles in Germany', 'Food photography', 'Dogs', 'Cats', 'Street photography', 'Concerts', 'Weddings', 'Birthday parties', 'Deserts',
  'Mountains', 'Horses', 'Selfies', 'Office interiors', 'Children playing', 'Fireworks', 'Masks', 'Toys', 'Sunsets', 'Trains', 'Supermarkets',
  'Graffiti', 'Football matches', 'Museums', 'Classrooms'];
const index = {};
for (const c of CATS) {
  const m = await get(`https://commons.wikimedia.org/w/api.php?format=json&action=query&generator=categorymembers&gcmtitle=${encodeURIComponent('Category:' + c)}&gcmtype=file&gcmlimit=30&prop=imageinfo&iiprop=url|mime&iiurlwidth=400`);
  const files = Object.values(m?.query?.pages ?? {}).filter((p) => /jpeg|png/.test(p.imageinfo?.[0]?.mime ?? '')).slice(0, 5);
  let k = 0;
  for (const f of files) {
    const b = await get(f.imageinfo[0].thumburl, false);
    if (!b) continue;
    const name = `${c.replace(/\W+/g, '_')}_${k++}.jpg`;
    fs.writeFileSync(OUT + name, b); index[name] = { cat: c, src: f.title };
  }
  fs.writeFileSync(OUT + 'index.json', JSON.stringify(index, null, 1));
  console.log(c, k);
}
