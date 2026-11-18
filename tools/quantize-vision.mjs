// Weight-only int8 quantisation of an fp32 ONNX model's MatMul weights, at build time and without Python: every float
// [K, N] MatMul weight becomes int8 + one fp32 scale per output column (symmetric), restored by a DequantizeLinear
// node in front of the MatMul. Activations stay fp32: SigLIP 2's activation outliers break int8 activations (dynamic
// or static int8 scores cos ~0.7 against fp32; weight-only int8 0.9998, research/scripts/v2-quant.py).
// Only the fields it touches are decoded; everything else in the protobuf is copied byte for byte.
// usage: import { weightOnlyInt8 } from './quantize-vision.mjs'; weightOnlyInt8(fp32Bytes) -> Uint8Array

// ---- minimal protobuf ----
function varint(b, p) {
  let v = 0, m = 1, x;
  do { x = b[p++]; v += (x & 0x7f) * m; m *= 128; } while (x & 0x80);
  return [v, p];
}
// -> [{ no, wt, start (of the field, tag included), vs, ve (value bytes for LEN fields / varint value) }]
function fields(b, s = 0, e = b.length) {
  const out = [];
  for (let p = s; p < e;) {
    const start = p;
    let tag; [tag, p] = varint(b, p);
    const no = Math.floor(tag / 8), wt = tag & 7;
    let vs = p, ve, val;
    if (wt === 0) { [val, p] = varint(b, p); ve = p; } else if (wt === 1) { p += 8; ve = p; } else if (wt === 5) { p += 4; ve = p; } else if (wt === 2) {
      let len; [len, p] = varint(b, p); vs = p; p += len; ve = p;
    } else throw new Error(`protobuf wire type ${wt}`);
    out.push({ no, wt, start, end: p, vs, ve, val });
  }
  return out;
}
const enc = new TextEncoder(), dec = new TextDecoder();
const vbytes = (v) => { const o = []; do { let x = v % 128; v = Math.floor(v / 128); if (v) x |= 0x80; o.push(x); } while (v); return o; };
const cat = (parts) => { const n = parts.reduce((a, p) => a + p.length, 0), o = new Uint8Array(n); let k = 0; for (const p of parts) { o.set(p, k); k += p.length; } return o; };
const len = (no, bytes) => cat([Uint8Array.from(vbytes(no * 8 + 2)), Uint8Array.from(vbytes(bytes.length)), bytes]);
const int = (no, v) => Uint8Array.from([...vbytes(no * 8), ...vbytes(v)]);
const str = (no, s) => len(no, enc.encode(s));

// TensorProto: dims 1, data_type 2 (FLOAT 1, INT8 3), name 8, raw_data 9
const tensor = (name, dims, type, raw) => cat([...dims.map((d) => int(1, d)), int(2, type), str(8, name), len(9, raw)]);
// NodeProto: input 1, output 2, name 3, op_type 4, attribute 5 (AttributeProto: name 1, i 3, type 20 = INT 2)
const node = (inputs, output, name, op, attrs) => cat([...inputs.map((i) => str(1, i)), str(2, output), str(3, name), str(4, op),
  ...Object.entries(attrs).map(([k, v]) => len(5, cat([str(1, k), int(3, v), int(20, 2)])))]);

export function weightOnlyInt8(model) {
  const top = fields(model), g = top.find((f) => f.no === 7);
  const gf = fields(model, g.vs, g.ve);
  const sub = (f) => fields(model, f.vs, f.ve);
  const text = (fs, no) => fs.filter((x) => x.no === no).map((x) => dec.decode(model.subarray(x.vs, x.ve)));
  // weights = second input of MatMul nodes
  const weights = new Set();
  for (const f of gf.filter((x) => x.no === 1)) {
    const n = sub(f);
    if (text(n, 4)[0] === 'MatMul') weights.add(text(n, 1)[1]);
  }
  const newNodes = [], parts = [];
  for (const f of gf) {
    if (f.no !== 5) continue;
    const t = sub(f), name = text(t, 8)[0];
    const dims = t.filter((x) => x.no === 1).map((x) => x.val), type = t.find((x) => x.no === 2)?.val, raw = t.find((x) => x.no === 9);
    if (!weights.has(name) || dims.length !== 2 || type !== 1 || !raw) continue;
    const [K, N] = dims, w = new Float32Array(model.slice(raw.vs, raw.ve).buffer);
    const scale = new Float32Array(N), q = new Int8Array(K * N);
    for (let i = 0; i < K * N; i++) scale[i % N] = Math.max(scale[i % N], Math.abs(w[i]));
    for (let j = 0; j < N; j++) scale[j] = scale[j] / 127 || 1;
    for (let i = 0; i < K * N; i++) q[i] = Math.round(w[i] / scale[i % N]);
    f.replace = cat([len(5, tensor(`${name}_q`, dims, 3, new Uint8Array(q.buffer))), len(5, tensor(`${name}_scale`, [N], 1, new Uint8Array(scale.buffer)))]);
    newNodes.push(len(1, node([`${name}_q`, `${name}_scale`], name, `${name}_dq`, 'DequantizeLinear', { axis: 1 })));
  }
  // nodes are topologically sorted: the DequantizeLinear nodes (inputs are initializers) go first
  parts.push(...newNodes);
  for (const f of gf) parts.push(f.replace ?? model.subarray(f.start, f.end));
  const graph = len(7, cat(parts));
  return cat(top.map((f) => (f === g ? graph : model.subarray(f.start, f.end))));
}
