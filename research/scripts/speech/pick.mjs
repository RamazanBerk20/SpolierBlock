// builds research/data/speech/manifest.json from cand/*.txt (deterministic)
import fs from 'node:fs'; const D = 'research/data/speech/';
const rd = (...fs_) => fs_.flatMap((f) => fs.readFileSync(D + 'cand/' + f + '.txt', 'utf8').split('\n').filter(Boolean).map((l) => { const [id, d, ...t] = l.split('|'); return { id, dur: +d, title: t.join('|') }; }));
const seen = new Set(), out = [];
const bad = /gta ?5|edgerunners|trailer|official|extended look|cover art|out now|features|netflix|concept|how to|make money|clipping|claude|ai clip|marathon|compilation|ost\b|soundtrack|hans zimmer|score|live :-/i;
const take = (group, work, accept, list, n, f) => { let k = 0; for (const c of list) { if (k >= n) break; if (seen.has(c.id) || !f(c) || bad.test(c.title) && group !== 'c') continue; if (group === 'c' && /ost\b|soundtrack|hans zimmer|score|theatre reaction|reaction|mashup|live/i.test(c.title)) continue; seen.add(c.id); out.push({ id: c.id, group, work, accept, dur: c.dur, title: c.title }); k++; } };
const short = (c) => c.dur > 0 && c.dur <= 90;
const GTA = ['Grand Theft Auto VI'];
take('a', 'Grand Theft Auto VI', GTA, rd('a_gta6_clip', 'a_gta6_funny', 'a_gta6_short', 'a2_gta6', 'a2_gta6b').filter((c) => /gta ?(6|vi)|grand theft auto (6|vi)/i.test(c.title)), 8, short);
take('a', 'Elden Ring', ['Elden Ring'], rd('a_elden', 'a2_elden').filter((c) => /elden/i.test(c.title)), 5, short);
take('a', 'Cyberpunk 2077', ['Cyberpunk 2077'], rd('a_cp', 'a2_cp').filter((c) => /cyberpunk/i.test(c.title)), 5, short);
take('b', 'Grand Theft Auto VI', GTA, rd('b_gta6').filter((c) => /gta ?(6|vi)/i.test(c.title)), 6, (c) => c.dur > 300 && c.dur < 5000);
take('b', 'Dune: Part Two', ['Dune: Part Two', 'Dune'], rd('b_dune'), 6, (c) => c.dur > 200);
take('b', 'Oppenheimer', ['Oppenheimer'], rd('b_opp'), 6, (c) => c.dur > 150);
take('c', 'Breaking Bad', ['Breaking Bad'], rd('c_bb').filter((c) => !/iconic scenes|best scene/i.test(c.title)), 6, (c) => c.dur <= 180);
take('c', 'Interstellar', ['Interstellar'], rd('c_int'), 6, (c) => c.dur <= 300);
take('c', 'Joker', ['Joker'], rd('c_joker').filter((c) => !/Gary Glitter|Downey|fan flock|fans flock|mashup/i.test(c.title)), 6, (c) => c.dur <= 180);
fs.writeFileSync(D + 'manifest.json', JSON.stringify(out, null, 1));
console.log(out.map((c) => `${c.group} ${c.work.slice(0, 12).padEnd(12)} ${c.id} ${c.dur}s ${c.title}`).join('\n'));
