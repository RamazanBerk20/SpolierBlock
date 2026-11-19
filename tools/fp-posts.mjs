// Text-matcher benchmark on realistic social posts (test/fixtures/fp-posts.jsonl): false positives on non-media posts
// (news, politics, religion, sport, platforms, Turkish and other languages...) and recall on media posts, where the
// expected work must be in one of the matched groups.
// usage: node tools/fp-posts.mjs [catalog=data/catalog.json] [-v] [--file=test/fixtures/fp-posts.jsonl]   (-v lists every miss and false positive)
// test/fixtures/headlines.jsonl holds YouTube-style titles (Headline Case, ALL CAPS) in the same format.
import fs from 'node:fs';
import { buildIndex } from './build-index.mjs';
const { Matcher } = globalThis.SBMatcher;

const args = process.argv.slice(2), verbose = args.includes('-v');
const built = buildIndex(JSON.parse(fs.readFileSync(args.find((a) => !a.startsWith('-')) ?? 'data/catalog.json', 'utf8')));
const m = new Matcher(built.bin, built.meta), { groups, titles } = built.meta;
const file = args.find((a) => a.startsWith('--file='))?.slice(7) ?? 'test/fixtures/fp-posts.jsonl';
const rows = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const by = new Map(); // bucket -> { n, bad }
const bump = (k, bad) => { const e = by.get(k) ?? by.set(k, { n: 0, bad: 0 }).get(k); e.n++; if (bad) e.bad++; };
let fp = 0, miss = 0, nNeg = 0, nPos = 0;
for (const r of rows) {
  const gs = m.evaluate(r.text);
  if (r.media) {
    nPos++;
    const ok = gs.some((g) => groups[g].slice(1).some((w) => titles[w] === r.expect));
    if (!ok) { miss++; if (verbose) console.log(`MISS  [${r.expect}] ${gs.map((g) => groups[g][0]).join(' | ')} :: ${r.text.slice(0, 160)}`); }
    bump(`media ${r.lang && r.lang !== 'en' ? 'non-en' : 'en'}`, !ok);
  } else {
    nNeg++;
    if (gs.length) { fp++; if (verbose) console.log(`FP    ${gs.map((g) => groups[g][0]).join(' | ')} :: ${r.text.slice(0, 160)}`); }
    bump(r.topic ?? 'non-media', gs.length > 0);
  }
}
console.log(`non-media posts: ${nNeg}  covered: ${fp} (${(100 * fp / nNeg).toFixed(1)}%)`);
console.log(`media posts:     ${nPos}  matched: ${nPos - miss} (recall ${(100 * (nPos - miss) / nPos).toFixed(1)}%)`);
for (const [k, e] of [...by].sort()) console.log(`  ${k.padEnd(14)} ${String(e.bad).padStart(3)} / ${e.n}${k.startsWith('media') ? ' missed' : ' covered'}`);
