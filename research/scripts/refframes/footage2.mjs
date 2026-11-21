// footage.mjs on the wider set: "is this footage of a game / of any made work", asked of works the probe never saw,
// against many kinds of real-life video. Frames of videos.json (the first set) and videos2.json (search2.mjs),
// embedded by embed.mjs with the product's vision tower. The protocol was written before the first run:
//   train  first set: the 9 seen games' neg and cal videos, Miami neg and cal videos, ordinary photos neg and cal;
//          wider set: split "train" (12 games, 14 real-life videos, 2 anime, 2 animation, 4 live-action).
//   cut    the score that 1 % of the training real-life frames reach when their own video was left out of training
//          (5 folds by video), so no test frame chooses it.
//   test   GTA VI and Sleeping Dogs (never trained on), the 9 seen games' test videos, the wider set's "test"
//          (12 other games, 14 other real-life videos of the trained kinds) and "only" (5 real-life kinds never trained).
// Three probes, by what counts as footage of a work: games; games + anime + animation; those + live-action.
// usage (repo root): node research/scripts/refframes/footage2.mjs > research/results/refframes-footage2.txt
import fs from 'node:fs';

const E = 'research/data/refframes/emb', DIM = 768, RATE = 0.01;
const crc = (s) => { let c = ~0; for (const b of Buffer.from(s)) { c ^= b; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1)); } return ~c >>> 0; };
const dot = (a, b) => { let s = 0; for (let i = 0; i < DIM; i++) s += a[i] * b[i]; return s; };
const F = [];
const load = (id, fn) => {
  if (!fs.existsSync(`${E}/${id}.json`)) return console.log('missing', id);
  const { files, luma } = JSON.parse(fs.readFileSync(`${E}/${id}.json`, 'utf8'));
  const m = new Float32Array(fs.readFileSync(`${E}/${id}.f32`).buffer.slice(0));
  files.forEach((f, i) => F.push({ black: id !== 'easy' && (luma[i][0] < 18 || luma[i][1] < 10), e: m.subarray(i * DIM, (i + 1) * DIM), idx: i, vid: id, ...fn(f) }));
};
const read = (f) => JSON.parse(fs.readFileSync(`research/scripts/refframes/${f}`, 'utf8'));
const UNSEEN = new Set(['gta6', 'sleepingdogs']);
for (const [id, cat, split] of read('videos.json')) {
  const kind = cat === 'miami' ? 'real' : cat === 'miamifilm' ? 'live' : 'game';
  // the first set's film trailers were never a training class: test only
  load(id, () => ({ cat, kind, part: UNSEEN.has(cat) || kind === 'live' || split === 'test' ? 'test' : 'train', set: 1, trailer: cat === 'gta6' && split === 'ref' }));
}
load('easy', (f) => {
  const name = f.split('/').slice(-2).join('/'), media = f.includes('/commons/') || (f.includes('test/fixtures') && !/\/clean/.test(f));
  return { cat: media ? 'stills' : 'photos', kind: media ? 'stills' : 'real', part: crc(name) % 3 === 2 ? 'test' : 'train', set: 1 };
});
for (const [id, cat, split, , , kind] of read('videos2.json')) load(id, () => ({ cat, kind, part: split === 'train' ? 'train' : 'test', only: split === 'only', set: 2 }));
const C = F.filter((f) => !f.black);

function fit(P, N) {
  const w = new Float64Array(DIM + 1), m = new Float64Array(DIM + 1), v = new Float64Array(DIM + 1), lambda = 1e-4;
  const X = [...P, ...N].map((f) => f.e), y = [...P.map(() => 1), ...N.map(() => 0)], wt = [...P.map(() => 0.5 / P.length), ...N.map(() => 0.5 / N.length)];
  for (let it = 1; it <= 400; it++) {
    const g = new Float64Array(DIM + 1);
    X.forEach((x, j) => { const d = (1 / (1 + Math.exp(-(dot(w, x) + w[DIM]))) - y[j]) * wt[j]; for (let i = 0; i < DIM; i++) g[i] += d * x[i]; g[DIM] += d; });
    for (let i = 0; i < DIM; i++) g[i] += lambda * w[i];
    for (let i = 0; i <= DIM; i++) { m[i] = 0.9 * m[i] + 0.1 * g[i]; v[i] = 0.999 * v[i] + 0.001 * g[i] * g[i]; w[i] -= 0.05 * (m[i] / (1 - 0.9 ** it)) / (Math.sqrt(v[i] / (1 - 0.999 ** it)) + 1e-8); }
  }
  return (f) => dot(w, f.e) + w[DIM];
}
const pct = (a, n) => `${a}/${n} (${n ? (100 * a / n).toFixed(1) : '-'}%)`;
const fold = (f) => crc(f.vid === 'easy' ? String(f.idx) : f.vid) % 5;

for (const [name, kinds] of [['games', ['game']], ['games + anime + animation', ['game', 'anime', 'animation']], ['games + anime + animation + live-action', ['game', 'anime', 'animation', 'live']]]) {
  const isPos = (f) => kinds.includes(f.kind), isNeg = (f) => f.kind === 'real';
  const P = C.filter((f) => f.part === 'train' && isPos(f)), N = C.filter((f) => f.part === 'train' && isNeg(f));
  const oof = [];
  for (let k = 0; k < 5; k++) { const s = fit(P.filter((f) => fold(f) !== k), N.filter((f) => fold(f) !== k)); for (const f of N) if (fold(f) === k) oof.push(s(f)); }
  oof.sort((a, b) => b - a);
  const t = oof[Math.floor(RATE * oof.length)] + 1e-9, sc = fit(P, N);
  const hit = (f) => sc(f) >= t;
  const frames = (p) => { const a = C.filter((f) => f.part === 'test' && p(f)); return pct(a.filter(hit).length, a.length); };
  // 30 s windows at the product's 5 s sampling: every second frame, 6 per window, flagged when 2 of the 6 are
  const windows = (p) => { let n = 0, h = 0; for (const id of new Set(F.filter((f) => f.vid !== 'easy' && f.part === 'test' && p(f)).map((f) => f.vid))) {
    const fr = F.filter((f) => f.vid === id && f.idx % 2 === 0);
    for (let i = 0; i + 6 <= fr.length; i += 6) { n++; if (fr.slice(i, i + 6).filter((f) => !f.black && hit(f)).length >= 2) h++; } } return pct(h, n); };
  const row = (label, p) => console.log(`${label.padEnd(44)} frames ${frames(p).padEnd(20)} windows ${windows(p)}`);
  console.log(`\n# probe: ${name}\ntrain ${P.length} frames of works, ${N.length} real-life; cut at ${RATE * 100}% of ${oof.length} left-out real-life training frames`);
  console.log('## footage of works the probe never saw (higher is better)');
  row('GTA VI gameplay', (f) => f.cat === 'gta6' && !f.trailer);
  row('GTA VI trailers', (f) => f.trailer);
  row('Sleeping Dogs', (f) => f.cat === 'sleepingdogs');
  row('12 other games, other styles (all)', (f) => f.set === 2 && f.kind === 'game');
  for (const c of new Set(C.filter((f) => f.set === 2 && f.part === 'test' && f.kind === 'game').map((f) => f.cat))) row(`  ${c}`, (f) => f.set === 2 && f.cat === c);
  for (const k of ['anime', 'animation', 'live']) {
    row(`${k}, 2 or 4 other works (all)${kinds.includes(k) ? '' : '  [not a training class]'}`, (f) => f.set === 2 && f.kind === k);
    for (const c of new Set(C.filter((f) => f.set === 2 && f.part === 'test' && f.kind === k).map((f) => f.cat))) row(`  ${c}`, (f) => f.set === 2 && f.cat === c);
  }
  row('film trailers, first set  [never trained]', (f) => f.cat === 'miamifilm');
  console.log('## seen games, new videos');
  row('9 seen games', (f) => f.set === 1 && f.kind === 'game' && !UNSEEN.has(f.cat));
  console.log('## real life (lower is better)');
  row('14 trained kinds, other videos (all)', (f) => f.set === 2 && f.kind === 'real' && !f.only);
  row('5 kinds never trained (all)', (f) => f.only);
  for (const c of new Set(C.filter((f) => f.set === 2 && f.part === 'test' && f.kind === 'real').map((f) => f.cat))) row(`  ${c}`, (f) => f.set === 2 && f.kind === 'real' && f.cat === c);
  row('Miami real video', (f) => f.cat === 'miami');
  console.log(`${'ordinary photos'.padEnd(44)} frames ${frames((f) => f.cat === 'photos')}`);
  console.log(`${'media stills (posters, screenshots)  [info]'.padEnd(44)} frames ${frames((f) => f.kind === 'stills')}`);
  // trade-off: the cut set on the test real-life frames themselves, so optimistic; windows as above
  console.log('## trade-off (cut set on the test real-life frames: optimistic)');
  const T = C.filter((f) => f.part === 'test'), rl = T.filter(isNeg).map(sc).sort((x, y) => y - x);
  for (const r of [0.005, 0.01, 0.02, 0.05]) {
    const th = rl[Math.floor(r * rl.length)] + 1e-9, at = (p) => { const x = T.filter(p); return `${(100 * x.filter((f) => sc(f) >= th).length / x.length).toFixed(1)}%`; };
    const win = (p) => { let n = 0, h = 0; for (const id of new Set(F.filter((f) => f.vid !== 'easy' && f.part === 'test' && p(f)).map((f) => f.vid))) {
      const fr = F.filter((f) => f.vid === id && f.idx % 2 === 0);
      for (let i = 0; i + 6 <= fr.length; i += 6) { n++; if (fr.slice(i, i + 6).filter((f) => !f.black && sc(f) >= th).length >= 2) h++; } } return `${(100 * h / n).toFixed(1)}%`; };
    const g6 = (f) => f.cat === 'gta6' && !f.trailer, og = (f) => f.set === 2 && f.kind === 'game';
    console.log(`real-life frames ${(r * 100).toFixed(1)}% (windows ${win(isNeg)}): GTA VI gameplay frames ${at(g6)} windows ${win(g6)}; 12 other games frames ${at(og)} windows ${win(og)}; anime ${win((f) => f.set === 2 && f.kind === 'anime')}, animation ${win((f) => f.set === 2 && f.kind === 'animation')}, live-action ${win((f) => f.set === 2 && f.kind === 'live')} of windows`);
  }
}
