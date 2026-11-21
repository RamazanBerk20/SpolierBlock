// Image-to-image recognition of one work (GTA VI) from reference frames, on the embeddings of embed.mjs.
// Splits are by video (videos.json): ref (+ refgp) = references, neg = the generic negative set a product would ship
// (used only by the rules that need negatives), cal = choose rule and threshold, test = touched once with cal's choices.
// Easy negatives (fixtures, research image sets) are split neg/cal/test by a hash of the file name.
// usage (repo root): node research/scripts/refframes/analyze.mjs [--refs=trailers|all] > research/results/refframes.txt
import fs from 'node:fs';

const D = 'research/data/refframes', E = process.env.EMB ?? `${D}/emb`, DIM = 768; // EMB: another embedding of the same frames (embed-dino.mjs)
const REFS = process.argv.find((a) => a.startsWith('--refs='))?.slice(7) ?? 'trailers';
const vids = JSON.parse(fs.readFileSync('research/scripts/refframes/videos.json', 'utf8'));
const crc = (s) => { let c = ~0; for (const b of Buffer.from(s)) { c ^= b; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1)); } return ~c >>> 0; };
const dot = (a, b) => { let s = 0; for (let i = 0; i < DIM; i++) s += a[i] * b[i]; return s; };
const unit = (v) => { const n = Math.hypot(...v) || 1; return Float32Array.from(v, (x) => x / n); };

// ---- load ----
const F = [];
const load = (id, fn) => {
  if (!fs.existsSync(`${E}/${id}.json`)) return console.error('missing', id);
  const { files, luma } = JSON.parse(fs.readFileSync(`${E}/${id}.json`, 'utf8'));
  const m = new Float32Array(fs.readFileSync(`${E}/${id}.f32`).buffer.slice(0));
  files.forEach((f, i) => F.push({ file: f, luma: luma[i], e: m.subarray(i * DIM, (i + 1) * DIM), idx: i, ...fn(f, i) }));
};
for (const [id, cat, split, sec] of vids) load(id, () => ({ vid: id, cat, split, fps: split === 'ref' ? 1 : 0.4, t0: +(sec.split('-')[0] || 0) }));
load('easy', (f) => {
  const name = f.split('/').slice(-2).join('/'), media = f.includes('/commons/') || (f.includes('test/fixtures') && !/\/clean/.test(f));
  return { vid: 'easy', cat: media ? 'easy-media' : 'easy-photo', split: ['neg', 'cal', 'test'][crc(name) % 3] };
});
// frame-level cleaning: black/fade frames and near-duplicates of the previous kept frame of the same video
const last = new Map();
for (const f of F) {
  f.black = f.vid !== 'easy' && (f.luma[0] < 18 || f.luma[1] < 10);
  const p = last.get(f.vid);
  f.dup = f.vid !== 'easy' && !!p && dot(p.e, f.e) > 0.97;
  if (!f.black && !f.dup) last.set(f.vid, f);
}
const clean = F.filter((f) => !f.black && !f.dup);
const pos = (f) => f.cat === 'gta6';
const by = (split, p) => clean.filter((f) => f.split === split && (p ? p(f) : true));
const refAll = clean.filter((f) => f.split === 'ref' || (REFS === 'all' && f.split === 'refgp'));
const negSet = by('neg');
const easyCat = (c) => c.startsWith('easy');

// ---- rules: refs -> (frame -> score) ----
const mean = (fs_) => { const m = new Float32Array(DIM); for (const f of fs_) for (let i = 0; i < DIM; i++) m[i] += f.e[i] / fs_.length; return m; };
const muGame = mean(negSet.filter((f) => !easyCat(f.cat)));
const centered = (e) => unit(e.map((x, i) => x - muGame[i]));
const topk = (refs, k) => (f) => { const s = refs.map((r) => dot(r, f.e)).sort((a, b) => b - a); let t = 0; for (let i = 0; i < k; i++) t += s[i]; return t / k; };
const negE = negSet.map((f) => f.e);
function logistic(P, N, lambda) {
  // class-balanced logistic regression, Adam, full batch
  const X = [...P, ...N], y = [...P.map(() => 1), ...N.map(() => 0)], wt = [...P.map(() => 0.5 / P.length), ...N.map(() => 0.5 / N.length)];
  const w = new Float64Array(DIM + 1), m = new Float64Array(DIM + 1), v = new Float64Array(DIM + 1);
  for (let it = 1; it <= 400; it++) {
    const g = new Float64Array(DIM + 1);
    X.forEach((x, j) => { const z = dot(w, x) + w[DIM], d = (1 / (1 + Math.exp(-z)) - y[j]) * wt[j]; for (let i = 0; i < DIM; i++) g[i] += d * x[i]; g[DIM] += d; });
    for (let i = 0; i < DIM; i++) g[i] += lambda * w[i];
    for (let i = 0; i <= DIM; i++) { m[i] = 0.9 * m[i] + 0.1 * g[i]; v[i] = 0.999 * v[i] + 0.001 * g[i] * g[i]; w[i] -= 0.05 * (m[i] / (1 - 0.9 ** it)) / (Math.sqrt(v[i] / (1 - 0.999 ** it)) + 1e-8); }
  }
  return (f) => dot(w, f.e) + w[DIM];
}
function rules(refs) {
  const R = refs.map((f) => f.e), Rc = R.map(centered), cen = unit(mean(refs)), cenC = unit(Array.from(cen, (x, i) => x - muGame[i]));
  return {
    max: (f) => Math.max(...R.map((r) => dot(r, f.e))),
    top5: topk(R, Math.min(5, R.length)),
    centroid: (f) => dot(cen, f.e),
    'centroid-centred': (f) => dot(cenC, centered(f.e)),
    'max-centred': (f) => { const c = centered(f.e); return Math.max(...Rc.map((r) => dot(r, c))); },
    'max-minus-nnNeg': (f) => Math.max(...R.map((r) => dot(r, f.e))) - Math.max(...negE.map((r) => dot(r, f.e))),
    'probe(l=1e-3)': logistic(R, negE, 1e-3),
    'probe(l=1e-2)': logistic(R, negE, 1e-2),
  };
}

// ---- thresholds and metrics ----
const thrAt = (negScores, rate) => { const s = [...negScores].sort((a, b) => b - a), k = Math.floor(rate * s.length); return (k < s.length ? s[k] : -Infinity) + 1e-9; };
const RATES = [0, 0.005, 0.02];
const pct = (a, n) => `${a}/${n} (${n ? ((100 * a) / n).toFixed(1) : '-'}%)`;
function evaluate(score, split) {
  const P = by(split, pos).map(score), N = by(split, (f) => !pos(f)), Ns = N.map(score);
  return { P, N, Ns };
}
const sample = (arr, n, seed) => { const a = [...arr]; let s = seed; for (let i = a.length - 1; i > 0; i--) { s = (s * 1103515245 + 12345) >>> 0; const j = s % (i + 1); [a[i], a[j]] = [a[j], a[i]]; } return a.slice(0, n); };

const out = (s = '') => console.log(s);
const count = (split) => { const g = by(split, pos).length, h = by(split, (f) => !pos(f) && !easyCat(f.cat)).length, e = by(split, (f) => easyCat(f.cat)).length; return `gta6 ${g}, hard neg ${h}, easy neg ${e}`; };
out(`refs: ${REFS === 'all' ? 'trailers + 1 gameplay video' : 'trailers only'} (${refAll.length} clean frames); generic negative set (neg split): ${negSet.length}`);
for (const s of ['cal', 'test']) out(`${s}: ${count(s)} clean frames`);
out(`dropped: ${F.filter((f) => f.black).length} black/fade, ${F.filter((f) => f.dup).length} near-duplicate frames`);

// 1) rule comparison on cal, all refs: recall at cal FP 0 / 0.5 / 2 %
out('\n## Rules on cal (thresholds from cal negatives; recall on cal gta6)');
const allRules = rules(refAll);
const calRes = {};
for (const [name, sc] of Object.entries(allRules)) {
  const { P, Ns } = evaluate(sc, 'cal');
  calRes[name] = RATES.map((r) => { const t = thrAt(Ns, r); return P.filter((x) => x >= t).length / P.length; });
  out(`${name.padEnd(18)} ${RATES.map((r, i) => `@${r * 100}%FP ${(100 * calRes[name][i]).toFixed(1)}%`).join('  ')}`);
}
// 2) number of references (random subsample, 3 seeds averaged), cal recall at 0.5 % FP
out('\n## Number of reference frames (cal recall at 0.5% cal FP, mean of 3 random subsamples)');
for (const n of [10, 30, 100, 300]) {
  if (n > refAll.length) continue;
  const acc = {};
  for (const seed of [1, 2, 3]) {
    const rs = rules(sample(refAll, n, seed));
    for (const name of ['max', 'top5', 'centroid-centred', 'max-minus-nnNeg', 'probe(l=1e-2)']) {
      const { P, Ns } = evaluate(rs[name], 'cal'), t = thrAt(Ns, 0.005);
      acc[name] = (acc[name] ?? 0) + P.filter((x) => x >= t).length / P.length / 3;
    }
  }
  out(`N=${String(n).padEnd(4)} ${Object.entries(acc).map(([k, v]) => `${k} ${(100 * v).toFixed(1)}%`).join('  ')}`);
}
out(`N=all (${refAll.length})`);

// 3) test, touched once: the rules chosen on cal, thresholds chosen on cal
const pick = Object.keys(calRes).sort((a, b) => calRes[b][1] - calRes[a][1] || calRes[b][0] - calRes[a][0]);
out(`\n## Test (thresholds from cal; best on cal at 0.5% FP: ${pick.slice(0, 3).join(', ')})`);
const result = {};
for (const name of pick.slice(0, 3)) {
  const sc = allRules[name], cal = evaluate(sc, 'cal'), test = evaluate(sc, 'test');
  const hard = test.N.map((f, i) => [f, test.Ns[i]]).filter(([f]) => !easyCat(f.cat));
  out(`\n### ${name}`);
  out(` test oracle (threshold set on test negatives): ${RATES.map((r) => { const t = thrAt(test.Ns, r); return `@${r * 100}%FP(all) recall ${pct(test.P.filter((x) => x >= t).length, test.P.length)}`; }).join('; ')}`);
  out(` test oracle on hard negatives only: ${RATES.map((r) => { const t = thrAt(hard.map((x) => x[1]), r); return `@${r * 100}%FP recall ${pct(test.P.filter((x) => x >= t).length, test.P.length)}`; }).join('; ')}`);
  const g5 = hard.filter(([f]) => f.cat === 'gta5').map((x) => x[1]);
  out(` test oracle on GTA V only: ${RATES.map((r) => { const t = thrAt(g5, r); return `@${r * 100}%FP recall ${pct(test.P.filter((x) => x >= t).length, test.P.length)}`; }).join('; ')}`);
  result[name] = {};
  for (const r of RATES) {
    const t = thrAt(cal.Ns, r), fpCat = {};
    test.N.forEach((f, i) => { fpCat[f.cat] ??= [0, 0]; fpCat[f.cat][1]++; if (test.Ns[i] >= t) fpCat[f.cat][0]++; });
    const fp = test.Ns.filter((x) => x >= t).length;
    out(` cal threshold @${r * 100}% cal FP = ${t.toFixed(4)}: test recall ${pct(test.P.filter((x) => x >= t).length, test.P.length)}, test FP ${pct(fp, test.Ns.length)}`);
    out(`   FP by category: ${Object.entries(fpCat).map(([c, [a, n]]) => `${c} ${a}/${n}`).join(', ')}`);
    out(`   recall by test video: ${[...new Set(by('test', pos).map((f) => f.vid))].map((v) => { const p = by('test', (f) => f.vid === v); return `${v} ${p.filter((f) => sc(f) >= t).length}/${p.length}`; }).join(', ')}`);
    // video level: all frames (black and duplicates included) at the product's 5 s spacing, 30 s windows
    const win = (p) => { let w = 0, h = 0; for (const v of new Set(F.filter((f) => f.split === 'test' && f.vid !== 'easy' && p(f)).map((f) => f.vid))) {
      const fr = F.filter((f) => f.vid === v && f.idx % 2 === 0);
      for (let i = 0; i + 6 <= fr.length; i += 6) { w++; if (fr.slice(i, i + 6).some((f) => sc(f) >= t)) h++; } } return pct(h, w); };
    out(`   30 s windows with a hit (5 s sampling): gta6 ${win(pos)}, hard negatives ${win((f) => !pos(f))}, GTA V ${win((f) => f.cat === 'gta5')}`);
    result[name][r] = t;
  }
  // failures at the 0.5 % cal threshold
  const t = result[name][0.005];
  const miss = by('test', pos).map((f) => [f, sc(f)]).filter(([, s]) => s < t).sort((a, b) => a[1] - b[1]);
  const fps = test.N.map((f, i) => [f, test.Ns[i]]).filter(([, s]) => s >= t).sort((a, b) => b[1] - a[1]);
  out(`   lowest-scoring gta6 test frames: ${sample(miss, 12, 7).map(([f, s]) => `${f.file.split('/').slice(-2).join('/')}=${s.toFixed(3)}`).join(' ')}`);
  out(`   top false positives: ${fps.slice(0, 12).map(([f, s]) => `${f.file.split('/').slice(-2).join('/')}=${s.toFixed(3)}`).join(' ')}`);
}

// 4) sibling: GTA V references (its neg-split video) next to GTA VI's, max-cosine rule, decide by the larger score
out('\n## Sibling confusion: GTA V refs (neg-split video) vs GTA VI refs, max cosine');
const g5refs = negSet.filter((f) => f.cat === 'gta5').map((f) => f.e), g6refs = refAll.map((f) => f.e);
const mx = (R, f) => Math.max(...R.map((r) => dot(r, f.e)));
for (const [label, p] of [['gta6 test', pos], ['gta5 test', (f) => f.cat === 'gta5']]) {
  const fr = by('test', p), six = fr.filter((f) => mx(g6refs, f) > mx(g5refs, f)).length;
  out(` ${label} (${fr.length} frames): nearer GTA VI ${six}, nearer GTA V ${fr.length - six}`);
}
fs.mkdirSync('research/results', { recursive: true });
fs.writeFileSync(`research/results/refframes-${REFS}.json`, JSON.stringify({ calRes, thresholds: result }, null, 1));
