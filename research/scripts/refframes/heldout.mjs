// A head file against clips it was not trained on: the clips of the given lists that the given earlier result file
// does not count (by default: the first shipped head, research/results/footage-head-v1.json, against everything
// fetched after it). Every frame here is new to that head, its work and its video too.
// usage (repo root): node research/scripts/refframes/heldout.mjs [head.json] > research/results/footage-heldout.txt
import fs from 'node:fs';
const E = 'research/data/refframes/emb', DIM = 768, H = JSON.parse(fs.readFileSync(process.argv[2] ?? 'research/results/footage-head-v1.json', 'utf8'));
const old = new Set(fs.readFileSync('research/results/footage-v1-clips.txt', 'utf8').split('\n'));
const rows = ['videos3.json', 'videos4.json'].flatMap((f) => JSON.parse(fs.readFileSync(`research/scripts/refframes/${f}`, 'utf8')))
  .filter((r) => !old.has(r[0]) && fs.existsSync(`${E}/${r[0]}.json`));
const pct = (a, n) => `${a}/${n} (${n ? (100 * a / n).toFixed(1) : '-'}%)`;
const res = [];
for (const [id, cat, , , , kind] of rows) {
  const { luma } = JSON.parse(fs.readFileSync(`${E}/${id}.json`, 'utf8')), m = new Float32Array(fs.readFileSync(`${E}/${id}.f32`).buffer.slice(0));
  const hit = luma.map((l, i) => { if (l[0] < 18 || l[1] < 10) return null; let s = H.b; for (let j = 0; j < DIM; j++) s += H.w[j] * m[i * DIM + j]; return s >= H.cut; });
  const ok = hit.filter((x) => x !== null), five = hit.filter((_, i) => i % 2 === 0); // every second frame = the product's 5 s sampling
  res.push({ cat, kind: cat.startsWith('music-video') ? 'aside' : kind, n: ok.length, h: ok.filter(Boolean).length, first: five.slice(0, 6).some(Boolean), any: five.some(Boolean) });
}
console.log(`head cut ${H.cut}; ${res.length} clips it never saw (work and video)`);
for (const k of ['game', 'anime', 'animation', 'live', 'real']) {
  const r = res.filter((x) => x.kind === k);
  console.log(`${k.padEnd(10)} frames ${pct(r.reduce((a, x) => a + x.h, 0), r.reduce((a, x) => a + x.n, 0)).padEnd(20)} videos hit in their first 30 s ${pct(r.filter((x) => x.first).length, r.length)}, at any time ${pct(r.filter((x) => x.any).length, r.length)}`);
}
console.log('\n## by clip');
for (const x of res.sort((a, b) => a.kind.localeCompare(b.kind) || a.h / a.n - b.h / b.n)) console.log(`${x.kind.padEnd(10)} ${x.cat.padEnd(32)} ${pct(x.h, x.n).padEnd(16)} ${x.first ? 'hit in 30 s' : x.any ? 'hit later' : 'never'}`);
