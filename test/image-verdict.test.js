import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { scores, verdict } from '../src/background/image-verdict.js';

test('data/footage-head.json has the shape the build and the engine read', () => {
  const h = JSON.parse(fs.readFileSync(new URL('../data/footage-head.json', import.meta.url), 'utf8'));
  assert.equal(h.dim, 768); // the SigLIP 2 vision tower's pooler_output
  assert.equal(h.w.length, h.dim);
  assert.ok(h.w.every(Number.isFinite));
  assert.ok(Number.isFinite(h.b) && Number.isFinite(h.cut));
});

// synthetic 4-dim embeddings: no title row clears minScore, so only the generic branch can fire
const base = {
  dim: 4, n: 2, rowGroup: [0, 1], rowFamily: [0, 1], minScore: 0.9, margin: 0.077, titleGap: 0.015, mediaGate: 0.05,
  neg: [[1, 0, 0, 0]], media: [[0, 1, 0, 0]],
};
const mat = new Int8Array([0, 0, 127, 0, 0, 0, 0, 127]);
const foot = { w: [0, 0, 0, 10], b: -1, cut: 2 }; // score = 10 * e[3] - 1
const run = (meta, v) => { const s = scores(meta, mat, new Float32Array(v)); return { s, hits: verdict(meta, s, 'k') }; };

test('generic verdict: media gate alone without foot (unchanged)', () => {
  assert.deepEqual(run(base, [1, 2, 0, 0]).hits.map(([g]) => g), [-1]); // media beats neg
  const { s, hits } = run(base, [1, 0, 0, 1]);
  assert.equal(s.foot, null);
  assert.deepEqual(hits, []);
});

test('generic verdict: media gate OR footage head at its cut-off', () => {
  const meta = { ...base, foot };
  // |v| = 2 -> e[3] = 0.3 -> score 2.0 (at the cut), media below the gate
  const v = [Math.sqrt(4 - 0.36), 0, 0, 0.6];
  const at = run(meta, v);
  assert.ok(Math.abs(at.s.foot - 2) < 1e-6 && at.s.media < meta.mediaGate);
  assert.deepEqual(run({ ...meta, foot: { ...foot, cut: at.s.foot } }, v).hits.map(([g]) => g), [-1]);
  assert.deepEqual(run({ ...meta, foot: { ...foot, cut: at.s.foot + 1e-9 } }, v).hits, []);
  assert.deepEqual(run(meta, [1, 2, 0, 0]).hits.map(([g]) => g), [-1]); // media gate still works with foot present
  assert.deepEqual(run(meta, [1, 0, 0, 0.05]).hits, []); // neither
});

test('a title outranks the generic verdict', () => {
  const meta = { ...base, minScore: 0.5, foot };
  assert.deepEqual(run(meta, [0, 0, 0.1, 1]).hits.map(([g]) => g), [1]);
});
