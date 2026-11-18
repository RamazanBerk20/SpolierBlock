// Compares `node tools/bench-engine.mjs <target> --stats` outputs: spread of the title verdict inputs between two
// runs on one browser, batch 1 vs batch 4, and between browsers, and the images closest to a cut-off.
// usage: node tools/bench-stats-diff.mjs chrome.json firefox.json [build/data/clip-meta.json]
import fs from 'node:fs';
const [a, b, metaFile = 'build/data/clip-meta.json'] = process.argv.slice(2);
const A = JSON.parse(fs.readFileSync(a, 'utf8')), B = JSON.parse(fs.readFileSync(b, 'utf8'));
const meta = JSON.parse(fs.readFileSync(metaFile, 'utf8'));
const KEYS = ['score', 'margin', 'gap', 'media'];
const spread = (pairs) => {
  const d = {};
  for (const k of KEYS) { const v = pairs.map(([x, y]) => Math.abs(x[k] - y[k])).sort((p, q) => p - q); d[k] = { median: +v[v.length >> 1].toFixed(5), max: +v[v.length - 1].toFixed(5) }; }
  d.bestRowChanged = pairs.filter(([x, y]) => x.group !== y.group).length;
  return d;
};
const files = Object.keys(A.stats).filter((f) => B.stats[f]);
for (const [name, pairs] of [
  [`${A.target} run vs run (batch 1)`, files.map((f) => [A.stats[f].b1, A.stats[f].b1again])],
  [`${B.target} run vs run (batch 1)`, files.map((f) => [B.stats[f].b1, B.stats[f].b1again])],
  [`${A.target} batch 1 vs batch 4`, files.map((f) => [A.stats[f].b1, A.stats[f].b4])],
  [`${B.target} batch 1 vs batch 4`, files.map((f) => [B.stats[f].b1, B.stats[f].b4])],
  [`${A.target} vs ${B.target} (batch 1)`, files.map((f) => [A.stats[f].b1, B.stats[f].b1])],
]) console.log(name.padEnd(36), JSON.stringify(spread(pairs)));
// distance of each value to its cut-off (positive = passes); the title needs score, margin and gap to pass
const cut = { score: meta.minScore, margin: meta.margin, gap: meta.titleGap, media: meta.mediaGate };
const rows = files.map((f) => {
  const s = [A.stats[f].b1, B.stats[f].b1], d = (k) => s.map((x) => x[k] - cut[k]);
  const title = s.map((x) => KEYS.slice(0, 3).every((k) => x[k] >= cut[k]));
  const titleSlack = Math.min(...KEYS.slice(0, 3).flatMap(d)), mediaSlack = Math.min(...d('media'));
  return { f, title, titleSlack, mediaSlack, maxMedia: Math.max(...d('media')), s };
});
console.log('\nimages near a cut-off (|slack| < 0.01) or judged differently by the two browsers:');
for (const r of rows.filter((r) => r.title[0] !== r.title[1] || Math.abs(r.titleSlack) < 0.01 || (r.mediaSlack < 0.01 && r.maxMedia > -0.01)))
  console.log(`  ${r.f.padEnd(30)} title ${r.title.join('/')} slack ${r.titleSlack.toFixed(4)}  media-gate slack ${r.s.map((x) => (x.media - cut.media).toFixed(4)).join('/')}`);
console.log('\ntitled in both:', rows.filter((r) => r.title[0] && r.title[1]).map((r) => `${r.f} (slack ${r.titleSlack.toFixed(4)}, group ${r.s[0].group})`).join(', ') || 'none');
