# End-to-end fine-tune of all-MiniLM-L6-v2 (mean pooling + linear head, one logit) for "is this sentence a plot spoiler".
# Called by tools/train-spoiler.mjs, which assembles the items. usage: python -I finetune.py <items.jsonl> <outDir> [epochs=3]
# The threshold is chosen on validation (hand-written + held-out patterns, macro-F1), never on test/fixtures/spoiler-eval.jsonl.
# Writes <outDir>/model_int8.onnx (input_ids, attention_mask -> logit), the tokenizer files and meta.json {threshold}.
import sys, json, random, time, os
import numpy as np, torch
from transformers import AutoTokenizer, AutoModel
torch.set_num_threads(6); torch.manual_seed(0); random.seed(0)
BASE = 'sentence-transformers/all-MiniLM-L6-v2'
src, od = sys.argv[1], sys.argv[2]
epochs = int(sys.argv[3]) if len(sys.argv) > 3 else 3
items = [json.loads(l) for l in open(src)]
train = [x for x in items if x['split'] == 'train']
sel = [x for x in items if x['split'] == 'val' and x['src'] in ('hand', 'pattern')]
tok = AutoTokenizer.from_pretrained(BASE)
class M(torch.nn.Module):
    def __init__(s):
        super().__init__(); s.enc = AutoModel.from_pretrained(BASE); s.head = torch.nn.Linear(s.enc.config.hidden_size, 1)
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
print('val threshold', thr, 'train items', len(train), 'train s', round(time.time() - t0))
# export ONNX (input_ids, attention_mask -> logit), then int8 dynamic quantization; only the int8 file is kept
os.makedirs(od, exist_ok=True)
x = enc(['example sentence for export'])
torch.onnx.export(model, (x['input_ids'], x['attention_mask']), f'{od}/model.onnx', input_names=['input_ids', 'attention_mask'], output_names=['logit'],
                  dynamic_axes={'input_ids': {0: 'b', 1: 's'}, 'attention_mask': {0: 'b', 1: 's'}, 'logit': {0: 'b'}}, opset_version=17, dynamo=False)
from onnxruntime.quantization import quantize_dynamic, QuantType
quantize_dynamic(f'{od}/model.onnx', f'{od}/model_int8.onnx', weight_type=QuantType.QInt8)
os.remove(f'{od}/model.onnx')
tok.save_pretrained(od)
for f in ('special_tokens_map.json', 'vocab.txt'):
    if os.path.exists(f'{od}/{f}'): os.remove(f'{od}/{f}')
json.dump({'threshold': thr}, open(f'{od}/meta.json', 'w'))
print('int8 MB', round(os.path.getsize(f'{od}/model_int8.onnx') / 1e6, 1))
