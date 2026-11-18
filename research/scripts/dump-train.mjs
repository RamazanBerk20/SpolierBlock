// Dumps the same training sources tools/train-spoiler.mjs uses (snapshot of its patterns, 2026-11-18 10:38) to data/train-items.jsonl,
// so architectures are compared on identical data. Nothing from the 300-item eval or the RDR2 probe.
import fs from 'node:fs';
import path from 'node:path';
import { IMPLIED, NEGATIVE, PLAIN_NEGATIVE } from '../results/snap/patterns.mjs';
const R = path.resolve(import.meta.dirname, '..');
let seed = 12345;
const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
const pick = (a) => a[Math.floor(rnd() * a.length)];
const items = [];
JSON.parse(fs.readFileSync(R + '/../test/fixtures/spoiler-train.json')).forEach(([text, y]) => items.push({ text, y, split: rnd() < 0.8 ? 'train' : 'val', src: 'hand' }));
const catalog = JSON.parse(fs.readFileSync(R + '/../data/catalog.json'));
const withChars = catalog.works.filter((w) => w.characters?.length).slice(0, 600);
const fill = (p) => { const w = pick(withChars); return p.replaceAll('{T}', w.title).replaceAll('{C}', pick(w.characters)); };
const add = (pats, y) => pats.forEach((p) => { const split = rnd() < 0.8 ? 'train' : 'val'; for (let i = 0; i < 12; i++) items.push({ text: fill(p), y, split, src: 'pattern' }); });
add(IMPLIED, 1); add(NEGATIVE, 0); add(PLAIN_NEGATIVE, 0);
const csv = (t) => { const rows = []; let row = [], f = '', q = false; for (let i = 0; i < t.length; i++) { const c = t[i]; if (q) { if (c === '"') { if (t[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c; } else if (c === '"') q = true; else if (c === ',') { row.push(f); f = ''; } else if (c === '\n') { row.push(f); rows.push(row); row = []; f = ''; } else if (c !== '\r') f += c; } if (f || row.length) { row.push(f); rows.push(row); } return rows; };
for (const [name, split] of [['train', 'train'], ['dev', 'val']]) for (const [lab, text] of csv(fs.readFileSync(`${R}/data/spoiler-matching/filtering/handlabeled/${name}.csv`, 'utf8'))) {
  if (!text || text.length < 15 || text.length > 220 || !/^[01]$/.test(lab)) continue;
  items.push({ text, y: lab === '0' ? 1 : 0, split, src: 'reddit' });
}
fs.writeFileSync(R + '/data/train-items.jsonl', items.map((x) => JSON.stringify(x)).join('\n'));
console.log(items.length, items.filter((x) => x.y).length);
