// Evaluates a spoiler model the way the extension runs it (per sentence, max probability) on
// test/fixtures/spoiler-eval.jsonl or test/fixtures/spoiler-eval2.jsonl (a second set, written separately from the
// training patterns). Neither is ever used for training or threshold choice.
// usage: node tools/eval-spoiler.mjs [modelDir=models/spoiler] [eval.jsonl]
import fs from 'node:fs';
import { spoilerClassifier } from './spoiler-classify.mjs';
const [modelPath = 'models/spoiler', evalPath = 'test/fixtures/spoiler-eval.jsonl'] = process.argv.slice(2);
const { threshold, prob } = await spoilerClassifier(modelPath);
const rows = fs.readFileSync(evalPath, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
const label = (r) => { const v = r.spoiler ?? r.label ?? r.is_spoiler; return v === true || v === 1 || v === 'spoiler' || v === '1'; };
const res = [];
const t0 = performance.now();
for (const r of rows) res.push({ kind: r.kind, y: label(r), p: await prob(r.text) });
const ms = (performance.now() - t0) / rows.length;
const thr = threshold;
let tp = 0, fp = 0, fn = 0;
for (const x of res) { const hit = x.p >= thr; if (hit && x.y) tp++; else if (hit) fp++; else if (x.y) fn++; }
console.log(`${modelPath}: n=${res.length} threshold ${thr}  precision ${(tp / (tp + fp || 1)).toFixed(3)}  recall ${(tp / (tp + fn || 1)).toFixed(3)}  (${ms.toFixed(1)} ms/post, onnxruntime-web 1 thread in node)`);
for (const k of [...new Set(res.map((x) => x.kind))]) {
  const s = res.filter((x) => x.kind === k), hits = s.filter((x) => x.p >= thr).length;
  const what = s.every((x) => x.y) ? 'recall' : s.every((x) => !x.y) ? 'false-positive rate' : 'flagged';
  console.log(`  ${String(k).padEnd(16)} n=${String(s.length).padStart(3)}  ${what} ${(hits / s.length).toFixed(3)}`);
}
// threshold-free view: how separable is it at all (helps tell a plateau from a threshold problem)
const pos = res.filter((x) => x.y).map((x) => x.p), neg = res.filter((x) => !x.y).map((x) => x.p);
let auc = 0; for (const a of pos) for (const b of neg) auc += a > b ? 1 : a === b ? 0.5 : 0;
console.log(`  ROC AUC ${(auc / (pos.length * neg.length || 1)).toFixed(3)}`);
