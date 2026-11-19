// Text-matcher benchmark on text read from pictures (test/fixtures/ocr-noise.jsonl): thumbnails and images whose OCR text
// carries no work (shouty phrases, logos, timers, scores, UI labels) must not be covered; thumbnails that carry a title
// must still match it from the OCR text alone. Each row is evaluated as `own` + U+0001 + `ocr`, as the callers pass it.
// usage: node tools/fp-ocr.mjs [catalog=data/catalog.json] [-v] [--newline]   (--newline: join with "\n", the 0.2 callers)
import fs from 'node:fs';
import { buildIndex } from './build-index.mjs';
const { Matcher } = globalThis.SBMatcher;

const args = process.argv.slice(2), verbose = args.includes('-v'), sep = args.includes('--newline') ? '\n' : '\u0001';
const built = buildIndex(JSON.parse(fs.readFileSync(args.find((a) => !a.startsWith('-')) ?? 'data/catalog.json', 'utf8')));
const m = new Matcher(built.bin, built.meta), { groups, titles } = built.meta;
const rows = fs.readFileSync('test/fixtures/ocr-noise.jsonl', 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
let fp = 0, hit = 0, nNeg = 0, nPos = 0;
for (const r of rows) {
  const gs = m.evaluate(r.own + sep + r.ocr), labels = gs.map((g) => groups[g][0]).join(' | ');
  if (r.media) {
    nPos++;
    if (gs.some((g) => groups[g].slice(1).some((w) => titles[w] === r.expect))) hit++;
    else if (verbose) console.log(`MISS  [${r.expect}] ${labels} :: ${r.ocr.replace(/\n/g, ' / ')}`);
  } else {
    nNeg++;
    if (gs.length) { fp++; if (verbose) console.log(`FP    ${labels} :: ${r.own.slice(0, 60)} :: ${r.ocr.replace(/\n/g, ' / ').slice(0, 80)}`); }
  }
}
console.log(`no work in the picture: ${nNeg}  covered: ${fp} (${(100 * fp / nNeg).toFixed(1)}%)`);
console.log(`title in the picture:   ${nPos}  matched: ${hit} (recall ${(100 * hit / nPos).toFixed(1)}%)`);
