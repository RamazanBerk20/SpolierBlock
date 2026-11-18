// Image -> model input, in plain JS so every browser (and Node, tools/calibrate-clip.mjs) computes the same numbers:
// canvas scaling filters differ between Chrome and Firefox and moved image scores by up to 0.01 (tools/bench-stats-diff.mjs).

// separable triangle-filter weights for n -> m samples (PIL's antialiased BILINEAR, which SigLIP's processor uses)
function taps(n, m) {
  const scale = n / m, fs = Math.max(scale, 1), out = [];
  for (let x = 0; x < m; x++) {
    const c = (x + 0.5) * scale, lo = Math.max(0, Math.floor(c - fs)), hi = Math.min(n, Math.ceil(c + fs));
    const w = [];
    let sum = 0;
    for (let i = lo; i < hi; i++) { const v = Math.max(0, 1 - Math.abs((i + 0.5 - c) / fs)); w.push(v); sum += v; }
    out.push({ lo, w: w.map((v) => v / sum) });
  }
  return out;
}

// img: { data: RGBA, width, height } at decoded size -> float32 CHW [3, S, S] written at out[o...]: the whole image
// squashed to S x S, each channel (v / 255 - mean[c]) / std[c]
export function squashCHW({ data, width: W, height: H }, S, mean, std, out = new Float32Array(3 * S * S), o = 0) {
  const tx = taps(W, S), ty = taps(H, S), row = new Float32Array(H * S * 3), P = S * S;
  for (let y = 0; y < H; y++) for (let x = 0; x < S; x++) {
    const { lo, w } = tx[x];
    let r = 0, g = 0, b = 0;
    for (let k = 0; k < w.length; k++) { const p = (y * W + lo + k) * 4; r += data[p] * w[k]; g += data[p + 1] * w[k]; b += data[p + 2] * w[k]; }
    const q = (y * S + x) * 3;
    row[q] = r; row[q + 1] = g; row[q + 2] = b;
  }
  for (let y = 0; y < S; y++) {
    const { lo, w } = ty[y];
    for (let x = 0; x < S; x++) {
      const v = [0, 0, 0];
      for (let k = 0; k < w.length; k++) { const q = ((lo + k) * S + x) * 3; v[0] += row[q] * w[k]; v[1] += row[q + 1] * w[k]; v[2] += row[q + 2] * w[k]; }
      // PIL rounds to 8-bit after resizing
      for (let c = 0; c < 3; c++) out[o + c * P + y * S + x] = (Math.min(255, Math.max(0, Math.round(v[c]))) / 255 - mean[c]) / std[c];
    }
  }
  return out;
}
