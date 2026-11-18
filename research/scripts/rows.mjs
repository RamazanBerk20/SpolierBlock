// Dumps the CLIP title rows exactly as tools/build.mjs orders them (most popular first) -> research/results/rows.json
import fs from 'node:fs';
import { buildIndex } from '../../tools/build-index.mjs';
import { clipRows } from '../../tools/build-clip-text.mjs';
const built = buildIndex(JSON.parse(fs.readFileSync('data/catalog.json', 'utf8')));
const { items, rowGroup } = clipRows(built, Infinity);
const g = built.meta.groups;
const rows = items.map((it, i) => ({ ...it, works: g[rowGroup[i]].slice(1) }));
fs.writeFileSync('research/results/rows.json', JSON.stringify({ rows, titles: built.meta.titles }));
const labels = JSON.parse(fs.readFileSync('test/fixtures/images/labels.json', 'utf8'));
for (const want of new Set(Object.values(labels).filter(Boolean))) console.log(want.padEnd(32), rows.findIndex((r) => r.title === want));
console.log('rows', rows.length);
