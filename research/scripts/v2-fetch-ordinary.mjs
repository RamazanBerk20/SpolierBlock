// More ordinary (non-media) photos from Wikimedia Commons for calibrating the image verdict on one split and reporting
// on another. Test use only. usage: node v2-fetch-ordinary.mjs <outDir>   -> <outDir>/*.jpg + index.json
import fs from 'node:fs';
const OUT = process.argv[2];
fs.mkdirSync(OUT, { recursive: true });
const UA = { 'user-agent': 'sb-research-eval/0.2 (local evaluation script)' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function get(url, json = true) {
  for (let i = 1; i <= 5; i++) {
    let r; try { r = await fetch(url, { headers: UA }); } catch { await sleep(4000 * i); continue; }
    if (r.status === 429 || r.status >= 500) { await sleep(5000 * i); continue; }
    if (!r.ok) return null;
    await sleep(500);
    return json ? r.json() : Buffer.from(await r.arrayBuffer());
  }
  return null;
}
const CATS = ['Breakfast', 'Pizza', 'Coffee', 'Smartphones', 'Laptops', 'Automobiles', 'Motorcycles', 'Beaches', 'Forests', 'Lakes',
  'Skylines', 'Bridges', 'Churches', 'Markets', 'Restaurants', 'Kitchens', 'Living rooms', 'Gardens', 'Flowers', 'Birds', 'Insects',
  'Sheep', 'Basketball', 'Tennis', 'Marathons', 'Swimming', 'Yoga', 'Demonstrations', 'Portrait photographs', 'Babies', 'Families',
  'Graduation ceremonies', 'Festivals', 'Parades', 'Christmas decorations', 'Board games', 'Chess', 'Lego', 'Plush toys', 'Paintings',
  'Sculptures', 'Theatre', 'Circus', 'Ballet', 'Musicians', 'Charts', 'Maps', 'Airports', 'Hospitals', 'Libraries'];
const index = {};
for (const c of CATS) {
  const m = await get(`https://commons.wikimedia.org/w/api.php?format=json&action=query&generator=categorymembers&gcmtitle=${encodeURIComponent('Category:' + c)}&gcmtype=file&gcmlimit=40&prop=imageinfo&iiprop=url|mime&iiurlwidth=480`);
  const files = Object.values(m?.query?.pages ?? {}).filter((p) => /jpeg|png/.test(p.imageinfo?.[0]?.mime ?? '')).slice(0, 8);
  let k = 0;
  for (const f of files) {
    const b = await get(f.imageinfo[0].thumburl, false);
    if (!b) continue;
    const name = `${c.replace(/\W+/g, '_')}_${k++}.jpg`;
    fs.writeFileSync(`${OUT}/${name}`, b); index[name] = { cat: c, src: f.title };
  }
  fs.writeFileSync(`${OUT}/index.json`, JSON.stringify(index, null, 1));
  console.log(c, k);
}
