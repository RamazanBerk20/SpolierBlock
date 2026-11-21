// The extension's input to the title-in-context model (src/shared/context-input.js, used by the engine) equals the
// Node runner's (tools/context-train/classify.mjs): same window, same segment B, same token ids and token types.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { env, AutoTokenizer } from '@huggingface/transformers';
import '../src/shared/context-input.js';
import * as win from '../tools/context-train/window.mjs';

const { windowText, workText, pairIds } = globalThis.SBContext;
const dir = new URL('../models/context', import.meta.url).pathname;
const has = fs.existsSync(`${dir}/model_int8.onnx`);

test('tools/context-train/window.mjs re-exports the shared module', () => {
  assert.equal(win.windowText, windowText);
  assert.equal(win.workText, workText);
  assert.equal(workText({ groups: [['Dune', 1, 0]], types: ['book', 'movie'] }, 0), 'Dune [movie, book]');
});

test('pair encoding equals tools/context-train/classify.mjs', { skip: !has && 'no models/context' }, async () => {
  const { contextClassifier } = await import('../tools/context-train/classify.mjs');
  const { meta, encode } = await contextClassifier(dir);
  env.allowRemoteModels = false;
  env.localModelPath = path.dirname(dir) + '/';
  const tok = await AutoTokenizer.from_pretrained('context');
  const [cls, sep] = tok.encode('');
  const enc = (t) => tok.encode(t, { add_special_tokens: false });
  const long = 'word '.repeat(60) + 'we finally watched Lost and the ending ' + 'more words here '.repeat(40);
  const s = long.indexOf('Lost');
  const As = [
    windowText('lost was peak tv', 0, 4), windowText(long, s, s + 4), 'a '.repeat(400) + '<Up>', '',
    '<Kaos> dizisini izledim, çok güzeldi', 'Ich habe <Dark> gesehen 🙂', '<進撃の巨人> 最終回', "<It>'s raining\n\tagain",
  ];
  const Bs = ['Lost [tv]', 'Dune [movie, book]', '', 'Attack on Titan [anime, manga]', 'x '.repeat(200)];
  let cut = 0;
  for (const a of As) for (const b of Bs) {
    const want = encode(a, b), got = pairIds(enc(a), enc(b), cls, sep, meta.maxLength);
    assert.deepEqual(got, want, JSON.stringify([a.slice(0, 40), b.slice(0, 20)]));
    assert.ok(got.ids.length <= meta.maxLength || enc(b).length + 3 > meta.maxLength);
    if (enc(a).length + enc(b).length + 3 > meta.maxLength) cut++;
  }
  assert.ok(cut > 3, 'some pairs must need A cut');
});
