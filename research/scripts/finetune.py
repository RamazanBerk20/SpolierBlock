# End-to-end fine-tune of a small sentence encoder (mean pooling + linear head) for "is this sentence a plot spoiler".
# usage: python -I scripts/finetune.py <hf-model> <name> <sources: proj|proj+gr|gr> [epochs=3]
# Train/val: data/train-items.jsonl (same sources as tools/train-spoiler.mjs) and/or data/goodreads/sample.jsonl.
# Threshold chosen on validation (hand + held-out patterns, macro-F1), never on the 300-item eval.
# Writes results/ft/<name>.json (eval scores, threshold) and models/ft/<name>/model.onnx (+ int8).
import sys, json, random, time, os, re
import numpy as np, torch
from transformers import AutoTokenizer, AutoModel
torch.set_num_threads(6); torch.manual_seed(0); random.seed(0)
R = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
base, name, src = sys.argv[1], sys.argv[2], sys.argv[3]
epochs = int(sys.argv[4]) if len(sys.argv) > 4 else 3
items = []
if 'proj' in src: items += [json.loads(l) for l in open(f'{R}/data/train-items.jsonl')]
if 'gr' in src:
    gr = [json.loads(l) for l in open(f'{R}/data/goodreads/sample.jsonl')][:int(os.environ.get('GR_N', '30000'))]
    items += [dict(x, split='val' if i % 20 == 0 else 'train', src='goodreads') for i, x in enumerate(gr)]
train = [x for x in items if x['split'] == 'train']
sel = [x for x in items if x['split'] == 'val' and x['src'] in ('hand', 'pattern')] or [x for x in items if x['split'] == 'val']
ev = [json.loads(l) for l in open(f'{R}/results/snap/spoiler-eval.jsonl')]
tok = AutoTokenizer.from_pretrained(base)
class M(torch.nn.Module):
    def __init__(s):
        super().__init__(); s.enc = AutoModel.from_pretrained(base); s.head = torch.nn.Linear(s.enc.config.hidden_size, 1)
    def forward(s, input_ids, attention_mask):
        h = s.enc(input_ids=input_ids, attention_mask=attention_mask).last_hidden_state
        m = attention_mask.unsqueeze(-1).float(); e = (h * m).sum(1) / m.sum(1).clamp(min=1)
        return s.head(torch.nn.functional.normalize(e, dim=-1) * 10).squeeze(-1)
model = M()
pos = sum(x['y'] for x in train); wpos = len(train) / (2 * pos); wneg = len(train) / (2 * (len(train) - pos))
opt = torch.optim.AdamW([{'params': model.enc.parameters(), 'lr': 3e-5}, {'params': model.head.parameters(), 'lr': 1e-3}], weight_decay=0.01)
steps = epochs * (len(train) // 32 + 1); sched = torch.optim.lr_scheduler.OneCycleLR(opt, max_lr=[3e-5, 1e-3], total_steps=steps, pct_start=0.1)
def enc(texts): return tok(texts, padding=True, truncation=True, max_length=64, return_tensors='pt')
def score(texts, bs=64):
    model.eval(); out = []
    with torch.no_grad():
        for i in range(0, len(texts), bs):
            b = enc(texts[i:i + bs]); out += torch.sigmoid(model(b['input_ids'], b['attention_mask'])).tolist()
    return out
def sents(t): return [s.strip() for s in re.split(r'(?<=[.!?])\s+|\n+', t) if len(s.strip()) > 3][:16] or [t]
t0 = time.time()
for ep in range(epochs):
    model.train(); random.shuffle(train)
    for i in range(0, len(train), 32):
        b = train[i:i + 32]; x = enc([z['text'] for z in b]); y = torch.tensor([float(z['y']) for z in b])
        w = torch.where(y > 0, wpos, wneg)
        loss = torch.nn.functional.binary_cross_entropy_with_logits(model(x['input_ids'], x['attention_mask']), y, weight=w)
        opt.zero_grad(); loss.backward(); opt.step(); sched.step()
    print(f'epoch {ep} loss {loss.item():.3f} {time.time() - t0:.0f}s', flush=True)
def f1(ps, ys, t):
    tp = sum(p >= t and y for p, y in zip(ps, ys)); fp = sum(p >= t and not y for p, y in zip(ps, ys)); fn = sum(p < t and y for p, y in zip(ps, ys))
    return 2 * tp / max(1, 2 * tp + fp + fn)
groups = {}
for x in sel: groups.setdefault(x['src'], []).append(x)
sc = {k: score([x['text'] for x in v]) for k, v in groups.items()}
thr = max([t / 100 for t in range(10, 91, 5)], key=lambda t: np.mean([f1(sc[k], [x['y'] for x in groups[k]], t) for k in groups]))
evs = [max(score(sents(r['text']))) for r in ev]
os.makedirs(f'{R}/results/ft', exist_ok=True)
json.dump({'thr': thr, 'scores': evs, 'train_s': round(time.time() - t0), 'n_train': len(train)}, open(f'{R}/results/ft/{name}.json', 'w'))
print('val threshold', thr, 'train items', len(train), 'train s', round(time.time() - t0))
# export ONNX (input_ids, attention_mask -> logit) and int8 dynamic quantization
od = f'{R}/models/ft/{name}'; os.makedirs(od, exist_ok=True)
x = enc(['example sentence for export'])
torch.onnx.export(model, (x['input_ids'], x['attention_mask']), f'{od}/model.onnx', input_names=['input_ids', 'attention_mask'], output_names=['logit'],
                  dynamic_axes={'input_ids': {0: 'b', 1: 's'}, 'attention_mask': {0: 'b', 1: 's'}, 'logit': {0: 'b'}}, opset_version=17, dynamo=False)
from onnxruntime.quantization import quantize_dynamic, QuantType
quantize_dynamic(f'{od}/model.onnx', f'{od}/model_int8.onnx', weight_type=QuantType.QInt8)
tok.save_pretrained(od)
print('onnx MB', round(os.path.getsize(f'{od}/model.onnx') / 1e6, 1), 'int8 MB', round(os.path.getsize(f'{od}/model_int8.onnx') / 1e6, 1))
