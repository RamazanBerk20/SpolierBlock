// word recall of the caption (case-insensitive) per OCR engine, by caption style
export function score(name, truth, out, ms) {
  const norm = (s) => (s ?? '').toLowerCase().replace(/[^a-z0-9' ]+/g, ' ').split(/\s+/).filter(Boolean);
  const by = {};
  let all = 0, n = 0;
  for (const [f, { text, style }] of Object.entries(truth)) {
    const got = new Set(norm(out[f])), want = norm(text);
    const r = want.filter((w) => got.has(w)).length / want.length;
    (by[style] ??= []).push(r); all += r; n++;
  }
  const s = [...ms].sort((a, b) => a - b);
  console.log(`${name}: word recall ${(all / n).toFixed(2)} (${Object.entries(by).map(([k, v]) => `${k} ${(v.reduce((a, b) => a + b) / v.length).toFixed(2)}`).join(', ')}), median ${Math.round(s[s.length >> 1])} ms/image`);
}
