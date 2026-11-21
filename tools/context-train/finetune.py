# Sentence-pair fine-tune of all-MiniLM-L6-v2 for "does the name in segment A mean the work in segment B" (mean pooling
# + linear head, one logit, as tools/spoiler-train/finetune.py). Called by tools/train-context.mjs, which builds the pairs.
# usage: python -I finetune.py <items.jsonl> <outDir> <window> <maxLen> [epochs=3]
# Writes <outDir>/model_int8.onnx (input_ids, attention_mask, token_type_ids -> logit), the tokenizer files and meta.json
# (threshold null: tools/train-context.mjs then chooses it on the held-out names with the shipped runtime).
import sys, json, random, time, os
import numpy as np, torch
from transformers import AutoTokenizer, AutoModel
torch.set_num_threads(6); torch.manual_seed(0); random.seed(0)
BASE = 'sentence-transformers/all-MiniLM-L6-v2'
src, od, window, max_len = sys.argv[1], sys.argv[2], int(sys.argv[3]), int(sys.argv[4])
epochs = int(sys.argv[5]) if len(sys.argv) > 5 else int(os.environ.get('SB_EPOCHS', 3))
items = [json.loads(l) for l in open(src)]
train = [x for x in items if x['split'] == 'train']
tok = AutoTokenizer.from_pretrained(BASE)
class M(torch.nn.Module):
    def __init__(s):
        super().__init__(); s.enc = AutoModel.from_pretrained(BASE); s.head = torch.nn.Linear(s.enc.config.hidden_size, 1)
    def forward(s, input_ids, attention_mask, token_type_ids):
        h = s.enc(input_ids=input_ids, attention_mask=attention_mask, token_type_ids=token_type_ids).last_hidden_state
        m = attention_mask.unsqueeze(-1).float(); e = (h * m).sum(1) / m.sum(1).clamp(min=1)
        return s.head(torch.nn.functional.normalize(e, dim=-1) * 10).squeeze(-1)
model = M()
def enc(b): return tok([z['a'] for z in b], [z['b'] for z in b], padding=True, truncation='only_first', max_length=max_len, return_tensors='pt')
pos = sum(x['y'] for x in train); wpos = len(train) / (2 * pos); wneg = len(train) / (2 * (len(train) - pos))
BS = 32
opt = torch.optim.AdamW([{'params': model.enc.parameters(), 'lr': 3e-5}, {'params': model.head.parameters(), 'lr': 1e-3}], weight_decay=0.01)
steps = epochs * (len(train) // BS + 1); sched = torch.optim.lr_scheduler.OneCycleLR(opt, max_lr=[3e-5, 1e-3], total_steps=steps, pct_start=0.1)
print(f'train {len(train)} (positives {pos}), epochs {epochs}', flush=True)
t0 = time.time()
for ep in range(epochs):
    model.train(); random.shuffle(train)
    # batches of similar length (less padding): sort chunks of 50 batches by length, then shuffle the batches
    batches = []
    for c in range(0, len(train), BS * 50):
        chunk = sorted(train[c:c + BS * 50], key=lambda z: len(z['a']) + len(z['b']))
        batches += [chunk[i:i + BS] for i in range(0, len(chunk), BS)]
    random.shuffle(batches)
    tot = 0
    for k, b in enumerate(batches):
        x = enc(b); y = torch.tensor([float(z['y']) for z in b]); w = torch.where(y > 0, wpos, wneg)
        loss = torch.nn.functional.binary_cross_entropy_with_logits(model(x['input_ids'], x['attention_mask'], x['token_type_ids']), y, weight=w)
        opt.zero_grad(); loss.backward(); opt.step(); sched.step(); tot += loss.item()
        if k % 500 == 0: print(f'  epoch {ep} batch {k}/{len(batches)} loss {tot / (k + 1):.4f} {time.time() - t0:.0f}s', flush=True)
    print(f'epoch {ep} mean loss {tot / len(batches):.4f} {time.time() - t0:.0f}s', flush=True)
# export ONNX, then int8 dynamic quantization; only the int8 file is kept
os.makedirs(od, exist_ok=True)
model.eval()
x = enc([{'a': 'example post about Lost', 'b': 'Lost [tv]'}])
torch.onnx.export(model, (x['input_ids'], x['attention_mask'], x['token_type_ids']), f'{od}/model.onnx',
                  input_names=['input_ids', 'attention_mask', 'token_type_ids'], output_names=['logit'],
                  dynamic_axes={k: {0: 'b', 1: 's'} for k in ('input_ids', 'attention_mask', 'token_type_ids')} | {'logit': {0: 'b'}},
                  opset_version=17, dynamo=False)
from onnxruntime.quantization import quantize_dynamic, QuantType
quantize_dynamic(f'{od}/model.onnx', f'{od}/model_int8.onnx', weight_type=QuantType.QInt8)
os.remove(f'{od}/model.onnx')
tok.save_pretrained(od)
for f in ('special_tokens_map.json', 'vocab.txt'):
    if os.path.exists(f'{od}/{f}'): os.remove(f'{od}/{f}')
json.dump({'threshold': None, 'window': window, 'maxLength': max_len, 'truncation': 'only_first',
           'input': 'A = post window with the name marked as <name>, B = "<group label> [<types>]" (tools/context-train/window.mjs)'}, open(f'{od}/meta.json', 'w'))
print('int8 MB', round(os.path.getsize(f'{od}/model_int8.onnx') / 1e6, 1), 'total s', round(time.time() - t0))
