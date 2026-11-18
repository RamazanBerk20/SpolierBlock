// usage: node scripts/ft-report.mjs <name...>  -> metrics of results/ft/<name>.json on the 300-item eval
import fs from 'node:fs';
import { report } from './metrics.mjs';
const ev = fs.readFileSync(new URL('../results/snap/spoiler-eval.jsonl', import.meta.url), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
for (const n of process.argv.slice(2)) { const j = JSON.parse(fs.readFileSync(new URL(`../results/ft/${n}.json`, import.meta.url))); report(`${n} (train ${j.train_s}s, n=${j.n_train})`, ev, j.scores, j.thr); }
