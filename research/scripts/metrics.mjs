// Shared metrics for the 300-item spoiler eval: AUC, P/R/F1 at a threshold, recall/FP by kind.
export function auc(y, p) {
  const pos = p.filter((_, i) => y[i]), neg = p.filter((_, i) => !y[i]);
  let s = 0; for (const a of pos) for (const b of neg) s += a > b ? 1 : a === b ? 0.5 : 0;
  return s / (pos.length * neg.length);
}
export function report(name, ev, p, thr) {
  const y = ev.map((r) => r.label);
  let tp = 0, fp = 0, fn = 0;
  const kinds = {};
  ev.forEach((r, i) => {
    const h = p[i] >= thr; if (h && y[i]) tp++; else if (h) fp++; else if (y[i]) fn++;
    const k = (kinds[r.kind] ??= { n: 0, flagged: 0 }); k.n++; if (h) k.flagged++;
  });
  const P = tp / (tp + fp || 1), Rc = tp / (tp + fn || 1);
  const ks = Object.entries(kinds).map(([k, v]) => `${k} ${v.flagged}/${v.n}`).join('  ');
  const line = `${name}: AUC ${auc(y, p).toFixed(3)}  thr ${thr}  P ${P.toFixed(2)} R ${Rc.toFixed(2)} F1 ${(2 * P * Rc / (P + Rc || 1)).toFixed(2)}  flagged by kind: ${ks}`;
  console.log(line);
  return line;
}
