// Compares an on-device run of the classifier (demo app, SpoilerEval: "SBEVAL i p" logcat lines on stdin) with the
// extension's probabilities in android/build/vectors/spoiler-eval.json (android/tools/spoiler-vectors.mjs).
// usage: adb logcat -d -s SBEVAL:I | node android/tools/spoiler-eval-compare.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const { threshold, cases } = JSON.parse(fs.readFileSync(path.join(repo, 'android/build/vectors/spoiler-eval.json'), 'utf8'));
const got = new Map();
for (const m of fs.readFileSync(0, 'utf8').matchAll(/SBEVAL\s*:\s*(\d+) ([\d.eE-]+)/g)) got.set(+m[1], +m[2]);
if (got.size !== cases.length) throw new Error(`device scored ${got.size} of ${cases.length} posts`);
let max = 0, sum = 0;
const differ = [], by = {};
cases.forEach((c, i) => {
  const p = got.get(i), d = Math.abs(p - c.p);
  max = Math.max(max, d); sum += d;
  const k = (by[c.kind] ??= [0, 0]); k[0] += p >= threshold; k[1]++;
  if ((p >= threshold) !== (c.p >= threshold)) differ.push(`  js=${c.p.toFixed(4)} device=${p.toFixed(4)} ${c.text}`);
});
console.log(`device vs extension: ${differ.length} of ${cases.length} verdicts differ; |dp| max ${max.toExponential(2)} mean ${(sum / cases.length).toExponential(2)}`);
console.log(`flagged by kind: ${Object.entries(by).map(([k, [h, n]]) => `${k} ${h}/${n}`).join(', ')}`);
if (differ.length) console.log(differ.join('\n'));
