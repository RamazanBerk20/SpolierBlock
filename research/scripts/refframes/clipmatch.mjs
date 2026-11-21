// Chooses `clipMatch` (contract rule 11, a remembered clip): the cosine at which a video frame counts as a frame of a clip
// the user remembered. On the cached embeddings of embed.mjs (the product's vision tower and preprocessing).
// A remembered clip: 12 frames, one every 5 s (60 s), stored as int8 (round(x * 127), as the title rows). A re-post of
// the same clip is sampled at another phase: the query frames lie between the stored ones (2.5 s off at 0.4 fps, 2-3 s
// at 1 fps). Different videos, including other videos of the same game, must never match.
// Videos are split in two halves by a hash of the id; the threshold is the lowest with zero different-video matches on
// the calibration half, reported on the other half; then the halves swap. Black or fade frames (as in analyze.mjs) are
// never stored (the extension skips them too).
// Result (2026-11-21): far below the bar for shipping (see docs/how-it-works.md, "Remembered clips (not shipped)").
// usage (repo root): flock ~/.cache/sb-heavy.lock node research/scripts/refframes/clipmatch.mjs
import fs from 'node:fs';

const E = 'research/data/refframes/emb', DIM = 768, PER = 12;
const vids = JSON.parse(fs.readFileSync('research/scripts/refframes/videos.json', 'utf8'));
const crc = (s) => { let c = ~0; for (const b of Buffer.from(s)) { c ^= b; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1)); } return ~c >>> 0; };
const dot = (a, b) => { let s = 0; for (let i = 0; i < DIM; i++) s += a[i] * b[i]; return s; };
const q8 = (e) => Float32Array.from(e, (x) => Math.max(-127, Math.min(127, Math.round(x * 127))) / 127);

const V = [];
for (const [id, cat, split] of vids) {
  if (!fs.existsSync(`${E}/${id}.json`)) { console.error('missing', id); continue; }
  const { luma } = JSON.parse(fs.readFileSync(`${E}/${id}.json`, 'utf8'));
  const m = new Float32Array(fs.readFileSync(`${E}/${id}.f32`).buffer.slice(0));
  const frames = luma.map((l, i) => ({ e: m.subarray(i * DIM, (i + 1) * DIM), black: l[0] < 18 || l[1] < 10 }));
  const step = split === 'ref' ? 5 : 2, off = split === 'ref' ? 2 : 1; // frames per 5 s, query offset
  const segs = [];
  for (let s = 0; s + step * PER <= frames.length; s += step * PER) {
    const stored = [], queries = [];
    for (let k = 0; k < PER; k++) {
      const f = frames[s + k * step];
      if (!f.black) stored.push(f.e);
      queries.push(frames[s + k * step + off].e);
    }
    if (stored.length >= 3) segs.push({ stored, stored8: stored.map(q8), queries });
  }
  V.push({ id, cat, half: crc(id) % 2, frames, segs });
}

const score = (set, e) => { let m = -1; for (const s of set) m = Math.max(m, dot(s, e)); return m; };
// per half: the highest cosine of a stored frame of one video to any frame of another video, and the same-video numbers
function measure(half, int8) {
  const vs = V.filter((v) => half === 'all' || v.half === half);
  const cross = []; // [cos, a, b]
  for (const a of vs) for (const seg of a.segs) {
    const set = int8 ? seg.stored8 : seg.stored;
    for (const b of vs) {
      if (b === a) continue;
      let m = -1;
      for (const f of b.frames) m = Math.max(m, score(set, f.e));
      cross.push([m, a.id, b.id, a.cat, b.cat]);
    }
  }
  cross.sort((x, y) => y[0] - x[0]);
  const same = []; // per segment: the max over stored of each query
  for (const a of vs) for (const seg of a.segs) same.push({ cat: a.cat, q: seg.queries.map((e) => score(int8 ? seg.stored8 : seg.stored, e)), pairs: seg.queries.flatMap((e) => (int8 ? seg.stored8 : seg.stored).map((s) => dot(s, e))) });
  return { vs, cross, same };
}
function report(m, thr) {
  let pairs = 0, pairHit = 0, frames = 0, frameHit = 0, wins = 0, winHit = 0;
  for (const s of m.same) {
    pairs += s.pairs.length; pairHit += s.pairs.filter((c) => c >= thr).length;
    frames += s.q.length; frameHit += s.q.filter((c) => c >= thr).length;
    for (let i = 0; i + 6 <= s.q.length; i++) { wins++; if (s.q.slice(i, i + 6).some((c) => c >= thr)) winHit++; }
  }
  const falseVid = m.cross.filter((c) => c[0] >= thr);
  const pct = (a, n) => `${a}/${n} (${((100 * a) / n).toFixed(1)}%)`;
  return `pairs ${pct(pairHit, pairs)}  frames ${pct(frameHit, frames)}  30-s windows ${pct(winHit, wins)}  ` +
    `different-video matches ${falseVid.length}/${m.cross.length} (same game ${falseVid.filter((c) => c[3] === c[4]).length})`;
}

for (const int8 of [false, true]) {
  console.log(`\n=== stored embeddings ${int8 ? 'int8 (as shipped)' : 'float'} ===`);
  const M = [0, 1].map((h) => measure(h, int8));
  for (const [c, t] of [[0, 1], [1, 0]]) {
    const thr = +(M[c].cross[0][0] + 1e-4).toFixed(4);
    console.log(`calibrate on half ${c} (${M[c].vs.length} videos, ${M[c].same.length} clips): clipMatch ${thr}` +
      `  (highest different-video: ${M[c].cross.slice(0, 3).map((x) => `${x[0].toFixed(3)} ${x[1]}/${x[3]} vs ${x[2]}/${x[4]}`).join('; ')})`);
    console.log(`  fit   half ${c}: ${report(M[c], thr)}`);
    console.log(`  held  half ${t}: ${report(M[t], thr)}`);
  }
  const A = measure('all', int8), all = +(A.cross[0][0] + 1e-4).toFixed(4);
  console.log(`zero different-video matches over all ${A.vs.length} videos (fitted on all, what ships): clipMatch ${all}: ${report(A, all)}`);
  console.log(`  highest different-video: ${A.cross.slice(0, 5).map((x) => `${x[0].toFixed(3)} ${x[1]}/${x[3]} vs ${x[2]}/${x[4]}`).join('; ')}`);
  // how far off a useful threshold is: recall and false matches at looser cut-offs (all videos; not a choice)
  for (const t of [0.95, 0.9, 0.85, 0.8]) console.log(`  at ${t}: ${report(A, t)}`);
}
