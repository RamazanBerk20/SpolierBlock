# Quantisation variants of the SigLIP 2 vision tower, scored by agreement with the fp16 reference embeddings
# (median cosine, top-1 title agreement) on every 4th eval image. Writes <dir>/vision_<variant>.onnx.
# usage: python -I v2-quant.py <research dir> <fp32 vision.onnx> <variant...>
#   variants: dyn (dynamic int8, all MatMul), dynpc (per-channel), dyn-nofc2 / dyn-attn (keep MLP down / all MLP in fp32),
#             nbits8 / nbits4 (weight-only MatMulNBits, block 32), static (QDQ int8, per-channel, calibrated on side-0 images)
import json, os, sys, time
import numpy as np, onnx, onnxruntime as ort
from PIL import Image
from onnxruntime.quantization import quantize_dynamic, quantize_static, QuantType, QuantFormat, CalibrationDataReader, CalibrationMethod

R, FP32 = sys.argv[1], sys.argv[2]
D = os.path.dirname(FP32)
E = f'{R}/results/v2/emb/sig32'
imgs = json.load(open(f'{E}/img.json'))
ref = np.load(f'{E}/img.npy')[:, 0]
rows = np.load(f'{E}/rows-2000-base.npy')
sub = list(range(0, len(imgs), 4))
def px(f):
    im = Image.open(f).convert('RGB').resize((256, 256), Image.BICUBIC)
    return ((np.asarray(im, dtype=np.float32) / 255 - 0.5) / 0.5).transpose(2, 0, 1)[None].astype(np.float32)
mm = [n.name for n in onnx.load(FP32, load_external_data=False).graph.node if n.op_type == 'MatMul']
def score(path):
    so = ort.SessionOptions(); so.intra_op_num_threads = 6
    s = ort.InferenceSession(path, so, providers=['CPUExecutionProvider'])
    cos, agree, ts = [], 0, []
    for i in sub:
        x = px(imgs[i]['file']); t = time.time()
        e = s.run(['pooler_output'], {s.get_inputs()[0].name: x})[0][0]; ts.append(time.time() - t)
        e = e / np.linalg.norm(e)
        cos.append(float(e @ ref[i])); agree += int((rows @ e).argmax() == (rows @ ref[i]).argmax())
    return {'cos_median': round(float(np.median(cos)), 4), 'cos_p10': round(float(np.percentile(cos, 10)), 4), 'top1_agree': f'{agree}/{len(sub)}',
            'mb': round(os.path.getsize(path) / 1e6, 1), 'ms_py': round(1000 * float(np.median(ts)))}
class Calib(CalibrationDataReader):
    def __init__(self):
        import zlib
        side0 = [i for i, x in enumerate(imgs) if zlib.crc32((x['want'] or x['file'].split('/')[-1]).encode()) % 2 == 0]
        self.it = iter([{'pixel_values': px(imgs[i]['file'])} for i in side0[::6]])
    def get_next(self): return next(self.it, None)
for v in sys.argv[3:]:
    out = FP32 if v == 'fp32' else f'{D}/vision_{v}.onnx'
    if not os.path.exists(out):
        if v.startswith('dyn'):
            ex = [n for n in mm if (v == 'dyn-nofc2' and 'fc2' in n) or (v == 'dyn-attn' and ('fc1' in n or 'fc2' in n))]
            quantize_dynamic(FP32, out, weight_type=QuantType.QInt8, per_channel=(v == 'dynpc'), op_types_to_quantize=['MatMul'], nodes_to_exclude=ex)
        elif v.startswith('nbits'):
            from onnxruntime.quantization.matmul_nbits_quantizer import MatMulNBitsQuantizer
            q = MatMulNBitsQuantizer(onnx.load(FP32), bits=int(v[5:]), block_size=32, is_symmetric=True)
            q.process(); q.model.save_model_to_file(out, use_external_data_format=False)
        elif v == 'static':
            quantize_static(FP32, out, Calib(), quant_format=QuantFormat.QDQ, per_channel=True, op_types_to_quantize=['MatMul'],
                            activation_type=QuantType.QInt8, weight_type=QuantType.QInt8, calibrate_method=CalibrationMethod.Percentile,
                            extra_options={'ActivationSymmetric': True})
    r = {'variant': v, **score(out)}
    print(json.dumps(r), flush=True)
    with open(f'{R}/results/v2/quant.jsonl', 'a') as f: f.write(json.dumps(r) + '\n')
