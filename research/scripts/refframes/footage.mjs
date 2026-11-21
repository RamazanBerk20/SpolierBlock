// A different question from analyze.mjs: not "which work is this frame from" but "is this game footage at all",
// asked of games the probe never saw. Logistic probe on the cached embeddings (EMB= as in analyze.mjs).
// Train: frames of 9 games (split neg) against real-life frames (Miami video split neg, ordinary photos split neg).
// Threshold: 1 % of the cal real-life frames flagged. Test: GTA VI and Sleeping Dogs (never trained on, every split),
// the other games' test videos, against real-life test frames. Film trailers and media stills are only reported.
// Limits: the real-life video is 5 Miami videos, the rest of the negatives are still photos; one run, no tuning.
// usage (repo root): [EMB=research/data/refframes/emb-dino-cls] node research/scripts/refframes/footage.mjs
import fs from 'node:fs';

const E = process.env.EMB ?? 'research/data/refframes/emb', DIM = 768;
const vids = JSON.parse(fs.readFileSync('research/scripts/refframes/videos.json', 'utf8'));
const crc = (s) => { let c = ~0; for (const b of Buffer.from(s)) { c ^= b; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1)); } return ~c >>> 0; };
const dot = (a, b) => { let s = 0; for (let i = 0; i < DIM; i++) s += a[i] * b[i]; return s; };
const F = [];
const load = (id, fn) => {
  const { files, luma } = JSON.parse(fs.readFileSync(`${E}/${id}.json`, 'utf8'));
  const m = new Float32Array(fs.readFileSync(`${E}/${id}.f32`).buffer.slice(0));
  files.forEach((f, i) => F.push({ luma: luma[i], e: m.subarray(i * DIM, (i + 1) * DIM), idx: i, ...fn(f) }));
};
for (const [id, cat, split] of vids) load(id, () => ({ vid: id, cat, split }));
load('easy', (f) => {
  const name = f.split('/').slice(-2).join('/'), media = f.includes('/commons/') || (f.includes('test/fixtures') && !/\/clean/.test(f));
  return { vid: 'easy', cat: media ? 'easy-media' : 'easy-photo', split: ['neg', 'cal', 'test'][crc(name) % 3] };
});
const ok = (f) => f.vid === 'easy' || !(f.luma[0] < 18 || f.luma[1] < 10); // no black or fade frames
const UNSEEN = new Set(['gta6', 'sleepingdogs']), REAL = new Set(['miami', 'easy-photo']), OTHER = new Set(['miamifilm', 'easy-media']);
const game = (f) => !REAL.has(f.cat) && !OTHER.has(f.cat), real = (f) => REAL.has(f.cat);
const C = F.filter(ok);
const P = C.filter((f) => game(f) && !UNSEEN.has(f.cat) && f.split === 'neg'), N = C.filter((f) => real(f) && f.split === 'neg');

const w = new Float64Array(DIM + 1), m = new Float64Array(DIM + 1), v = new Float64Array(DIM + 1), lambda = 1e-4;
const X = [...P, ...N].map((f) => f.e), y = [...P.map(() => 1), ...N.map(() => 0)], wt = [...P.map(() => 0.5 / P.length), ...N.map(() => 0.5 / N.length)];
for (let it = 1; it <= 600; it++) {
  const g = new Float64Array(DIM + 1);
  X.forEach((x, j) => { const d = (1 / (1 + Math.exp(-(dot(w, x) + w[DIM]))) - y[j]) * wt[j]; for (let i = 0; i < DIM; i++) g[i] += d * x[i]; g[DIM] += d; });
  for (let i = 0; i < DIM; i++) g[i] += lambda * w[i];
  for (let i = 0; i <= DIM; i++) { m[i] = 0.9 * m[i] + 0.1 * g[i]; v[i] = 0.999 * v[i] + 0.001 * g[i] * g[i]; w[i] -= 0.05 * (m[i] / (1 - 0.9 ** it)) / (Math.sqrt(v[i] / (1 - 0.999 ** it)) + 1e-8); }
}
// --shipped: no probe, the product's own gate for "media with no certain title" (clip-meta.json: best media prompt
// minus best generic prompt, at mediaGate), on the SigLIP embeddings only
const meta = process.argv.includes('--shipped') ? JSON.parse(fs.readFileSync('dist/firefox/data/clip-meta.json', 'utf8')) : null;
const best = (rows, e) => Math.max(...rows.map((r) => dot(r, e)));
const sc = meta ? (f) => best(meta.media, f.e) - best(meta.neg, f.e) : (f) => dot(w, f.e) + w[DIM];
const calN = C.filter((f) => real(f) && f.split === 'cal').map(sc).sort((a, b) => b - a);
const t = meta ? meta.mediaGate : calN[Math.floor(0.01 * calN.length)] + 1e-9;
const pct = (a, n) => `${a}/${n} (${n ? (100 * a / n).toFixed(1) : '-'}%)`;
const frames = (fs_) => pct(fs_.filter((f) => sc(f) >= t).length, fs_.length);
// 30 s windows at the product's 5 s sampling (every second frame of a 0.4 fps video), black frames included
const windows = (p) => { let n = 0, h = 0; for (const id of new Set(F.filter((f) => f.vid !== 'easy' && p(f)).map((f) => f.vid))) {
  const fr = F.filter((f) => f.vid === id && f.idx % 2 === 0);
  for (let i = 0; i + 6 <= fr.length; i += 6) { n++; if (fr.slice(i, i + 6).filter((f) => sc(f) >= t).length >= 2) h++; } } return pct(h, n); };
console.log(`${E}\ntrain: ${P.length} frames of 9 games, ${N.length} real-life; threshold at 1% of ${calN.length} cal real-life frames`);
console.log(`cal check, seen games' cal videos: ${frames(C.filter((f) => game(f) && !UNSEEN.has(f.cat) && f.split === 'cal'))}`);
const row = (name, p) => console.log(`${name.padEnd(46)} frames ${frames(C.filter(p)).padEnd(20)} windows (2 of 6 frames) ${windows(p)}`);
console.log('\n## game footage flagged (higher is better)');
row('GTA VI gameplay, never trained on', (f) => f.cat === 'gta6' && f.split !== 'ref');
row('GTA VI trailers, never trained on', (f) => f.cat === 'gta6' && f.split === 'ref');
row('Sleeping Dogs, never trained on', (f) => f.cat === 'sleepingdogs');
row('9 seen games, their test videos', (f) => game(f) && !UNSEEN.has(f.cat) && f.split === 'test');
for (const id of new Set(F.filter((f) => f.cat === 'gta6' && f.split !== 'ref').map((f) => f.vid))) row(`  ${id} ${vids.find((x) => x[0] === id)[4].slice(0, 30)}`, (f) => f.vid === id);
console.log('\n## real life flagged (lower is better)');
row('Miami real video, test videos', (f) => f.cat === 'miami' && f.split === 'test');
console.log(`${'ordinary photos, test'.padEnd(46)} frames ${frames(C.filter((f) => f.cat === 'easy-photo' && f.split === 'test'))}`);
console.log('\n## not trained either way, for information');
row('film trailers (Bad Boys, Miami Vice)', (f) => f.cat === 'miamifilm');
console.log(`${'media stills (posters, screenshots)'.padEnd(46)} frames ${frames(C.filter((f) => f.cat === 'easy-media'))}`);
// trade-off, thresholds set on the test real-life frames themselves (so optimistic): unseen-game frames still flagged
if (!meta) {
  const rl = C.filter((f) => real(f) && f.split === 'test').map(sc).sort((a, b) => b - a), un = C.filter((f) => UNSEEN.has(f.cat) && f.split !== 'ref').map(sc);
  console.log('\n## trade-off (threshold set on the test real-life frames: optimistic)');
  for (const r of [0.05, 0.02, 0.01, 0]) { const th = (rl[Math.floor(r * rl.length)] ?? Infinity) + 1e-9; console.log(`real-life frames flagged ${(r * 100).toFixed(0)}%: unseen-game frames flagged ${pct(un.filter((x) => x >= th).length, un.length)}`); }
}
