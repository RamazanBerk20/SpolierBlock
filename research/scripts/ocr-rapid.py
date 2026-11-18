# PP-OCR (RapidOCR, ONNX Runtime CPU, default mobile det+rec models) on data/ocr. usage: python -I scripts/ocr-rapid.py
import json, os, time, sys, resource
from rapidocr import RapidOCR
R = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
eng = RapidOCR(params={'Global.log_level': 'error'} ) if True else None
truth = json.load(open(f'{R}/data/ocr/truth.json'))
out, ms = {}, []
for f in truth:
    t = time.time(); r = eng(f'{R}/data/ocr/{f}'); ms.append((time.time() - t) * 1000)
    out[f] = ' '.join(r.txts or [])
json.dump({'out': out, 'ms': ms}, open(f'{R}/results/ocr-rapid.json', 'w'))
print('peak RSS MB', resource.getrusage(resource.RUSAGE_SELF).ru_maxrss // 1024)
