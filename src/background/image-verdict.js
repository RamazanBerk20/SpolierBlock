// Image embedding -> title verdict, in plain JS with no browser API so Node tests (test/image-verdict.test.js) run the
// shipped code. `meta` is data/clip-meta.json, `mat` its int8 title matrix (clip-text.bin).

// an embedding -> cosine of every title row (int8), the best row, its margin over the generic prompts, its gap to the
// best row of an unrelated title family, how much the media prompts beat the generic ones, and the footage head's score
// (null when clip-meta.json has no `foot`)
export function scores(meta, mat, v) {
  let n2 = 0; for (const a of v) n2 += a * a;
  const inv = 1 / Math.sqrt(n2), D = meta.dim;
  const dot = (t) => { let s = 0; for (let j = 0; j < D; j++) s += t[j] * v[j]; return s * inv; };
  const best = (vs) => { let m = -1; for (const t of vs) m = Math.max(m, dot(t)); return m; };
  const neg = best(meta.neg), media = best(meta.media) - neg;
  const foot = meta.foot ? dot(meta.foot.w) + meta.foot.b : null;
  const sc = new Float32Array(meta.n);
  let top = 0;
  for (let r = 0; r < meta.n; r++) {
    let s = 0; const o = r * D;
    for (let j = 0; j < D; j++) s += mat[o + j] * v[j];
    sc[r] = (s * inv) / 127;
    if (sc[r] > sc[top]) top = r;
  }
  let second = -1;
  for (let r = 0; r < meta.n; r++) if (meta.rowFamily[r] !== meta.rowFamily[top] && sc[r] > second) second = sc[r];
  return { sc, top, neg, media, foot, margin: sc[top] - neg, gap: sc[top] - second };
}

export function verdict(meta, { sc, top, neg, media, foot, margin, gap }, key) {
  let hits = [];
  if (sc[top] >= meta.minScore && margin >= meta.margin && gap >= meta.titleGap) {
    // a title: up to 3 groups of the best row's family (rows within the gap) that also clear the margin
    const rows = [];
    for (let r = 0; r < meta.n; r++) if (sc[r] - neg >= meta.margin && sc[top] - sc[r] < gap) rows.push(r);
    rows.sort((a, b) => sc[b] - sc[a]);
    hits = [...new Map(rows.map((r) => [meta.rowGroup[r], +sc[r].toFixed(3)]))].slice(0, 3);
  } else if (media >= meta.mediaGate || (meta.foot && foot >= meta.foot.cut)) {
    // looks like film/show/game media (posters, stills) or footage of a made work, no certain title (covered only if
    // settings.unknownImages)
    hits = [[-1, +sc[top].toFixed(3)]];
  }
  if (hits.length) console.debug('[SpolierBlock] image', key.slice(0, 80), hits, 'margin', margin.toFixed(3), 'gap', gap.toFixed(3), 'foot', foot?.toFixed(3));
  return hits;
}
