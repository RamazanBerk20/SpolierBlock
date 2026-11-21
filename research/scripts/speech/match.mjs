// usage (repo root): node research/scripts/speech/match.mjs -> research/results/speech-results.json + printed tables
import fs from 'node:fs';
import { buildIndex } from '../../../tools/build-index.mjs';
const { Matcher } = globalThis.SBMatcher;
const built = buildIndex(JSON.parse(fs.readFileSync('data/catalog.json', 'utf8')));
const m = new Matcher(built.bin, built.meta), { groups, titles } = built.meta;
const R = 'research/data/speech/', man = JSON.parse(fs.readFileSync(R + 'manifest.json', 'utf8'));
const tr = JSON.parse(fs.readFileSync(R + 'transcripts.json', 'utf8'));
const words = (s) => s.split(/\s+/).filter(Boolean);
const speech = (t) => words(t.replace(/\[[^\]]*\]|\([^)]*\)|[♪♫*]/g, ' ')).length >= 4;
const names = (g) => [...new Set(groups[g].slice(1).map((w) => titles[w]))].slice(0, 3).join('/');
const res = {};
for (const [key, v] of Object.entries(tr)) {
  const per = res[key] = { rows: [], stats: {} };
  for (const c of man) {
    const t = v.text[c.id]; if (t === undefined) continue;
    const holds = (g) => groups[g].slice(1).some((w) => c.accept.includes(titles[w]));
    const gs = m.evaluate(t), un = m.unsure(t);
    per.rows.push({ id: c.id, group: c.group, work: c.work, speech: speech(t), words: words(t).length, rules: gs.some(holds), unsure: un.some((u) => holds(u.g)),
      falseRules: gs.filter((g) => !holds(g)).map(names), falseUnsure: un.filter((u) => !holds(u.g)).map((u) => t.slice(u.s, u.e)), text: t });
  }
  for (const g of ['a', 'b', 'c']) {
    const r = per.rows.filter((x) => x.group === g);
    per.stats[g] = { n: r.length, noSpeech: r.filter((x) => !x.speech).length, rules: r.filter((x) => x.rules).length,
      rulesOrUnsure: r.filter((x) => x.rules || x.unsure).length, unsureOnly: r.filter((x) => !x.rules && x.unsure).length,
      falseRules: r.filter((x) => x.falseRules.length).length, falseUnsure: r.filter((x) => x.falseUnsure.length).length };
  }
}
fs.writeFileSync('research/results/speech-results.json', JSON.stringify(res, null, 1));
for (const [k, v] of Object.entries(res)) { console.log('==', k); console.table(v.stats); }
