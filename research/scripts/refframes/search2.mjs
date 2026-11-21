// Picks the wider test set for footage.mjs: one YouTube search per row, the first result of 90 s to 2 h, a 150 s
// section after the intro. Writes research/scripts/refframes/videos2.json: [id, cat, split, "start-end", title, kind].
// kind: game | real | anime | animation | live (live-action film or series). split: train | test, decided here, by
// work for media (a game is on one side only) and by video for real life; "only" = a real-life category that is
// test-only. Nothing is chosen by looking at results.
// usage (repo root): node research/scripts/refframes/search2.mjs
import fs from 'node:fs';
import { execFile } from 'node:child_process';

const G = (split, ...names) => names.map((n) => ['game', n, split, `${n} gameplay no commentary`]);
const R = (cat, q) => [['real', cat, 'train', q, 0], ['real', cat, 'test', q, 1]];
const M = (kind, split, ...names) => names.map((n) => [kind, n, split, `${n} scene`]);
const rows = [
  ...G('train', 'Fortnite', 'Minecraft', 'Elden Ring', 'Call of Duty Warzone', 'League of Legends', 'Hollow Knight', 'Stardew Valley',
    'EA Sports FC 25', 'Zelda Breath of the Wild', 'Civilization VI', 'The Witcher 3', 'Rocket League'),
  ...G('test', 'Genshin Impact', 'Valorant', 'Hades', 'Terraria', 'God of War Ragnarok', 'Baldurs Gate 3', 'NBA 2K25',
    'Super Mario Odyssey', 'Age of Empires IV', 'Horizon Forbidden West', 'Among Us', 'Dota 2'),
  ...R('vlog', 'day in my life vlog'), ...R('cooking', 'easy dinner recipe cooking'), ...R('football', 'football match highlights'),
  ...R('basketball', 'basketball game highlights'), ...R('news', 'news report today'), ...R('interview', 'street interview asking strangers'),
  ...R('pets', 'funny cats and dogs'), ...R('walk', 'city walking tour 4k'), ...R('nature', 'nature drone footage 4k'),
  ...R('car', 'car review test drive'), ...R('concert', 'live concert fancam'), ...R('makeup', 'makeup tutorial'),
  ...R('podcast', 'podcast full episode video'), ...R('workout', 'gym workout routine'),
  ['real', 'dashcam', 'only', 'dashcam driving compilation', 0], ['real', 'f1-onboard', 'only', 'onboard lap race car', 0],
  ['real', 'bike-pov', 'only', 'gopro mountain bike pov', 0], ['real', 'airsoft-pov', 'only', 'airsoft gameplay gopro', 0],
  ['real', 'wedding', 'only', 'wedding film highlights', 0],
  ...M('anime', 'train', 'Demon Slayer', 'One Piece'), ...M('anime', 'test', 'Jujutsu Kaisen', 'Spirited Away'),
  ...M('animation', 'train', 'Toy Story', 'The Simpsons'), ...M('animation', 'test', 'Spider-Verse', 'Arcane'),
  ...M('live', 'train', 'Breaking Bad', 'The Office', 'Interstellar', 'Stranger Things'),
  ...M('live', 'test', 'Game of Thrones', 'The Dark Knight', 'Succession', 'The Last of Us HBO'),
];
const search = (q) => new Promise((res) => execFile('yt-dlp', [`ytsearch8:${q}`, '--flat-playlist', '--print', '%(id)s|%(duration)s|%(title)s'],
  { maxBuffer: 1 << 22 }, (_, out) => res((out ?? '').trim().split('\n').map((l) => l.split('|')).filter((x) => x.length >= 3))));
const out = [], used = new Set();
for (let i = 0; i < rows.length; i += 6) {
  await Promise.all(rows.slice(i, i + 6).map(async ([kind, cat, split, q, nth = 0]) => {
    const ok = (await search(q)).filter(([, d]) => +d >= 90 && +d <= 7200);
    const pick = ok.filter(([id]) => !used.has(id))[nth] ?? ok[0];
    if (!pick) return console.error('NO RESULT', cat, q);
    used.add(pick[0]);
    const d = +pick[1], start = d > 600 ? 120 : d > 240 ? 40 : 5;
    out.push([pick[0], cat, split, `${start}-${start + 150}`, pick.slice(2).join('|').slice(0, 70), kind]);
  }));
}
out.sort((a, b) => a[5].localeCompare(b[5]) || a[1].localeCompare(b[1]));
fs.writeFileSync('research/scripts/refframes/videos2.json', '[\n' + out.map((r) => '  ' + JSON.stringify(r)).join(',\n') + '\n]\n');
for (const r of out) console.log(r[5].padEnd(10), r[2].padEnd(6), r[1].padEnd(24), r[0], r[4]);
console.log(out.length, 'of', rows.length);
