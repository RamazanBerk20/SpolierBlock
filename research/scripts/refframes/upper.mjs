// Upper-bound check: is GTA VI linearly separable in this embedding at all, given far more in-domain positives than a
// product would ship? Logistic probe on ref + refgp + cal GTA VI frames vs neg + cal negatives, scored on test.
// Thresholds are set on the test negatives (oracle), so these numbers are optimistic by construction.
// usage (repo root): node research/scripts/refframes/upper.mjs
import fs from 'node:fs';

const E = 'research/data/refframes/emb', DIM = 768;
const vids = JSON.parse(fs.readFileSync('research/scripts/refframes/videos.json', 'utf8'));
const crc = (s) => { let c = ~0; for (const b of Buffer.from(s)) { c ^= b; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1)); } return ~c >>> 0; };
const dot = (a, b) => { let s = 0; for (let i = 0; i < DIM; i++) s += a[i] * b[i]; return s; };
const F = [];
const load = (id, fn) => {
  const { files } = JSON.parse(fs.readFileSync(`${E}/${id}.json`, 'utf8'));
  const m = new Float32Array(fs.readFileSync(`${E}/${id}.f32`).buffer.slice(0));
  files.forEach((f, i) => F.push({ e: m.subarray(i * DIM, (i + 1) * DIM), ...fn(f) }));
};
for (const [id, cat, split] of vids) load(id, () => ({ cat, split }));
load('easy', (f) => ({ cat: 'easy', split: ['neg', 'cal', 'test'][crc(f.split('/').slice(-2).join('/')) % 3] }));
const pos = (f) => f.cat === 'gta6';
const train = F.filter((f) => f.split !== 'test'), test = F.filter((f) => f.split === 'test');
const P = train.filter(pos).map((f) => f.e), N = train.filter((f) => !pos(f)).map((f) => f.e);
for (const lambda of [1e-4, 1e-3, 1e-2]) {
  const X = [...P, ...N], y = [...P.map(() => 1), ...N.map(() => 0)], wt = [...P.map(() => 0.5 / P.length), ...N.map(() => 0.5 / N.length)];
  const w = new Float64Array(DIM + 1), m = new Float64Array(DIM + 1), v = new Float64Array(DIM + 1);
  for (let it = 1; it <= 600; it++) {
    const g = new Float64Array(DIM + 1);
    X.forEach((x, j) => { const d = (1 / (1 + Math.exp(-(dot(w, x) + w[DIM]))) - y[j]) * wt[j]; for (let i = 0; i < DIM; i++) g[i] += d * x[i]; g[DIM] += d; });
    for (let i = 0; i < DIM; i++) g[i] += lambda * w[i];
    for (let i = 0; i <= DIM; i++) { m[i] = 0.9 * m[i] + 0.1 * g[i]; v[i] = 0.999 * v[i] + 0.001 * g[i] * g[i]; w[i] -= 0.05 * (m[i] / (1 - 0.9 ** it)) / (Math.sqrt(v[i] / (1 - 0.999 ** it)) + 1e-8); }
  }
  const sc = (f) => dot(w, f.e) + w[DIM];
  const tp = test.filter(pos).map(sc), tn = test.filter((f) => !pos(f)).map(sc).sort((a, b) => b - a);
  const g5 = test.filter((f) => f.cat === 'gta5').map(sc).sort((a, b) => b - a);
  const rec = (neg, r) => { const t = neg[Math.floor(r * neg.length)] ?? -Infinity; return `${tp.filter((x) => x > t).length}/${tp.length}`; };
  console.log(`lambda ${lambda}: train ${P.length} pos / ${N.length} neg; test recall @0%FP ${rec(tn, 0)}, @0.5%FP ${rec(tn, 0.005)}, @2%FP ${rec(tn, 0.02)}, @10%FP ${rec(tn, 0.1)} (all ${tn.length} negatives); vs GTA V only @2%FP ${rec(g5, 0.02)}`);
}
