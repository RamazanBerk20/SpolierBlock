// Prototype: identify the work a post is about when it names nothing, using shipped plot knowledge.
// (a) dense: sentence embeddings of Wikipedia plot sentences, work score = max cosine; (b) lexical: distinctive plot
// entities (proper nouns) per work; (c) both. Measures top-1 on matcher-blind queries and false triggers on ordinary prose.
// usage: node scripts/plot-eval.mjs <embedding model id under models/hf> [pooling=mean] [prefix-query] [prefix-doc]
import fs from 'node:fs';
import path from 'node:path';
import { env, pipeline } from '@huggingface/transformers';
import { buildIndex } from '../../tools/build-index.mjs';
const R = path.resolve(import.meta.dirname, '..');
env.allowRemoteModels = false; env.localModelPath = R + '/models/hf/';
const [mid = 'Xenova/all-MiniLM-L6-v2', pooling = 'mean', qpre = '', dpre = ''] = process.argv.slice(2);
const { Matcher, tokenize } = globalThis.SBMatcher;
const catalog = JSON.parse(fs.readFileSync(R + '/../data/catalog.json'));
const built = buildIndex(catalog);
const m = new Matcher(built.bin, built.meta);
const G = built.meta.groups;
const worksOf = (title) => { const s = new Set(); G.forEach((g) => { if (g[0] === title) g.slice(1).forEach((w) => s.add(w)); }); built.meta.titles.forEach((t, w) => { if (t === title) s.add(w); }); return s; };
const splitS = (t) => t.replace(/\s+/g, ' ').split(/(?<=[.!?])\s+(?=[A-Z"“])/).map((s) => s.trim()).filter((s) => s.length >= 20 && s.length <= 400);

// ---- plot DB ----
const plots = JSON.parse(fs.readFileSync(R + '/data/plots/plots.json'));
const SM = { 'Arcane': 'arcane', 'Attack on Titan': 'attack_on_titan', 'The Legend of Korra': 'legend_of_korra', 'Kaguya-sama: Love Is War': 'kaguya_sama_love_is_war' };
const summaries = JSON.parse(fs.readFileSync(R + '/data/spoiler-matching/matching/handlabeled_only/summaries.json'));
const db = []; // { work, sents }
for (const [t, p] of Object.entries(plots)) {
  let text = p.text;
  if (SM[t]) text += '\n' + summaries.filter((s) => s[0] === SM[t]).map((s) => s[2]).join('\n');
  let s = splitS(text);
  if (s.length < 5) continue;
  if (s.length > 400) s = s.filter((_, i) => i % Math.ceil(s.length / 400) === 0);
  db.push({ work: t, sents: s });
}
const dbWorks = new Set(db.map((d) => d.work));
const nS = db.reduce((a, d) => a + d.sents.length, 0);

// ---- queries (matcher-blind) ----
const KEEP_KINDS = new Set([4, 6]); // CHAR1 / PART (first names) stay in the post, like real posts
function strip(text, target) {
  let t = text;
  for (let it = 0; it < 3; it++) {
    const tk = tokenize(t), spans = [];
    for (const h of m.scanTokens(tk)) { if (KEEP_KINDS.has(h.v & 15)) continue; if (G[h.v >>> 7].slice(1).some((w) => target.has(w))) spans.push([tk.starts[h.i], tk.ends[h.i + h.n - 1]]); }
    if (!spans.length) break;
    spans.sort((a, b) => b[0] - a[0]);
    for (const [s, e] of spans) t = t.slice(0, s) + t.slice(e);
    t = t.replace(/#(?=\s|$)/g, '').replace(/\s{2,}/g, ' ').replace(/\s+([,.!?])/g, '$1').trim();
  }
  return t;
}
const blind = (text, target) => !m.evaluate(text).some((g) => G[g].slice(1).some((w) => target.has(w)));
const Q = { probe: [], evalPos: [], evalNeg: [], reddit: [] };
for (const t of ["I wasn't ready for that last ride. Boah.", 'Arthur deserved better. That sunrise scene destroyed me.', 'He just wanted to be a good man in the end. Blessed are those who hunger and thirst for righteousness.']) Q.probe.push({ text: t, work: 'Red Dead Redemption 2' });
for (const r of fs.readFileSync(R + '/results/snap/spoiler-eval.jsonl', 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))) {
  if (!dbWorks.has(r.work)) continue;
  const tg = worksOf(r.work); const s = strip(r.text, tg);
  if (s.split(/\s+/).length >= 5 && blind(s, tg)) (r.label ? Q.evalPos : Q.evalNeg).push({ text: s, work: r.work, orig: r.text });
}
const inv = Object.fromEntries(Object.entries(SM).map(([a, b]) => [b, a]));
const per = {};
for (const [show, , c] of JSON.parse(fs.readFileSync(R + '/data/spoiler-matching/matching/handlabeled_only/test.json'))) {
  const w = inv[show]; if (!w || !dbWorks.has(w) || c.length < 40 || c.length > 300) continue;
  per[w] = (per[w] ?? 0) + 1; if (per[w] > 100) continue;
  if (blind(c, worksOf(w))) Q.reddit.push({ text: c, work: w });
}
// ordinary prose (same corpus as tools/fp-text.mjs), first 3000 sentences after a fixed shuffle
const corpus = [];
for (const f of fs.readdirSync(R + '/../build/corpus').filter((f) => f.startsWith('wiki-'))) for (const p of Object.values(JSON.parse(fs.readFileSync(R + '/../build/corpus/' + f)).query.pages)) corpus.push(...splitS((p.extract ?? '').split(/\n==+ (See also|References|In popular culture|In fiction)/)[0]));
let seed = 7; const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
const ordinary = corpus.map((s) => [rnd(), s]).sort((a, b) => a[0] - b[0]).slice(0, 3000).map((x) => x[1]);
console.log(`plot DB: ${db.length} works, ${nS} sentences | queries: probe ${Q.probe.length}, evalPos ${Q.evalPos.length}, evalNeg ${Q.evalNeg.length}, reddit ${Q.reddit.length} | ordinary ${ordinary.length}`);

// ---- (b) lexical entities ----
const common = fs.readFileSync(R + '/../tools/catalog/20k.txt', 'utf8').split('\n').map((w) => w.trim().toLowerCase());
const top10k = new Set(common.slice(0, 10000)), all20k = new Set(common);
const ENT = /\b\p{Lu}[\p{L}'’-]+(?:\s+(?:of|the|de|van|der|la|von|du)?\s*\p{Lu}[\p{L}'’-]+){0,3}/gu;
const entWorks = new Map();
for (const d of db) {
  const seen = new Set();
  for (const s of d.sents) for (const mm of s.matchAll(ENT)) {
    const e = mm[0].replace(/['’]s$/, ''), toks = e.toLowerCase().split(/\s+/);
    if (toks.length === 1 && (toks[0].length < 3 || top10k.has(toks[0]))) continue;
    if (toks.every((x) => top10k.has(x))) continue;
    seen.add(toks.join(' '));
  }
  for (const e of seen) { if (!entWorks.has(e)) entWorks.set(e, new Set()); entWorks.get(e).add(d.work); }
}
for (const [e, ws] of entWorks) if (ws.size > 2) entWorks.delete(e); // keep distinctive entities only
const maxN = 4;
function entScore(text) {
  const tk = tokenize(text), toks = tk.toks, sc = new Map();
  for (let i = 0; i < toks.length; i++) for (let n = 1; n <= maxN && i + n <= toks.length; n++) {
    const k = toks.slice(i, i + n).join(' '), ws = entWorks.get(k); if (!ws) continue;
    // single words that are ordinary English need a capital letter in the post
    if (n === 1 && all20k.has(k) && !/^\p{Lu}/u.test(text.slice(tk.starts[i]))) continue;
    for (const w of ws) { if (!sc.has(w)) sc.set(w, new Set()); sc.get(w).add(k); }
  }
  const best = [...sc].sort((a, b) => b[1].size - a[1].size)[0];
  return best ? { w: best[0], n: best[1].size, ents: [...best[1]] } : { w: null, n: 0, ents: [] };
}

// ---- (a) dense ----
const rss = () => Math.round(process.memoryUsage().rss / 1e6);
const fe = await pipeline('feature-extraction', mid, { dtype: 'q8' });
const emb = async (texts, pre) => { const out = []; for (let i = 0; i < texts.length; i += 64) out.push(...(await fe(texts.slice(i, i + 64).map((t) => pre + t), { pooling, normalize: true })).tolist()); return out; };
let t0 = performance.now();
const dbE = []; for (const d of db) dbE.push(await emb(d.sents, dpre));
const buildMs = performance.now() - t0;
const dim = dbE[0][0].length;
const q8 = dbE.map((M) => M.map((v) => Int8Array.from(v, (x) => Math.max(-127, Math.min(127, Math.round(x * 127))))));
async function dense(texts) {
  const E = await emb(texts, qpre);
  return E.map((v) => {
    const s = q8.map((M) => { let b = -1; for (const r of M) { let d = 0; for (let j = 0; j < dim; j++) d += r[j] * v[j]; if (d > b) b = d; } return b / 127; });
    const order = s.map((x, i) => [x, i]).sort((a, b) => b[0] - a[0]);
    return { w: db[order[0][1]].work, s: order[0][0], top3: order.slice(0, 3).map((o) => db[o[1]].work), gap: order[0][0] - order[1][0] };
  });
}
t0 = performance.now();
const ordD = await dense(ordinary);
const qMs = (performance.now() - t0) / ordinary.length;
const pct = (a, q) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(q * s.length))]; };
const thr = { 'fp0.1%': pct(ordD.map((x) => x.s), 0.999), 'fp1%': pct(ordD.map((x) => x.s), 0.99) };
const ordE = ordinary.map(entScore);
const entFP = { '>=1': ordE.filter((x) => x.n >= 1).length, '>=2': ordE.filter((x) => x.n >= 2).length };
console.log(`model ${mid} dim ${dim}: DB embed ${(buildMs / 1000).toFixed(0)} s, query ${qMs.toFixed(1)} ms (node, incl. scan of ${nS} int8 rows), RSS ${rss()} MB, shipped DB ${(nS * dim / 1e6).toFixed(1)} MB int8`);
console.log(`dense thresholds: ${Object.entries(thr).map(([k, v]) => `${k}=${v.toFixed(3)}`).join(' ')} | entities kept ${entWorks.size}; ordinary sentences triggering a work: >=1 ent ${entFP['>=1']}/3000, >=2 ents ${entFP['>=2']}/3000`);
const rows = [];
for (const [k, qs] of Object.entries(Q)) {
  if (!qs.length) continue;
  const D = await dense(qs.map((q) => q.text)), Ls = qs.map((q) => entScore(q.text));
  const ok = (i, w) => w === qs[i].work;
  const r = { set: k, n: qs.length,
    dense_top1: D.filter((d, i) => ok(i, d.w)).length, dense_top3: D.filter((d, i) => d.top3.includes(qs[i].work)).length,
    dense_at_fp1: D.filter((d, i) => ok(i, d.w) && d.s >= thr['fp1%']).length, dense_at_fp01: D.filter((d, i) => ok(i, d.w) && d.s >= thr['fp0.1%']).length,
    ent_ge1: Ls.filter((l, i) => l.n >= 1 && ok(i, l.w)).length, ent_ge1_wrong: Ls.filter((l, i) => l.n >= 1 && !ok(i, l.w)).length, ent_ge2: Ls.filter((l, i) => l.n >= 2 && ok(i, l.w)).length,
    // combined: 2 entities, or 1 entity agreeing with the dense top-1, or dense alone above the 0.1% threshold
    combo: qs.filter((_, i) => { const l = Ls[i], d = D[i]; const w = l.n >= 2 ? l.w : (l.n === 1 && l.w === d.w) ? l.w : d.s >= thr['fp0.1%'] ? d.w : null; return w === qs[i].work; }).length };
  rows.push(r); console.log(JSON.stringify(r));
  if (k === 'probe') qs.forEach((q, i) => console.log('  probe:', q.text.slice(0, 60), '-> dense', D[i].w, D[i].s.toFixed(3), D[i].top3.join(' / '), '| ent', Ls[i].w, Ls[i].ents.join(',')));
}
const comboFP = ordinary.filter((_, i) => { const l = ordE[i], d = ordD[i]; return l.n >= 2 || (l.n === 1 && l.w === d.w) || d.s >= thr['fp0.1%']; }).length;
console.log(`combo false triggers on ordinary prose: ${comboFP}/3000`);
fs.mkdirSync(R + '/results/plot', { recursive: true });
fs.writeFileSync(`${R}/results/plot/${mid.split('/').pop()}.json`, JSON.stringify({ mid, rows, thr, entFP, comboFP, nS, dim, works: db.length, samples: Object.fromEntries(Object.entries(Q).map(([k, v]) => [k, v.slice(0, 5)])) }, null, 1));
