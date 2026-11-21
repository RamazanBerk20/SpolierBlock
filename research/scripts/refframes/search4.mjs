// A wider set for head.mjs, every kind: one clip per search, as search2.mjs. Writes videos4.json in the same format
// ([id, cat, "train", "start-end", title, kind]; head.mjs folds by work for media and by video for real life).
// usage (repo root): node research/scripts/refframes/search4.mjs
import fs from 'node:fs';
import { execFile } from 'node:child_process';
const L = (kind, suffix, names) => names.map((n) => [kind, n, `${n} ${suffix}`]);
const rows = [
  ...L('game', 'gameplay no commentary', ['FIFA 23', 'Madden NFL 25', 'F1 24', 'Gran Turismo 7', 'Microsoft Flight Simulator', 'Euro Truck Simulator 2',
    'The Sims 4', 'Cities Skylines', 'Overwatch 2', 'Apex Legends', 'Counter-Strike 2', 'PUBG', 'Roblox', 'Animal Crossing New Horizons', 'Pokemon Scarlet',
    'Cuphead', 'Celeste', 'Undertale', 'Dark Souls 3', 'Sekiro', 'Resident Evil 4 Remake', 'The Last of Us Part II', 'Spider-Man 2', 'Hogwarts Legacy',
    'Starfield', 'Skyrim', 'Assassins Creed Shadows', 'Ghost of Tsushima', 'Persona 5 Royal', 'Final Fantasy XVI', 'Tekken 8', 'Street Fighter 6',
    'Hearthstone', 'Subnautica', 'Death Stranding', 'Tony Hawk Pro Skater']),
  ...L('anime', 'scene', ['Naruto Shippuden', 'Attack on Titan', 'Dragon Ball Z', 'My Hero Academia', 'Fullmetal Alchemist Brotherhood', 'Death Note', 'Chainsaw Man',
    'Spy x Family', 'Your Name anime', 'Princess Mononoke', 'Hunter x Hunter', 'Frieren', 'Bleach anime', 'Cowboy Bebop']),
  ...L('animation', 'scene', ['Frozen', 'Shrek', 'Family Guy', 'Rick and Morty', 'SpongeBob', 'Avatar The Last Airbender', 'Kung Fu Panda', 'Inside Out 2',
    'The Lion King 1994', 'Bluey', 'South Park', 'Coco Pixar', 'Zootopia', 'Adventure Time']),
  ...L('live', 'scene', ['Friends', 'Seinfeld', 'The Sopranos', 'Better Call Saul', 'Peaky Blinders', 'The Mandalorian', 'The Boys', 'Squid Game', 'House of the Dragon',
    'Severance', 'The Bear', 'Wednesday Netflix', 'Oppenheimer', 'Dune Part Two', 'The Godfather', 'Pulp Fiction', 'Inception', 'The Matrix', 'John Wick',
    'Avengers Endgame', 'Titanic', 'Parasite film', 'Joker 2019', 'Top Gun Maverick', 'Harry Potter', 'Lord of the Rings', 'Mad Max Fury Road',
    'The Shawshank Redemption', 'Barbie movie', 'La La Land']),
  ...Object.entries({ golf: 'golf tournament highlights', cricket: 'cricket match highlights', swimming: 'olympic swimming final', 'f1-race': 'formula 1 race highlights',
    'horse-racing': 'horse race full', courtroom: 'courtroom trial video', bodycam: 'police bodycam footage', parliament: 'parliament debate', reaction: 'reaction video facecam',
    repair: 'phone repair restoration', gardening: 'gardening tips vegetable garden', camping: 'solo camping in the rain', vanlife: 'van life tour', surf: 'surfing big waves',
    ski: 'skiing gopro pov', scuba: 'scuba diving coral reef', timelapse: 'city timelapse 4k', festival: 'music festival crowd', graduation: 'graduation ceremony', birthday: 'birthday party vlog',
    busker: 'street musician performance', yoga: 'yoga for beginners', barber: 'barber haircut transformation', detailing: 'car detailing wash', cleaning: 'clean with me house',
    thrift: 'thrift with me', irl: 'irl stream walking city', 'advert-2': 'best ads of the year', 'advert-3': 'super bowl commercials', 'wildlife-2': 'wildlife documentary lions' }).map(([c, q]) => ['real', c, q]),
];
const have = new Set(['videos.json', 'videos2.json', 'videos3.json'].flatMap((f) => JSON.parse(fs.readFileSync(`research/scripts/refframes/${f}`, 'utf8')).map((r) => r[0])));
const search = (q) => new Promise((res) => execFile('yt-dlp', [`ytsearch8:${q}`, '--flat-playlist', '--print', '%(id)s|%(duration)s|%(title)s'],
  { maxBuffer: 1 << 22, timeout: 90000 }, (_, out) => res((out ?? '').trim().split('\n').map((l) => l.split('|')).filter((x) => x.length >= 3))));
const out = [];
for (let i = 0; i < rows.length; i += 6) {
  const found = await Promise.all(rows.slice(i, i + 6).map(async (r) => [r, (await search(r[2])).filter(([, d]) => +d >= 100 && +d <= 110000)]));
  for (const [[kind, cat], ok] of found) {
    const pick = ok.find(([id]) => !have.has(id));
    if (!pick) { console.error('NO RESULT', cat); continue; }
    have.add(pick[0]);
    const d = +pick[1], start = d > 3600 ? 1800 : d > 600 ? 120 : d > 240 ? 40 : 5;
    out.push([pick[0], cat, 'train', `${start}-${start + 150}`, pick.slice(2).join('|').slice(0, 70), kind]);
  }
}
fs.writeFileSync('research/scripts/refframes/videos4.json', '[\n' + out.map((r) => '  ' + JSON.stringify(r)).join(',\n') + '\n]\n');
for (const r of out) console.log(r[5].padEnd(10), r[1].padEnd(30), r[0], r[4]);
console.log(out.length, 'of', rows.length);
