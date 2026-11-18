// Text-matcher false-positive check on ordinary non-media English prose.
// Downloads a corpus once into build/corpus/ (never shipped): Wikipedia extracts of everyday, non-media topics
// plus two public-domain non-fiction books (Darwin, Adam Smith) from a Project Gutenberg mirror. Every sentence is evaluated as its own block.
// usage: node tools/fp-text.mjs [catalog=data/catalog.json]
import fs from 'node:fs';
import { buildIndex } from './build-index.mjs';
const { Matcher } = globalThis.SBMatcher;

const DIR = 'build/corpus';
fs.mkdirSync(DIR, { recursive: true });
const UA = { 'user-agent': 'spoilerblocker-fp-test/1.0 (local test)' };
const TOPICS = ['Bread', 'Coffee', 'Rain', 'Bicycle', 'Tax', 'Kitchen', 'Dog', 'Garden', 'Hospital', 'Train', 'Mortgage',
  'Football', 'Tennis', 'Marathon', 'Volcano', 'Photosynthesis', 'Inflation', 'Vaccine', 'Electricity', 'Plumbing',
  'Wedding', 'Birthday', 'Holiday', 'Airport', 'Cheese', 'Wine', 'Agriculture', 'Pottery', 'Carpentry', 'Hiking',
  'Swimming', 'Recycling', 'Insurance', 'Supermarket', 'Library', 'School', 'University', 'Office', 'Smartphone',
  'Laptop', 'Weather', 'Climate change', 'Earthquake', 'River', 'Mountain', 'Forest', 'Ocean', 'Cat', 'Horse', 'Chess',
  'Cooking', 'Baking', 'Tea', 'Chocolate', 'Rice', 'Apple', 'Soup', 'Pasta', 'Sleep', 'Exercise', 'Running', 'Yoga',
  'Commuting', 'Traffic', 'Parking', 'Taxi', 'Bus', 'Ferry', 'Bridge', 'Road', 'House', 'Apartment', 'Furniture',
  'Laundry', 'Cleaning', 'Bank', 'Credit card', 'Salary', 'Retirement', 'Election', 'Parliament', 'Court', 'Police',
  'Fire department', 'Ambulance', 'Pharmacy', 'Dentist', 'Nurse', 'Teacher', 'Farmer', 'Fishing', 'Camping', 'Beach'];
const BOOKS = { origin: 'https://gutenberg.pglaf.org/1/2/2/1228/1228-0.txt', wealth: 'https://gutenberg.pglaf.org/3/3/0/3300/3300-0.txt' };

async function get(file, url) {
  const p = `${DIR}/${file}`;
  if (fs.existsSync(p)) return fs.readFileSync(p, 'utf8');
  let r;
  for (let i = 1; i <= 6; i++) {
    r = await fetch(url, { headers: UA });
    if (r.status !== 429) break;
    await new Promise((res) => setTimeout(res, 20000 * i)); // Wikimedia rate limit
  }
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  const t = await r.text();
  fs.writeFileSync(p, t);
  await new Promise((res) => setTimeout(res, 1500));
  return t;
}

const texts = [];
for (const t of TOPICS) {
  const j = JSON.parse(await get(`wiki-${t.replace(/\W+/g, '_')}.json`,
    `https://en.wikipedia.org/w/api.php?action=query&format=json&prop=extracts&explaintext=1&redirects=1&titles=${encodeURIComponent(t)}`));
  for (const p of Object.values(j.query.pages)) texts.push((p.extract ?? '').split(/\n==+ (See also|References|Notes|Further reading|External links|In popular culture|In culture|In fiction|In media)/)[0]);
}
for (const [k, u] of Object.entries(BOOKS)) texts.push((await get(`${k}.txt`, u)).split(/\*\*\* START OF.*\n/)[1]?.split(/\*\*\* END OF/)[0] ?? '');

const sentences = texts.join('\n').replace(/\s*\n\s*/g, ' ').split(/(?<=[.!?])\s+(?=[A-Z"“])/)
  .map((s) => s.trim()).filter((s) => s.length >= 30 && s.length <= 400 && !/^=/.test(s));

const built = buildIndex(JSON.parse(fs.readFileSync(process.argv[2] ?? 'data/catalog.json', 'utf8')));
const m = new Matcher(built.bin, built.meta);
const hits = new Map();
let n = 0;
for (const s of sentences) {
  const gs = m.evaluate(s);
  if (!gs.length) continue;
  n++;
  // which key fired: longest token span whose group is reported
  for (const g of gs) {
    const label = built.meta.groups[g][0];
    const e = hits.get(label) ?? { n: 0, ex: s };
    e.n++;
    hits.set(label, e);
  }
}
console.log(`sentences: ${sentences.length}  flagged: ${n}  rate: ${(100 * n / sentences.length).toFixed(2)}%  (= ${(1000 * n / sentences.length).toFixed(1)} per 1000 sentences)`);
console.log('top offending names:');
for (const [label, e] of [...hits].sort((a, b) => b[1].n - a[1].n).slice(0, 30)) console.log(`${String(e.n).padStart(4)}  ${label.padEnd(36)} e.g. "${e.ex.slice(0, 110)}"`);
