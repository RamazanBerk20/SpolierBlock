// Mock of query.wikidata.org/sparql for the catalog update tests: a small invented "world" of new works answered
// for the exact query shapes of src/background/catalog-update.js. Used in-process by tools/catalog-vectors.mjs and,
// run directly, as the HTTP server the demo app's test build talks to:
//   node android/tools/mock-sparql.mjs [port=8765]
//   curl localhost:8765/mode?set=ok|429|malformed      answer mode;  curl localhost:8765/stats   request count
import http from 'node:http';

const D = (y, m = '01', d = '01') => `${y}-${m}-${d}T00:00:00Z`;
// id, labels, classes (P31), sitelinks, dates per property, aliases [label, lang], characters (P674) / fallback (P1441)
export const WORLD = [
  { id: 'Q900000001', en: 'Zorblax Chronicles', cls: ['Q11424'], sl: 42, dates: { P577: [D(2026, '03')] },
    aliases: [['Zorblax', 'en'], ['Zorblax Chronicles', 'mul']], chars: [['Captain Vexa Morn', 12], ['Doctor Ilo Brask', 5], ['Zed', 50]] },
  // a sequel: must join the bundled "Star Wars" series group, so "I've seen Star Wars" covers it too
  { id: 'Q900000002', en: 'Star Wars: Episode X – Dawn of Echoes', cls: ['Q11424'], sl: 60, dates: { P577: [D(2027, '12', '17')] },
    fallbackChars: [['Rey Skywalker', 30]] },
  // label only in "mul"; numbered aliases
  { id: 'Q900000003', mul: 'Grand Theft Auto VII', cls: ['Q7889'], sl: 30, dates: { P577: [D(2028)] }, aliases: [['GTA VII', 'en'], ['GTA 7', 'mul']] },
  { id: 'Q900000004', en: 'Some Person', cls: ['Q5'], sl: 100, dates: { P577: [D(2026)] } }, // not a media type
  { id: 'Q1079', en: 'Breaking Bad', cls: ['Q5398426'], sl: 187, dates: { P580: [D(2025)] } }, // already bundled
  { id: 'Q900000005', en: 'The Glass Orchard', cls: ['Q11424', 'Q5398426'], sl: 20, dates: { P580: [D(2026, '05')], P577: [D(2027, '02')] } }, // tv wins
  { id: 'Q900000006', en: '2027', cls: ['Q11424'], sl: 16, dates: { P577: [D(2027)] } }, // digits-only title: dropped
  { id: 'Q900000007', en: 'Moonlit Kitsune Academy', cls: ['Q63952888'], sl: 25, dates: { P571: [D(2026, '07')] } },
  { id: 'Q900000008', en: 'It', cls: ['Q7725634'], sl: 15, dates: { P577: [D(2026, '09')] } }, // ambiguous
  // alias and character caps, ordering and filters of finalizeWork
  { id: 'Q900000009', en: 'Hollow Crown Saga', cls: ['Q5398426'], sl: 45, dates: { P580: [D(2026, '10')] },
    aliases: [['HC', 'en'], ['hollow crown saga', 'en'], ['The Hollow Crown Saga Extended', 'mul'], ['HCS', 'en'], ['hcs', 'mul'], ['Hollow Crown', 'en'],
      ['Crown Saga', 'en'], ['The Saga of the Hollow Crown', 'en'], ['Hollow Saga', 'mul'], ['THCS', 'en'], ['Krone', 'mul'], ['La Corona Hueca', 'mul'], ['Saga', 'en']],
    chars: [['Queen Mara Vell', 40], ['Sir Odric Fane', 90], ['Ash', 99], ['Lady Corin Wex', 40], ['Tomas Brightwater', 3], ['Old Gant', 12],
      ['Prince Elio Vane', 55], ['Captain Rusk', 7], ['Wren of Haldor', 21], ['Sister Imma Kell', 30], ['Sir Odric Fane', 90]] },
];

const uri = (id) => `http://www.wikidata.org/entity/${id}`;
const lit = (v, extra = {}) => ({ type: 'literal', value: String(v), ...extra });
const ids = (q) => (/VALUES \?w \{ ([^}]*) \}/.exec(q)?.[1] ?? '').split(' ').filter(Boolean).map((x) => x.slice(3));

export function rows(q) {
  const byId = new Map(WORLD.map((w) => [w.id, w]));
  const pick = () => ids(q).map((i) => byId.get(i)).filter(Boolean);
  const delta = /wdt:(P\d+) \?d \. hint:Prior/.exec(q);
  if (delta) {
    const since = Number(/FILTER\(\?d >= "(\d+)-/.exec(q)[1]);
    return WORLD.filter((w) => (w.dates[delta[1]] ?? []).some((d) => Number(d.slice(0, 4)) >= since))
      .flatMap((w) => w.cls.map((c) => ({ item: { type: 'uri', value: uri(w.id) }, cls: { type: 'uri', value: uri(c) }, sl: lit(w.sl) })));
  }
  if (q.includes('rdfs:label ?en')) return pick().map((w) => ({ w: { type: 'uri', value: uri(w.id) },
    ...(w.en ? { en: lit(w.en, { 'xml:lang': 'en' }) } : {}), ...(w.mul ? { mul: lit(w.mul, { 'xml:lang': 'mul' }) } : {}) }));
  if (q.includes('UNION')) return pick().flatMap((w) => Object.values(w.dates).flat().map((d) => ({ w: { type: 'uri', value: uri(w.id) }, d: lit(d) })));
  if (q.includes('skos:altLabel')) return pick().flatMap((w) => (w.aliases ?? []).map(([a, l]) => ({ w: { type: 'uri', value: uri(w.id) }, a: lit(a, { 'xml:lang': l }) })));
  const chars = q.includes('wdt:P674') ? 'chars' : q.includes('wdt:P1441') ? 'fallbackChars' : null;
  if (chars) return pick().flatMap((w) => (w[chars] ?? []).map(([n, s]) => ({ w: { type: 'uri', value: uri(w.id) }, cl: lit(n, { 'xml:lang': 'en' }), cs: lit(s) })));
  throw new Error('unknown query: ' + q.slice(0, 80));
}

export const answer = (q) => JSON.stringify({ head: { vars: [] }, results: { bindings: rows(q) } });

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.argv[2] ?? 8765);
  let mode = 'ok', requests = 0;
  http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/mode') { mode = url.searchParams.get('set') ?? mode; requests = 0; res.end(mode + '\n'); return; }
    if (url.pathname === '/stats') { res.end(JSON.stringify({ mode, requests }) + '\n'); return; }
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      requests++;
      const q = new URLSearchParams(body).get('query') ?? '';
      console.log(`${new Date().toISOString()} ${mode} ua="${req.headers['user-agent']}" cookie=${req.headers.cookie ?? '-'} ${q.split('\n')[0].slice(0, 70)}`);
      if (mode === '429') { res.writeHead(429, { 'Retry-After': '1' }); res.end('busy'); return; }
      if (mode === 'malformed') { res.writeHead(200, { 'Content-Type': 'application/sparql-results+json' }); res.end('{"results": {"bindings": [ {"w": '); return; }
      res.writeHead(200, { 'Content-Type': 'application/sparql-results+json' });
      res.end(answer(q));
    });
  }).listen(port, () => console.log(`mock SPARQL on :${port}`));
}
