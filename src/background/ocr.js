// PP-OCR (PaddleOCR v5 mobile detector + English recogniser) on onnxruntime: text in images.
// Pure module: works on RGBA pixels and two ort sessions, so the extension and Node (research/scripts) run the same code.
// An Android port must reproduce the same steps and constants.

export const OCR = {
  detMax: 960, // longest detector input side (multiple of 32); smaller images are not upscaled beyond detMin
  detMin: 384, // shortest detector side: small thumbnails are upscaled (320x180 -> 672x384) so small captions are found
  binThresh: 0.3, // DB probability map -> text pixels
  boxThresh: 0.6, // mean probability inside a component to keep it as a text box
  unclip: 1.6, // DB unclip ratio: box grows by area * unclip / perimeter on each side
  minBox: 4, // px on the detector map
  recH: 48, // recogniser input height
  recMaxW: 960, // longest recogniser input width
  minConf: 0.6, // mean character probability of a box's text
};

// bilinear resize of RGBA (Uint8ClampedArray / Uint8Array) region (sx, sy, sw, sh) to dw x dh, written as normalised
// CHW float32 in BGR channel order (PaddleOCR feeds cv2 BGR images): channel k = (v / 255 - mean[k]) / std[k]
function toTensor(img, sx, sy, sw, sh, dw, dh, mean, std, outW = dw) {
  const { data, width, height } = img;
  const x = new Float32Array(3 * dh * outW), plane = dh * outW;
  const fx = sw / dw, fy = sh / dh;
  const pad = [(0 - mean[0]) / std[0], (0 - mean[1]) / std[1], (0 - mean[2]) / std[2]];
  if (outW > dw) for (let c = 0; c < 3; c++) for (let y = 0; y < dh; y++) x.fill(pad[c], c * plane + y * outW + dw, c * plane + (y + 1) * outW);
  for (let y = 0; y < dh; y++) {
    const yy = Math.min(Math.max(sy + (y + 0.5) * fy - 0.5, 0), height - 1), y0 = yy | 0, y1 = Math.min(y0 + 1, height - 1), wy = yy - y0;
    for (let xo = 0; xo < dw; xo++) {
      const xx = Math.min(Math.max(sx + (xo + 0.5) * fx - 0.5, 0), width - 1), x0 = xx | 0, x1 = Math.min(x0 + 1, width - 1), wx = xx - x0;
      const a = (y0 * width + x0) * 4, b = (y0 * width + x1) * 4, c0 = (y1 * width + x0) * 4, d = (y1 * width + x1) * 4;
      for (let c = 0; c < 3; c++) {
        const v = (data[a + c] * (1 - wx) + data[b + c] * wx) * (1 - wy) + (data[c0 + c] * (1 - wx) + data[d + c] * wx) * wy;
        const ch = 2 - c; // RGB -> BGR
        x[ch * plane + y * outW + xo] = (v / 255 - mean[ch]) / std[ch];
      }
    }
  }
  return x;
}

// PaddleOCR applies the ImageNet RGB statistics to BGR channels as they are; the models were trained that way
const DET_MEAN = [0.485, 0.456, 0.406], DET_STD = [0.229, 0.224, 0.225];
const REC_MEAN = [0.5, 0.5, 0.5], REC_STD = [0.5, 0.5, 0.5];

// Text boxes: connected components of the thresholded probability map, axis-aligned, grown by the DB unclip distance.
// shortcut: axis-aligned boxes, no rotated rectangles; slanted text (beyond ~10 degrees) reads worse. Upgrade to min-area
// rectangles + perspective crop if tilted captions matter.
function boxes(prob, W, H, o) {
  const lab = new Int32Array(W * H), stack = new Int32Array(W * H), out = [];
  let n = 0;
  for (let i = 0; i < W * H; i++) {
    if (lab[i] || prob[i] <= o.binThresh) continue;
    n++;
    let sp = 0, x0 = W, y0 = H, x1 = -1, y1 = -1, sum = 0, cnt = 0;
    stack[sp++] = i; lab[i] = n;
    while (sp) {
      const p = stack[--sp], px = p % W, py = (p - px) / W;
      sum += prob[p]; cnt++;
      if (px < x0) x0 = px; if (px > x1) x1 = px; if (py < y0) y0 = py; if (py > y1) y1 = py;
      if (px > 0 && !lab[p - 1] && prob[p - 1] > o.binThresh) { lab[p - 1] = n; stack[sp++] = p - 1; }
      if (px < W - 1 && !lab[p + 1] && prob[p + 1] > o.binThresh) { lab[p + 1] = n; stack[sp++] = p + 1; }
      if (py > 0 && !lab[p - W] && prob[p - W] > o.binThresh) { lab[p - W] = n; stack[sp++] = p - W; }
      if (py < H - 1 && !lab[p + W] && prob[p + W] > o.binThresh) { lab[p + W] = n; stack[sp++] = p + W; }
    }
    const w = x1 - x0 + 1, h = y1 - y0 + 1;
    if (Math.min(w, h) < o.minBox || sum / cnt < o.boxThresh) continue;
    const d = (w * h * o.unclip) / (2 * (w + h));
    out.push([Math.max(0, x0 - d), Math.max(0, y0 - d), Math.min(W, x1 + 1 + d), Math.min(H, y1 + 1 + d)]);
  }
  return out;
}

// img: { data: RGBA, width, height }; det/rec: ort.InferenceSession; chars: recogniser alphabet (index 0 = CTC blank)
// -> { text, lines: [{ text, conf, box }] }
export async function recognize(ort, { det, rec, chars }, img, o = OCR) {
  const { width: W0, height: H0 } = img;
  let s = Math.min(o.detMax / Math.max(W0, H0), Math.max(1, o.detMin / Math.min(W0, H0)));
  const dw = Math.max(32, Math.round((W0 * s) / 32) * 32), dh = Math.max(32, Math.round((H0 * s) / 32) * 32);
  const dout = await det.run({ [det.inputNames[0]]: new ort.Tensor('float32', toTensor(img, 0, 0, W0, H0, dw, dh, DET_MEAN, DET_STD), [1, 3, dh, dw]) });
  const prob = dout[det.outputNames[0]].data;
  const sx = W0 / dw, sy = H0 / dh;
  const found = [];
  for (const [x0, y0, x1, y1] of boxes(prob, dw, dh, o)) {
    const bx = x0 * sx, by = y0 * sy, bw = (x1 - x0) * sx, bh = (y1 - y0) * sy;
    const rw = Math.min(o.recMaxW, Math.max(o.recH, Math.round((o.recH * bw) / bh)));
    const outW = Math.ceil(rw / 8) * 8;
    const t = new ort.Tensor('float32', toTensor(img, bx, by, bw, bh, rw, o.recH, REC_MEAN, REC_STD, outW), [1, 3, o.recH, outW]);
    const r = (await rec.run({ [rec.inputNames[0]]: t }))[rec.outputNames[0]];
    const [, T, C] = r.dims, p = r.data;
    let text = '', conf = 0, k = 0, prev = 0;
    for (let ti = 0; ti < T; ti++) {
      let best = 0, bp = -1;
      for (let c = 0; c < C; c++) if (p[ti * C + c] > bp) { bp = p[ti * C + c]; best = c; }
      if (best && best !== prev) { text += chars[best - 1] ?? ''; conf += bp; k++; }
      prev = best;
    }
    text = text.trim();
    if (text && conf / k >= o.minConf) found.push({ text, conf: +(conf / k).toFixed(3), box: [bx, by, bw, bh].map(Math.round) });
  }
  // reading order: rows (vertical centre within half a box height) top to bottom, left to right inside a row
  found.sort((a, b) => a.box[1] + a.box[3] / 2 - (b.box[1] + b.box[3] / 2));
  const rows = [];
  for (const f of found) {
    const row = rows.find((r) => Math.abs(r.cy - (f.box[1] + f.box[3] / 2)) < Math.min(r.h, f.box[3]) / 2);
    if (row) row.items.push(f); else rows.push({ cy: f.box[1] + f.box[3] / 2, h: f.box[3], items: [f] });
  }
  const text = rows.map((r) => r.items.sort((a, b) => a.box[0] - b.box[0]).map((f) => f.text).join(' ')).join('\n');
  return { text, lines: found };
}
