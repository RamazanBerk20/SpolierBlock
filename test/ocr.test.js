import { test } from 'node:test';
import assert from 'node:assert/strict';
import { recognize, OCR } from '../src/background/ocr.js';

// Fake onnxruntime: the detector marks two text blocks (one on the left, one on the right of the same row, and one
// below), the recogniser emits a CTC sequence ("hh-ii" -> "hi") chosen by the crop's width.
const Tensor = class { constructor(type, data, dims) { Object.assign(this, { type, data, dims }); } };
const ort = { Tensor };
const det = {
  inputNames: ['x'], outputNames: ['p'],
  async run({ x }) {
    const [, , H, W] = x.dims, p = new Float32Array(H * W);
    const box = (x0, y0, x1, y1) => { for (let y = y0; y < y1; y++) for (let xx = x0; xx < x1; xx++) p[y * W + xx] = 0.9; };
    box(10, 10, 60, 30); box(100, 12, 200, 28); box(10, 60, 90, 80);
    return { p: { data: p, dims: [1, 1, H, W] } };
  },
};
const chars = ['h', 'i', 'o', ' '];
const rec = {
  inputNames: ['x'], outputNames: ['y'],
  async run({ x }) {
    const seq = x.dims[3] > 200 ? [1, 1, 0, 2, 3] : [1, 0, 2]; // class index: 0 blank, k -> chars[k - 1]
    const C = chars.length + 1, y = new Float32Array(seq.length * C);
    seq.forEach((c, t) => { y[t * C + c] = 0.95; });
    return { y: { data: y, dims: [1, seq.length, C] } };
  },
};

test('boxes, reading order and CTC decoding', async () => {
  const img = { width: 384, height: 384, data: new Uint8ClampedArray(384 * 384 * 4).fill(255) };
  const { text, lines } = await recognize(ort, { det, rec, chars }, img, OCR);
  assert.equal(lines.length, 3);
  // first row: left box then right box; second row below
  assert.equal(text.split('\n').length, 2);
  assert.deepEqual(text.split('\n')[0].split(' ').length, 2);
  assert.match(text, /^hi\S* hi\S*\nhi/);
});

test('low-confidence text is dropped', async () => {
  const weak = { ...rec, async run(f) { const r = await rec.run(f); r.y.data = r.y.data.map((v) => v * 0.5); return r; } };
  const img = { width: 384, height: 384, data: new Uint8ClampedArray(384 * 384 * 4) };
  assert.equal((await recognize(ort, { det, rec: weak, chars }, img, OCR)).text, '');
});
