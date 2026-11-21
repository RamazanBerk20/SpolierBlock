// Evaluates the "title in context" model (models/context), with the window rule of tools/context-train/window.mjs.
// VALIDATION ONLY: these files are public and tuned-on, never training rows.
// Default (the product's decision): a group counts when the rules accept it (Matcher.evaluate) OR it is one of the
// names the rules are unsure about (Matcher.unsure) AND the model says yes: p >= meta.threshold, or p >= meta.thresholdOther
// for a name the index flags "other" (bit 3 of the raw hit value: mostly a person, a place or a brand). Per file: the rules
// alone, the decision per bucket at meta's thresholds, a sweep over both thresholds, and every everyday row the model
// covers (name, group, probability). -v also lists the media rows still missed.
// --all-hits (the first evaluation): every raw hit (Matcher.scanTokens, whatever its flags) is asked:
//  - fp-posts.jsonl / headlines.jsonl rows: media rows count as found when a hit of a group holding the expected work
//    gets a yes (recall); non-media rows count as falsely covered when any hit gets a yes. "askable" leaves out hits the
//    matcher drops before any judgement (a #tag name without "#", a one-word character name in lowercase). For reference,
//    the same rows with today's matcher (Matcher.evaluate) alone, OR the model (a yes rescues a rejected name), and AND
//    the model (an accepted group must also get a yes; the model's group, before the matcher narrows it).
//  - context-val.jsonl rows ({ text, name, y, lang }, hand-written): the hits whose text is `name` must get y.
// usage: node tools/eval-context.mjs [modelDir=models/context] [files...] [-v] [--all-hits]
//   default files: test/fixtures/fp-posts.jsonl test/fixtures/headlines.jsonl test/fixtures/context-val.jsonl
import fs from 'node:fs';
import { buildIndex } from './build-index.mjs';
import { windowText, workText } from './context-train/window.mjs';
import { contextClassifier } from './context-train/classify.mjs';
const { Matcher, tokenize, KIND } = globalThis.SBMatcher;
const args = process.argv.slice(2), verbose = args.includes('-v');
const pos = args.filter((a) => !a.startsWith('-'));
const dir = pos[0] && !pos[0].endsWith('.jsonl') ? pos.shift() : 'models/context';
const files = pos.length ? pos : ['test/fixtures/fp-posts.jsonl', 'test/fixtures/headlines.jsonl', 'test/fixtures/context-val.jsonl'];
const { bin, meta } = buildIndex(JSON.parse(fs.readFileSync('data/catalog.json', 'utf8')));
const m = new Matcher(bin, meta), shift = m.fmt >= 2 ? 9 : 8, kmask = m.fmt >= 1 ? 7 : 15;
const { threshold, meta: cmeta, prob } = await contextClassifier(dir);
const thresholdOther = cmeta.thresholdOther ?? threshold, allHits = args.includes('--all-hits');
let calls = 0, ms = 0;
async function ask(text, s, e, g) {
  const t0 = performance.now(), p = await prob(windowText(text, s, e), workText(meta, g));
  ms += performance.now() - t0; calls++;
  return p;
}
async function scan(text) {
  const tk = tokenize(text), out = [];
  for (const h of m.scanTokens(tk)) {
    const s = tk.starts[h.i], e = tk.ends[h.i + h.n - 1], kind = h.v & kmask, g = h.v >>> shift;
    const askable = !(kind === KIND.TAG && text[s - 1] !== '#') && !((kind === KIND.CHAR1 || kind === KIND.PART) && !/^\p{Lu}/u.test(text.slice(s)));
    out.push({ s, e, g, askable, surface: text.slice(s, e), p: await ask(text, s, e, g) });
  }
  return out;
}
const pct = (a, n) => `${a} / ${n} (${(100 * a / (n || 1)).toFixed(1)}%)`;
for (const file of files) {
  const rows = fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
  const c0 = calls, m0 = ms;
  if (!allHits && !('name' in rows[0])) await product(file, rows);
  else if ('name' in rows[0]) { // hand-written per-name rows
    const by = new Map(); let absent = 0;
    for (const r of rows) {
      const hs = (await scan(r.text)).filter((h) => h.surface.toLowerCase().replace(/['’].*$/, '') === r.name.toLowerCase());
      if (!hs.length) { absent++; continue; }
      const yes = hs.some((h) => h.p >= threshold), k = `${r.lang === 'en' ? 'en' : 'non-en'} ${r.y ? 'title' : 'ordinary'}`;
      const e = by.get(k) ?? by.set(k, { n: 0, yes: 0 }).get(k); e.n++; if (yes) e.yes++;
      if (verbose && yes !== !!r.y) console.log(`${r.y ? 'MISS' : 'FALSE'}  ${hs.map((h) => `${workText(meta, h.g)} ${h.p.toFixed(2)}`).join(' | ')} :: ${r.text}`);
    }
    console.log(`${file}: threshold ${threshold}${absent ? `, ${absent} rows whose name is no catalog hit left out` : ''}`);
    for (const [k, e] of [...by].sort()) console.log(`  ${k.padEnd(16)} yes ${pct(e.yes, e.n)}  (${k.endsWith('title') ? 'recall' : 'false yes'})`);
  } else {
    const st = { media: {}, non: {} }, best = [], add = (o, k, bad) => { const e = (o[k] ??= { n: 0, bad: 0 }); e.n++; if (bad) e.bad++; };
    for (const r of rows) {
      const hs = await scan(r.text), lang = r.lang && r.lang !== 'en' ? 'non-en' : 'en';
      for (const [v, use] of [['all', hs], ['askable', hs.filter((h) => h.askable)]]) {
        if (r.media) {
          const mine = use.filter((h) => meta.groups[h.g].slice(1).some((w) => meta.titles[w] === r.expect));
          add(st.media, `${v} ${lang}`, !mine.some((h) => h.p >= threshold));
          add(st.media, `${v} ${lang} (found by a raw hit)`, !mine.length);
          if (v === 'all') best.push({ media: true, p: Math.max(0, ...mine.map((h) => h.p)) });
          if (v === 'all') { // with today's matcher: the model rescues names it rejects (OR), or vets the ones it accepts (AND)
            const acc = m.evaluate(r.text).filter((g) => meta.groups[g].slice(1).some((w) => meta.titles[w] === r.expect));
            add(st.media, `matcher ${lang}`, !acc.length);
            add(st.media, `matcher OR model ${lang}`, !acc.length && !mine.some((h) => h.p >= threshold));
            add(st.media, `matcher AND model ${lang}`, !acc.some((g) => mine.some((h) => h.g === g && h.p >= threshold)));
          }
          if (verbose && v === 'all' && !mine.some((h) => h.p >= threshold)) console.log(`MISS  [${r.expect}] ${mine.map((h) => `${h.surface} ${h.p.toFixed(2)}`).join(' | ') || '(no raw hit)'} :: ${r.text.slice(0, 140)}`);
        } else {
          const yes = use.filter((h) => h.p >= threshold);
          add(st.non, `${v} ${r.topic ?? 'non-media'}`, yes.length > 0);
          add(st.non, `${v} TOTAL`, yes.length > 0);
          if (v === 'all') best.push({ media: false, p: Math.max(0, ...use.map((h) => h.p)) });
          if (v === 'all') {
            const acc = m.evaluate(r.text);
            add(st.non, 'matcher TOTAL', acc.length > 0);
            add(st.non, 'matcher OR model TOTAL', acc.length > 0 || yes.length > 0);
            add(st.non, 'matcher AND model TOTAL', acc.some((g) => yes.some((h) => h.g === g)));
          }
          if (verbose && v === 'all' && yes.length) console.log(`FP    ${yes.map((h) => `${h.surface}=${workText(meta, h.g)} ${h.p.toFixed(2)}`).join(' | ')} :: ${r.text.slice(0, 140)}`);
        }
      }
    }
    console.log(`${file}: threshold ${threshold}`);
    for (const [k, e] of Object.entries(st.media).sort()) console.log(`  media ${k.padEnd(34)} ${k.includes('raw hit') ? 'found ' : 'recall'} ${pct(e.n - e.bad, e.n)}`);
    for (const [k, e] of Object.entries(st.non).sort()) console.log(`  non-media ${k.padEnd(30)} covered ${pct(e.bad, e.n)}`);
    // the model alone, all hits, at other thresholds: media recall / non-media rows covered
    const at = (t) => { const P = best.filter((b) => b.media), N = best.filter((b) => !b.media); return `${(P.filter((b) => b.p >= t).length / (P.length || 1)).toFixed(3)} / ${(N.filter((b) => b.p >= t).length / (N.length || 1)).toFixed(3)}`; };
    console.log('  model alone by threshold (media recall / non-media covered): ' + [0.5, 0.81, 0.9, 0.95, 0.98, 0.99, 0.995, 0.999].map((t) => `${t}: ${at(t)}`).join(', '));
  }
  console.log(`  ${calls - c0} model calls, ${((ms - m0) / (calls - c0 || 1)).toFixed(1)} ms per call (onnxruntime-web, 1 thread, Node)`);
}

// ---- the product's decision: rules OR (unsure AND model) ----
async function product(file, rows) {
  const holds = (g, r) => meta.groups[g].slice(1).some((w) => meta.titles[w] === r.expect);
  const data = [];
  for (const r of rows) {
    const acc = m.evaluate(r.text), tk = tokenize(r.text), raw = m.scanTokens(tk), uns = [];
    for (const u of m.unsure(r.text)) {
      const h = raw.find((x) => tk.starts[x.i] === u.s && tk.ends[x.i + x.n - 1] === u.e);
      uns.push({ ...u, other: !!(h && m.fmt >= 1 && (h.v >>> 3) & 1), name: r.text.slice(u.s, u.e), p: await ask(r.text, u.s, u.e, u.g) });
    }
    data.push({ r, uns, lang: r.lang && r.lang !== 'en' ? 'non-en' : 'en', rules: r.media ? acc.some((g) => holds(g, r)) : acc.length > 0 });
  }
  const yes = (u, t, to) => u.p >= (u.other ? to : t);
  const ok = (d, t, to) => d.r.media ? d.rules || d.uns.some((u) => holds(u.g, d.r) && yes(u, t, to)) : d.rules || d.uns.some((u) => yes(u, t, to));
  const media = data.filter((d) => d.r.media), non = data.filter((d) => !d.r.media);
  const line = (t, to) => { const f = media.filter((d) => ok(d, t, to)).length, c = non.filter((d) => ok(d, t, to)).length;
    return `found ${f}/${media.length} (${(100 * f / (media.length || 1)).toFixed(1)}%), everyday covered ${c}/${non.length} (${(100 * c / (non.length || 1)).toFixed(1)}%)`; };
  console.log(`${file}: product decision; ${data.reduce((a, d) => a + d.uns.length, 0)} unsure names (${data.reduce((a, d) => a + d.uns.filter((u) => u.other).length, 0)} "other"), ` +
    `${(non.reduce((a, d) => a + d.uns.length, 0) / (non.length || 1)).toFixed(2)} per everyday row`);
  console.log(`  rules alone:                    ${line(2, 2)}`);
  console.log(`  rules OR model at ${threshold} / other ${thresholdOther}: ${line(threshold, thresholdOther)}`);
  const by = new Map();
  for (const d of data) {
    const k = d.r.media ? `media ${d.lang}` : `everyday ${d.r.topic ?? 'all'}`, e = by.get(k) ?? by.set(k, { n: 0, rules: 0, both: 0 }).get(k);
    e.n++; if (d.rules) e.rules++; if (ok(d, threshold, thresholdOther)) e.both++;
  }
  for (const [k, e] of [...by].sort()) console.log(`    ${k.padEnd(22)} n=${String(e.n).padStart(3)}  rules ${String(e.rules).padStart(3)}  with model ${String(e.both).padStart(3)}  (${k.startsWith('media') ? 'found' : 'covered'})`);
  const T = [0.5, 0.7, 0.81, 0.9, 0.95, 0.97, 0.98, 0.99, 0.995, 0.998, 0.999];
  console.log('  sweep, one threshold for all names:');
  for (const t of T) console.log(`    ${String(t).padEnd(6)} ${line(t, t)}`);
  console.log(`  sweep of the "other" threshold at ${threshold}:`);
  for (const to of T.concat([1.01])) console.log(`    ${String(to === 1.01 ? 'never' : to).padEnd(6)} ${line(threshold, to)}`);
  for (const d of non) {
    const ys = d.uns.filter((u) => yes(u, threshold, thresholdOther));
    if (!d.rules && ys.length) console.log(`  FALSE YES  ${ys.map((u) => `"${u.name}"=${workText(meta, u.g)} ${u.p.toFixed(3)}${u.other ? ' other' : ''}`).join(' | ')} :: ${d.r.text.replace(/\s+/g, ' ').slice(0, 150)}`);
    else if (d.rules && verbose) console.log(`  RULES COVER ${m.evaluate(d.r.text).map((g) => meta.groups[g][0]).join(' | ')} :: ${d.r.text.replace(/\s+/g, ' ').slice(0, 150)}`);
  }
  if (verbose) for (const d of media.filter((x) => !ok(x, threshold, thresholdOther))) console.log(`  MISS [${d.r.expect}] ${d.uns.map((u) => `"${u.name}" ${u.p.toFixed(3)}`).join(' | ') || '(not unsure)'} :: ${d.r.text.replace(/\s+/g, ' ').slice(0, 150)}`);
}
