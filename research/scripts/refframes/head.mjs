// Trains the footage head the product ships (contract rule 6) and writes data/footage-head.json: { w, b, cut }.
// "Is this footage of a made work (game, anime, animation, live-action film or series)" against real-life video and
// ordinary photos, as one linear layer on the product's image embedding (the frames of videos.json and, when present,
// videos2.json to videos4.json, embedded by embed.mjs). See footage.mjs and footage2.mjs for the experiments behind it.
//   estimate  5 folds; a work (all its videos) or a real-life video is in one fold, and every frame is scored by a
//             probe that never saw its work or video.
//   cut       the score that RATE of those left-out real-life frames reach.
//   shipped   the same probe trained on every frame, with that cut.
// usage (repo root): node research/scripts/refframes/head.mjs [--dry] > research/results/footage-head.txt
import fs from 'node:fs';

const E = 'research/data/refframes/emb', DIM = 768, RATE = 0.005, FOLDS = 5;
const crc = (s) => { let c = ~0; for (const b of Buffer.from(s)) { c ^= b; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1)); } return ~c >>> 0; };
const dot = (a, b) => { let s = 0; for (let i = 0; i < DIM; i++) s += a[i] * b[i]; return s; };
const F = [];
const load = (id, fn) => {
  if (!fs.existsSync(`${E}/${id}.json`)) return console.log('missing', id);
  const { files, luma } = JSON.parse(fs.readFileSync(`${E}/${id}.json`, 'utf8'));
  const m = new Float32Array(fs.readFileSync(`${E}/${id}.f32`).buffer.slice(0));
  files.forEach((f, i) => F.push({ black: id !== 'easy' && (luma[i][0] < 18 || luma[i][1] < 10), e: m.subarray(i * DIM, (i + 1) * DIM), idx: i, vid: id, ...fn(f, i) }));
};
const read = (f) => (fs.existsSync(`research/scripts/refframes/${f}`) ? JSON.parse(fs.readFileSync(`research/scripts/refframes/${f}`, 'utf8')) : []);
for (const [id, cat] of read('videos.json')) load(id, () => (cat === 'miami' ? { kind: 'real', cat, unit: id } : { kind: cat === 'miamifilm' ? 'live' : 'game', cat, unit: cat }));
load('easy', (f, i) => {
  const media = f.includes('/commons/') || (f.includes('test/fixtures') && !/\/clean/.test(f));
  return { kind: media ? 'stills' : 'real', cat: 'photos', unit: 'photo' + i };
});
// Music videos are set aside (neither class, not in the cut), a change made after the first full run: one that is shot
// like a horror film scored like a film in 24 of its 57 frames and by itself moved the cut from 2.0 to 3.9, which took
// the left-out games from 82 % to 51 % of frames. A frame cannot tell such a video from a film, so they are reported
// as a known false cover instead of being allowed to set the cut.
for (const f of ['videos2.json', 'videos3.json', 'videos4.json']) for (const [id, cat, , , , kind] of read(f)) load(id, () => ({ kind: cat.startsWith('music-video') ? 'aside' : kind, cat, unit: kind === 'real' ? id : cat }));
const C = F.filter((f) => !f.black && f.kind !== 'stills' && f.kind !== 'aside'); // posters and stills are the media prompts' job
const ASIDE = F.filter((f) => !f.black && f.kind === 'aside');
const pos = (f) => f.kind !== 'real', fold = (f) => crc(f.unit) % FOLDS;

function fit(S) {
  const P = S.filter(pos), N = S.filter((f) => !pos(f));
  const w = new Float64Array(DIM + 1), m = new Float64Array(DIM + 1), v = new Float64Array(DIM + 1), lambda = 1e-4;
  const X = [...P, ...N].map((f) => f.e), y = [...P.map(() => 1), ...N.map(() => 0)], wt = [...P.map(() => 0.5 / P.length), ...N.map(() => 0.5 / N.length)];
  for (let it = 1; it <= 400; it++) {
    const g = new Float64Array(DIM + 1);
    X.forEach((x, j) => { const d = (1 / (1 + Math.exp(-(dot(w, x) + w[DIM]))) - y[j]) * wt[j]; for (let i = 0; i < DIM; i++) g[i] += d * x[i]; g[DIM] += d; });
    for (let i = 0; i < DIM; i++) g[i] += lambda * w[i];
    for (let i = 0; i <= DIM; i++) { m[i] = 0.9 * m[i] + 0.1 * g[i]; v[i] = 0.999 * v[i] + 0.001 * g[i] * g[i]; w[i] -= 0.05 * (m[i] / (1 - 0.9 ** it)) / (Math.sqrt(v[i] / (1 - 0.999 ** it)) + 1e-8); }
  }
  return w;
}
const score = (w, f) => dot(w, f.e) + w[DIM];
for (let k = 0; k < FOLDS; k++) { const w = fit(C.filter((f) => fold(f) !== k)); for (const f of C) if (fold(f) === k) f.s = score(w, f); }
const neg = C.filter((f) => !pos(f)).map((f) => f.s).sort((a, b) => b - a);
const cut = +(neg[Math.floor(RATE * neg.length)] + 1e-6).toFixed(4);
const pct = (a, n) => `${a}/${n} (${n ? (100 * a / n).toFixed(1) : '-'}%)`;
const frames = (a) => pct(a.filter((f) => f.s >= cut).length, a.length);
// the product judges a sampled frame every 5 s and covers on the first hit: per video, any hit in its first 30 s / at all
const videos = (p) => { const ids = [...new Set(C.filter(p).map((f) => f.vid))].filter((v) => v !== 'easy'); let a = 0, b = 0;
  for (const id of ids) { const fr = C.filter((f) => f.vid === id && f.idx % 2 === 0); if (fr.slice(0, 6).some((f) => f.s >= cut)) a++; if (fr.some((f) => f.s >= cut)) b++; }
  return `videos hit in their first 30 s ${pct(a, ids.length)}, at any time ${pct(b, ids.length)}`; };
console.log(`${C.length} frames: ${C.filter(pos).length} of ${new Set(C.filter(pos).map((f) => f.unit)).size} works, ${neg.length} real-life (${new Set(C.filter((f) => !pos(f) && f.vid !== 'easy').map((f) => f.vid)).size} videos, ${C.filter((f) => f.vid === 'easy').length} photos)`);
console.log(`cut ${cut}: the score ${RATE * 100}% of the left-out real-life frames reach\n`);
console.log('## left-out estimate (every frame scored by a probe that never saw its work or video)');
for (const k of ['game', 'anime', 'animation', 'live']) console.log(`${k.padEnd(10)} frames ${frames(C.filter((f) => f.kind === k)).padEnd(22)} ${videos((f) => f.kind === k)}`);
console.log(`${'real life'.padEnd(10)} frames ${frames(C.filter((f) => !pos(f))).padEnd(22)} ${videos((f) => !pos(f))}`);
console.log('\n## by work or kind of real-life video, frames flagged');
const cats = new Map();
for (const f of C) { const k = `${f.kind}  ${f.cat}`; const c = cats.get(k) ?? cats.set(k, [0, 0]).get(k); c[1]++; if (f.s >= cut) c[0]++; }
for (const [k, [a, n]] of [...cats].sort()) console.log(`${k.padEnd(40)} ${pct(a, n)}`);

// other cuts, for information: what a stricter or looser rate would give on the same left-out scores
console.log('\n## other rates (left-out scores; the shipped cut is the first line)');
for (const r of [RATE, 0.002, 0.001, 0.01]) {
  const c = neg[Math.floor(r * neg.length)] + 1e-6, fr = (k) => { const a = C.filter((f) => f.kind === k); return `${(100 * a.filter((f) => f.s >= c).length / a.length).toFixed(0)}%`; };
  const vid = (p, first) => { const ids = [...new Set(C.filter(p).map((f) => f.vid))].filter((v) => v !== 'easy'); return `${ids.filter((id) => { const x = C.filter((f) => f.vid === id && f.idx % 2 === 0); return (first ? x.slice(0, 6) : x).some((f) => f.s >= c); }).length}/${ids.length}`; };
  console.log(`real-life frames ${(r * 100).toFixed(1)}% (cut ${c.toFixed(2)}): frames game ${fr('game')} anime ${fr('anime')} animation ${fr('animation')} live ${fr('live')}; game videos hit in 30 s ${vid((f) => f.kind === 'game', 1)}; real-life videos hit in 30 s ${vid((f) => !pos(f), 1)}, at any time ${vid((f) => !pos(f), 0)}`);
}
const w = fit(C);
console.log('\n## set aside: music videos, scored by the shipped head (trained without them)');
for (const id of new Set(ASIDE.map((f) => f.vid))) { const a = ASIDE.filter((f) => f.vid === id); console.log(`${a[0].cat.padEnd(20)} ${pct(a.filter((f) => score(w, f) >= cut).length, a.length)}`); }
if (!process.argv.includes('--dry')) {
  fs.writeFileSync('data/footage-head.json', JSON.stringify({ version: 1, dim: DIM, cut, b: +w[DIM].toFixed(5), w: Array.from(w.subarray(0, DIM), (x) => +x.toFixed(5)),
    note: 'research/scripts/refframes/head.mjs: score = w . e + b on the L2-normalised image embedding; footage of a made work when score >= cut' }) + '\n');
  console.log(`\nwrote data/footage-head.json (trained on all ${C.length} frames)`);
}
