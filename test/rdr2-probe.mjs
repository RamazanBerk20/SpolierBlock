// Probe (not a unit test): how RDR2 "Arthur dies" posts fare in both modes. Run: node test/rdr2-probe.mjs
import fs from 'node:fs';
import '../src/content/matcher.js';
import { spoilerClassifier } from '../tools/spoiler-classify.mjs';
const d = new URL('../dist/firefox/data/', import.meta.url);
const meta = JSON.parse(fs.readFileSync(new URL('index.json', d))), b = fs.readFileSync(new URL('index.bin', d));
const m = new globalThis.SBMatcher.Matcher(b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength), meta);
const { threshold, prob: classify } = await spoilerClassifier(new URL('../dist/firefox/models/spoiler', import.meta.url).pathname);
const posts = [
  // [expected in spoiler mode, text]
  ['S', 'Arthur Morgan dies at the end of Red Dead Redemption 2 and I was not ready.'],
  ['S', 'RDR2 ending: Arthur dies of tuberculosis on the mountain.'],
  ['S', 'Micah kills Arthur Morgan if you go back for the money.'],
  ['S', 'Arthur Morgan watching that last sunrise on the mountain... I have never cried this hard at a game.'],
  ['S', "Just finished RDR2. That final ride back to camp with the song playing, knowing Arthur isn't coming back. Rockstar broke me."],
  ['S', 'RDR2 really makes you fall in love with Arthur Morgan for 60 hours just to take him away from you.'],
  ['S', 'The moment the doctor in Saint Denis tells Arthur Morgan the diagnosis, the whole game changes.'],
  ['S', "Playing the Red Dead Redemption 2 epilogue as John just isn't the same. I keep visiting his grave."],
  ['S', "Arthur Morgan's cough in chapter 5 hits different on a second playthrough of RDR2."],
  ['S', 'Rest in peace Arthur Morgan, you were a good man.'],
  ['S', 'RDR2 spoilers: the protagonist does not make it to the credits.'],
  ['N', 'Red Dead Redemption 2 is 60% off on Steam this weekend.'],
  ['N', 'Arthur Morgan is the best written protagonist in gaming, change my mind.'],
  ['N', 'Started RDR2 last night, the snow in the opening looks incredible.'],
  ['N', 'Is Red Dead Redemption 2 worth playing in 2026?'],
  ['N', "My horse in RDR2 keeps running into trees lol"],
  ['N', 'Roger Clark deserved every award for voicing Arthur Morgan.'],
  // no title / no full name: nothing ties these to a work
  ['-', "I wasn't ready for that last ride. Boah."],
  ['-', 'Arthur deserved better. That sunrise scene destroyed me.'],
  ['-', 'He just wanted to be a good man in the end. Blessed are those who hunger and thirst for righteousness.'],
];
let ok = 0, n = 0;
for (const [exp, t] of posts) {
  const works = m.evaluate(t, () => false).map((g) => meta.groups[g][0]);
  const p = await classify(t);
  const any = works.length ? 'BLOCK' : 'show ';
  const sp = works.length && p >= threshold ? 'BLOCK' : 'show ';
  if (exp !== '-') { n++; if ((exp === 'S') === (sp === 'BLOCK')) ok++; }
  console.log(`${exp} any:${any} spoiler:${sp} p=${p.toFixed(2)} [${works.join(',')}] ${t.slice(0, 95)}`);
}
console.log(`spoiler-mode agreement on titled posts: ${ok}/${n} (threshold ${threshold})`);
