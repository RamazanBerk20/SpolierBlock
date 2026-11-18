// Synthetic OCR set: meme / screenshot-style captions rendered onto the ordinary fixture photos. out: data/ocr/*.png + truth.json
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
const R = path.resolve(import.meta.dirname, '..');
const FX = R + '/../test/fixtures/images/';
const photos = fs.readdirSync(FX).filter((f) => f.startsWith('clean')).sort().slice(0, 24);
const CAPS = ['WHEN ARTHUR MORGAN WATCHES HIS LAST SUNRISE', 'Snape kills Dumbledore', 'me after the Red Wedding episode', 'NOBODY: / JOEL AT THE HOSPITAL:',
  'Darth Vader is Luke\'s father', 'POV: you just finished Breaking Bad', 'Ellie finds out the truth', 'THE ENDING OF ELDEN RING HITS DIFFERENT',
  'Tony Stark snaps his fingers', 'Bruce Willis was dead all along', 'Eren started the Rumbling', 'Wednesday Addams solves the case',
  'Kratos and Atreus reach Jotunheim', 'Ned Stark loses his head', 'Gus Fring final scene', 'Rosebud was the sled',
  'Micah was the rat all along', 'Hank finds the book in the bathroom', 'Thanos wins in Infinity War', 'Dumbledore dies on the tower',
  'The cake is a lie', 'Jack does not survive the Titanic', 'Soylent Green is people', 'Mufasa falls into the stampede'];
const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/'/g, '&#39;');
const truth = {};
for (let i = 0; i < photos.length; i++) {
  const img = sharp(FX + photos[i]).resize(640, 480, { fit: 'cover' });
  const style = i % 3; // 0 meme (white Impact-like with black stroke, top), 1 black text on white bar (tweet screenshot), 2 small white subtitle
  const t = CAPS[i], fs0 = (base) => Math.min(base, Math.floor(600 / (t.length * (t === t.toUpperCase() ? 0.8 : 0.62)))), fit = () => '';
  const svg = style === 0
    ? `<svg width="640" height="480"><text x="320" y="60" font-family="DejaVu Sans" font-weight="bold" font-size="${fs0(34)}"${fit(34)} text-anchor="middle" fill="white" stroke="black" stroke-width="2">${esc(t)}</text></svg>`
    : style === 1
      ? `<svg width="640" height="480"><rect x="0" y="0" width="640" height="70" fill="white"/><text x="16" y="45" text-anchor="start" font-family="DejaVu Sans" font-size="${fs0(26)}"${fit(26)} fill="#111">${esc(t)}</text></svg>`
      : `<svg width="640" height="480"><text x="320" y="450" font-family="DejaVu Sans" font-size="${fs0(22)}"${fit(22)} text-anchor="middle" fill="#ffff66" stroke="black" stroke-width="1">${esc(t)}</text></svg>`;
  const name = `ocr_${i}.png`;
  await img.composite([{ input: Buffer.from(svg), top: 0, left: 0 }]).png().toFile(R + '/data/ocr/' + name);
  truth[name] = { text: t, style: ['meme', 'tweet', 'subtitle'][style] };
}
fs.writeFileSync(R + '/data/ocr/truth.json', JSON.stringify(truth, null, 1));
console.log(Object.keys(truth).length);
