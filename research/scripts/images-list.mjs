// -> results/images.json: [{ file, want, src }] from fixtures (labels.json), Commons work folders (cosplay / lead) and ordinary photos.
// Commons files are kept only when their category name shares a distinctive word with the work title (drops search noise
// like "Strike Witches" for "The Witcher"); lead.jpg is the Wikipedia infobox image (poster / cover / key art).
import fs from 'node:fs';
import path from 'node:path';
const R = path.resolve(import.meta.dirname, '..');
const out = [];
const FX = R + '/../test/fixtures/images/';
for (const [f, want] of Object.entries(JSON.parse(fs.readFileSync(FX + 'labels.json')))) if (fs.existsSync(FX + f)) out.push({ file: FX + f, want, src: want ? 'fixture' : 'fixture-ordinary' });
const C = R + '/data/commons/';
const idx = JSON.parse(fs.readFileSync(C + 'index.json'));
const STOP = new Set(['the', 'of', 'a', 'and', 'no', 'cosplay', 'part']);
const words = (s) => s.toLowerCase().normalize('NFKD').replace(/\p{M}/gu, '').split(/[^a-z0-9]+/).filter((w) => w.length > 2 && !STOP.has(w));
const extra = { 'Star Trek': ['data', 'spock', 'klingon'], 'Game of Thrones': ['margaery', 'daenerys', 'targaryen', 'stark', 'lannister'], 'Harry Potter': ['hogwarts', 'weasley', 'granger'], 'Naruto': ['sasori', 'uchiha', 'akatsuki', 'kakashi'], 'Super Mario Bros.': ['rosalina'], 'Final Fantasy': ['tifa', 'zack'], 'Overwatch': ['sombra'], 'Star Trek': ['janice'], 'The Wizard of Oz': ['dorothy'], 'Genshin Impact': ['varesa'], 'Demon Slayer: Kimetsu no Yaiba': ['suma'] };
let dropped = 0;
for (const [slug, e] of Object.entries(idx)) {
  const tw = new Set([...words(e.title), ...(extra[e.title] ?? [])]);
  if (e.lead && fs.existsSync(C + slug + '/lead.jpg')) out.push({ file: C + slug + '/lead.jpg', want: e.title, src: 'lead' });
  for (const f of e.files) { if (words(f.cat).some((w) => tw.has(w))) out.push({ file: C + slug + '/' + f.name, want: e.title, src: 'cosplay', cat: f.cat }); else dropped++; }
}
const O = R + '/data/ordinary/';
if (fs.existsSync(O)) for (const f of fs.readdirSync(O).filter((f) => f.endsWith('.jpg'))) out.push({ file: O + f, want: null, src: 'ordinary' });
fs.writeFileSync(R + '/results/images.json', JSON.stringify(out, null, 0));
const c = {}; out.forEach((x) => (c[x.src] = (c[x.src] ?? 0) + 1));
console.log(c, 'dropped commons files (category mismatch):', dropped);
