// Test vectors for the Java port of "Only block actual spoilers" (extensions/blocker/src/test/.../ClassifierTest.java).
// Expected values come from the extension's own code: token ids from transformers.js on models/spoiler/tokenizer.json,
// probabilities from tools/spoiler-classify.mjs (the Node mirror of engine.js classify()) on test/fixtures/spoiler-eval.jsonl.
// usage (from the repo root or android/): node android/tools/spoiler-vectors.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { env, AutoTokenizer } from '@huggingface/transformers';
import { spoilerClassifier } from '../../tools/spoiler-classify.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const out = path.join(repo, 'android/build/vectors');
fs.mkdirSync(out, { recursive: true });
env.allowRemoteModels = false;
env.localModelPath = path.join(repo, 'models') + '/';
const tok = await AutoTokenizer.from_pretrained('spoiler');

const rows = fs.readFileSync(path.join(repo, 'test/fixtures/spoiler-eval.jsonl'), 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));

// ---------- tokenizer: eval sentences, catalog names, and Unicode / truncation edge cases ----------
const strings = [
  'Pokémon Amélie naïve café résumé', 'ÀÉÎÕÜ ñ ç ø å æ œ ß', 'İstanbul ıi İI', 'ΣΑΣ ΟΔΥΣΣΕΥΣ σοφός', 'ﬁnale ﬂoor', 'ＡＢＣ　ｆｕｌｌｗｉｄｔｈ',
  '千と千尋の神隠し is great', '𠮷野家 and 𪚥', '진격의 거인 final season', 'Наруто умер?', 'الحلقة الأخيرة', 'हिन्दी फ़िल्म', 'ภาษาไทย',
  '🔥🔥 wow 😭😭', '👨‍👩‍👧 family', 'a\u0000b\u0007c\u001bd', 'zero​width‍join', 'nb sp narrow', '﻿bom start',
  'tab\tand\nnewline\r\nwin', '  spaced   out  ', '[CLS] hi [MASK] there [SEP]', '[cls] lower [Unk]', 'x[UNK]y', '[PAD][PAD]',
  'a'.repeat(100), 'b'.repeat(101), 'supercalifragilisticexpialidocious'.repeat(4), 'word '.repeat(80), 'Ω'.repeat(150),
  "don't won't can't it's", 'Snape...kills—Dumbledore!!! (spoiler)', '$100 #hashtag @handle_1 https://x.com/a?b=c',
  'S02E05 1080p 4K 3.14 1,000,000', '¿Qué? ¡Sí! «guillemets» „quotes“ ‘single’', '…ellipsis… and · middot', 'math ∑ ∞ ≠ ±',
  'combining é ä ñ', 'ﬀ ﬃ ǅ ǈ Ⅻ ①', '\ud83d alone', 'end\ud800', 'emoji🙂glued🙂words', '',
];
for (const r of rows) {
  strings.push(r.text);
  for (const s of r.text.split(/(?<=[.!?])\s+|\n+/)) strings.push(s);
}
const catalog = path.join(repo, 'data/catalog.json');
if (fs.existsSync(catalog)) {
  let seed = 0x5eed;
  const rnd = () => ((seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 2 ** 32);
  const works = JSON.parse(fs.readFileSync(catalog, 'utf8')).works;
  for (let i = 0; i < 300; i++) {
    const w = works[Math.floor(rnd() * works.length)];
    strings.push(`${w.title} ${(w.characters ?? [])[0] ?? ''} ending explained`.trim());
  }
}
const tokens = [...new Set(strings)].map((text) => ({ text, ids: Array.from(tok(text, { truncation: true, max_length: 64 }).input_ids.data, Number) }));
fs.writeFileSync(path.join(out, 'spoiler-tokens.json'), JSON.stringify(tokens));

// ---------- classifier: the 300-post eval set, scored exactly as the extension scores it ----------
const { threshold, prob } = await spoilerClassifier(path.join(repo, 'models/spoiler'));
const label = (r) => { const v = r.spoiler ?? r.label ?? r.is_spoiler; return v === true || v === 1 || v === 'spoiler' || v === '1'; };
const evals = [];
for (const r of rows) evals.push({ text: r.text, kind: r.kind, y: label(r), p: await prob(r.text) });
fs.writeFileSync(path.join(out, 'spoiler-eval.json'), JSON.stringify({ threshold, cases: evals }));
const by = {};
for (const e of evals) { const k = (by[e.kind] ??= [0, 0]); k[0] += e.p >= threshold; k[1]++; }
console.log(`spoiler vectors: ${tokens.length} tokenizer strings, ${evals.length} eval posts, flagged by kind ${JSON.stringify(by)} -> ${out}`);
