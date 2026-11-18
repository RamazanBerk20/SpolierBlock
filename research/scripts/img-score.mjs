// Scores cached embeddings (results/emb/<tag>.json): zero-shot title accuracy + gallery (image-to-image) retrieval.
// usage: node scripts/img-score.mjs <tag...>
import fs from 'node:fs';
import path from 'node:path';
const R = path.resolve(import.meta.dirname, '..');
const { rows } = JSON.parse(fs.readFileSync(R + '/results/rows.json'));
const imgs = JSON.parse(fs.readFileSync(R + '/results/images.json'));
const dot = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s; };
const targetWorks = new Map();
const tw = (want) => { if (!targetWorks.has(want)) targetWorks.set(want, new Set(rows.filter((r) => r.title === want).flatMap((r) => r.works))); return targetWorks.get(want); };
const correct = (ri, want) => rows[ri].works.some((w) => tw(want).has(w));
const pct = (a, q) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(q * s.length))]; };
const auc = (pos, neg) => { let s = 0; for (const a of pos) for (const b of neg) s += a > b ? 1 : a === b ? 0.5 : 0; return s / (pos.length * neg.length); };
const out = [];
for (const tag of process.argv.slice(2)) {
  const E = JSON.parse(fs.readFileSync(`${R}/results/emb/${tag}.json`));
  const q = E.rowEmb.map((r) => r.map((x) => Math.round(x * 127) / 127)); // int8 rows as shipped
  const res = imgs.filter((x) => E.imgEmb[x.file]).map((x) => {
    const v = E.imgEmb[x.file];
    const neg = Math.max(...E.neg.map((t) => dot(t, v)));
    const media = Math.max(...E.media.map((t) => dot(t, v))) - neg;
    const sc = q.map((r, k) => [dot(r, v), E.rowIdx[k]]).sort((a, b) => b[0] - a[0]);
    const sc2k = sc.filter(([, ri]) => ri < 2000);
    return { ...x, neg, media, best: sc[0][0], top: sc.slice(0, 5).map((s) => s[1]), best2k: sc2k[0][0], top2k: sc2k[0][1], v };
  });
  const M = res.filter((r) => r.want), O = res.filter((r) => !r.want);
  const line = { tag, media: M.length, ordinary: O.length };
  for (const sub of ['fixture', 'cosplay', 'lead']) {
    const S = M.filter((r) => r.src === sub);
    line[`top1_${sub}`] = `${S.filter((r) => correct(r.top[0], r.want)).length}/${S.length}`;
    line[`top5_${sub}`] = `${S.filter((r) => r.top.some((t) => correct(t, r.want))).length}/${S.length}`;
  }
  line.aucMediaGate = +auc(M.map((r) => r.media), O.map((r) => r.media)).toFixed(3);
  line.aucTitleMargin = +auc(M.map((r) => r.best - r.neg), O.map((r) => r.best - r.neg)).toFixed(3);
  // operating points: threshold on (best title - best generic) at 0 / 2% of ordinary images blocked
  for (const [nm, thr] of [['fp0', Math.max(...O.map((r) => r.best - r.neg)) + 1e-6], ['fp2', pct(O.map((r) => r.best - r.neg), 0.98)]]) {
    const hit = M.filter((r) => r.best - r.neg >= thr);
    line[`${nm}_right`] = hit.filter((r) => correct(r.top[0], r.want)).length;
    line[`${nm}_wrongOrGeneric`] = hit.length - line[`${nm}_right`];
    line[`${nm}_missed`] = M.length - hit.length;
  }
  // shipped-coverage view: only the 2000 most popular rows exist
  const in2k = M.filter((r) => rows.findIndex((x) => x.title === r.want) < 2000);
  line.top1_in2k = `${in2k.filter((r) => correct(r.top2k, r.want)).length}/${in2k.length}`;
  // gallery retrieval: gallery = lead + c0..c3 of each Commons work; queries = c4..c7 + fixture media of gallery works
  const gal = res.filter((r) => r.want && (r.src === 'lead' || (r.src === 'cosplay' && +r.file.match(/c(\d+)\.jpg$/)[1] < 4)));
  const gw = new Set(gal.map((r) => r.want));
  const Q = res.filter((r) => r.want && gw.has(r.want) && !gal.includes(r));
  const nn = (v) => { const best = new Map(); for (const g of gal) best.set(g.want, Math.max(best.get(g.want) ?? -1, dot(g.v, v))); const s = [...best].sort((a, b) => b[1] - a[1]); return { w: s[0][0], s: s[0][1], gap: s[0][1] - s[1][1] }; };
  const qn = Q.map((r) => ({ r, ...nn(r.v) })), on = O.map((r) => nn(r.v));
  line.gal_queries = Q.length; line.gal_top1 = qn.filter((x) => x.w === x.r.want).length;
  line.gal_top1_fixture = `${qn.filter((x) => x.r.src === 'fixture' && x.w === x.r.want).length}/${qn.filter((x) => x.r.src === 'fixture').length}`;
  const gthr = Math.max(...on.map((x) => x.s)) + 1e-6;
  line.gal_fp0_right = qn.filter((x) => x.s >= gthr && x.w === x.r.want).length;
  line.gal_fp0_wrong = qn.filter((x) => x.s >= gthr && x.w !== x.r.want).length;
  out.push(line);
  console.log(JSON.stringify(line));
}
fs.appendFileSync(R + '/results/img-score.jsonl', out.map((l) => JSON.stringify(l)).join('\n') + '\n');
