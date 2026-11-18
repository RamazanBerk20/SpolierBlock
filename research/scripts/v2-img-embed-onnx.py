# Image embeddings from an ONNX vision tower (quantised variants), same images/views/order as v2-img-embed.py's img.json.
# usage: python -I v2-img-embed-onnx.py <research dir> <tag> <vision.onnx> <out name> [size=256] [mean=0.5,0.5,0.5] [std=0.5,0.5,0.5]
import json, os, sys, time
import numpy as np, onnxruntime as ort
from PIL import Image

R, tag, onnxf, name = sys.argv[1:5]
S = int(sys.argv[5]) if len(sys.argv) > 5 else 256
mean = np.array([float(x) for x in sys.argv[6].split(',')] if len(sys.argv) > 6 else [0.5] * 3)  # comma-separated per channel
std = np.array([float(x) for x in sys.argv[7].split(',')] if len(sys.argv) > 7 else [0.5] * 3)
D = f'{R}/results/v2/emb/{tag}'
imgs = json.load(open(f'{D}/img.json'))
so = ort.SessionOptions(); so.intra_op_num_threads = int(os.environ.get('THREADS', '6'))
s = ort.InferenceSession(onnxf, so, providers=['CPUExecutionProvider'])
outn = [o.name for o in s.get_outputs()]
pick = 'pooler_output' if 'pooler_output' in outn else ('image_embeds' if 'image_embeds' in outn else outn[-1])
def views(im):
    w, h = im.size
    sq = im.resize((S, S), Image.BICUBIC)
    m = min(w, h); cc = im.crop(((w - m) // 2, (h - m) // 2, (w - m) // 2 + m, (h - m) // 2 + m)).resize((S, S), Image.BICUBIC)
    M = max(w, h); pad = Image.new('RGB', (M, M)); pad.paste(im, ((M - w) // 2, (M - h) // 2)); pad = pad.resize((S, S), Image.BICUBIC)
    return [sq, cc, pad]
E, ts = [], []
for it in imgs:
    x = np.stack([((np.asarray(v, dtype=np.float32) / 255 - mean) / std).transpose(2, 0, 1) for v in views(Image.open(it['file']).convert('RGB'))]).astype(np.float32)
    t = time.time()
    e = np.concatenate([s.run([pick], {s.get_inputs()[0].name: x[i:i + 1]})[0] for i in range(3)])
    ts.append(time.time() - t)
    E.append(e / np.linalg.norm(e, axis=-1, keepdims=True))
np.save(f'{D}/img-{name}.npy', np.stack(E).astype(np.float32))
print(name, 'images', len(E), 'median ms per view', round(1000 * float(np.median(ts)) / 3))
