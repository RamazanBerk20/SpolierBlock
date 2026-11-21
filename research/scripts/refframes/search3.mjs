// More real-life video for head.mjs (the calibration of the footage head's cut): one clip per search, as search2.mjs.
// Writes research/scripts/refframes/videos3.json: [id, cat, "train", "start-end", title, "real"]. Music videos, adverts,
// documentaries and talk shows are "real" here on purpose: the catalog leaves them out, so covering them is a false cover.
// usage (repo root): node research/scripts/refframes/search3.mjs
import fs from 'node:fs';
import { execFile } from 'node:child_process';
const Q = { 'music-video': 'official music video', 'music-video-2': 'pop song official video 4k', advert: 'tv commercials compilation', documentary: 'nature documentary narrated full',
  'talk-show': 'late night show interview', standup: 'stand up comedy full set', tennis: 'tennis match highlights', boxing: 'boxing fight highlights',
  'football-2': 'la liga match highlights', 'american-football': 'nfl game highlights', unboxing: 'smartphone unboxing review', 'screen-excel': 'excel tutorial for beginners',
  'screen-code': 'python tutorial coding screen', lecture: 'university lecture full', talk: 'conference talk presentation', drawing: 'drawing timelapse art',
  woodworking: 'woodworking project build', fishing: 'fishing trip video', 'street-food': 'street food tour', travel: 'travel vlog italy', hiking: 'hiking trail gopro',
  skate: 'skateboarding street video', dance: 'dance practice video', asmr: 'asmr video', toys: 'kids toys play video', family: 'family home video baby',
  mukbang: 'mukbang eating show', haul: 'clothing haul try on', 'music-cover': 'guitar cover acoustic', cctv: 'security camera footage caught', protest: 'protest raw footage',
  storm: 'storm chasing tornado footage', zoo: 'zoo animals video', farming: 'farming tractor harvest', construction: 'construction site timelapse',
  'train-cab': 'train cab ride 4k', cockpit: 'cockpit landing pilot view', airshow: 'air show highlights', 'drone-city': 'city at night drone 4k',
  'house-tour': 'house tour real estate', archive: 'history documentary archive footage' };
const have = new Set(['videos.json', 'videos2.json'].flatMap((f) => JSON.parse(fs.readFileSync(`research/scripts/refframes/${f}`, 'utf8')).map((r) => r[0])));
const search = (q) => new Promise((res) => execFile('yt-dlp', [`ytsearch8:${q}`, '--flat-playlist', '--print', '%(id)s|%(duration)s|%(title)s'],
  { maxBuffer: 1 << 22 }, (_, out) => res((out ?? '').trim().split('\n').map((l) => l.split('|')).filter((x) => x.length >= 3))));
const out = [], rows = Object.entries(Q);
for (let i = 0; i < rows.length; i += 6) {
  const found = await Promise.all(rows.slice(i, i + 6).map(async ([cat, q]) => [cat, (await search(q)).filter(([, d]) => +d >= 200 && +d <= 14400)]));
  for (const [cat, ok] of found) {
    const pick = ok.find(([id]) => !have.has(id));
    if (!pick) { console.error('NO RESULT', cat); continue; }
    have.add(pick[0]);
    const d = +pick[1], start = d > 600 ? 120 : 40;
    out.push([pick[0], cat, 'train', `${start}-${start + 150}`, pick.slice(2).join('|').slice(0, 70), 'real']);
  }
}
fs.writeFileSync('research/scripts/refframes/videos3.json', '[\n' + out.map((r) => '  ' + JSON.stringify(r)).join(',\n') + '\n]\n');
for (const r of out) console.log(r[1].padEnd(20), r[0], r[4]);
console.log(out.length, 'of', rows.length);
