// Second-stage analysis: baseline head decides confident posts; posts in its uncertain band go to a second scorer.
// The band is fixed a priori (0.25..0.75 around the head threshold), not tuned on the eval.
// usage: node scripts/cascade.mjs <scores.json ...>   (arrays of per-post scores aligned with the 300-item eval)
import fs from 'node:fs';
import { report } from './metrics.mjs';
const ev = fs.readFileSync(new URL('../results/snap/spoiler-eval.jsonl', import.meta.url), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const base = JSON.parse(fs.readFileSync(new URL('../results/text-baseline.json', import.meta.url)));
const thr = JSON.parse(fs.readFileSync(new URL('../results/snap/spoiler-model.json', import.meta.url))).threshold;
const [lo, hi] = [thr - 0.25, thr + 0.25];
const band = base.map((p) => p > lo && p < hi);
console.log(`uncertain band ${lo}-${hi}: ${band.filter(Boolean).length}/300 posts go to stage 2`);
report('baseline alone', ev, base, thr);
for (const f of process.argv.slice(2)) {
  let s = JSON.parse(fs.readFileSync(f)); if (s.scores) s = s.scores;
  // stage-2 decision at 0.5 mapped onto the baseline threshold scale
  const c = base.map((p, i) => (band[i] ? (s[i] >= 0.5 ? 1 : 0) : p >= thr ? 1 : 0));
  report('cascade ' + f.split('/').pop().replace('.json', ''), ev, c, 0.5);
}
