# Embeddings for the title verdict from ONNX towers (the files the extension ships or could ship): eval images in three
# views (squash to the square input, centre crop, letterbox pad) and title-row text embeddings with the
# tools/clip-prompts.mjs templates. Output: results/v2/emb/<tag>/{img.json, img.npy, rows-<N>.npy/json, neg.npy, media.npy}
# usage: python -I v2-img-embed.py <research dir> <tag> <clip|siglip> <model dir> <vision.onnx|-> <text.onnx|-> [rows=2000|all]
import json, os, sys, time
import numpy as np, onnxruntime as ort
from PIL import Image
from tokenizers import Tokenizer

R, tag, kind, MD, VF, TF = sys.argv[1:7]
NROWS = sys.argv[7] if len(sys.argv) > 7 else '2000'
V2 = R + '/results/v2'
OUT = f'{V2}/emb/{tag}'
os.makedirs(OUT, exist_ok=True)
sig = kind == 'siglip'
S = int(os.environ.get('SIZE', 256 if sig else 224))
mean, std = (np.array([0.5] * 3), np.array([0.5] * 3)) if sig else (np.array([0.48145466, 0.4578275, 0.40821073]), np.array([0.26862954, 0.26130258, 0.27577711]))
so = ort.SessionOptions(); so.intra_op_num_threads = int(os.environ.get('THREADS', '6'))
def norm(x): return x / np.linalg.norm(x, axis=-1, keepdims=True)

imgs = json.load(open(R + '/results/images.json'))
o2 = V2 + '/data/ordinary2'
imgs += [{'file': f'{o2}/{f}', 'want': None, 'src': 'ordinary2'} for f in sorted(os.listdir(o2)) if f.endswith('.jpg')]
def views(im):
    w, h = im.size
    sq = im.resize((S, S), Image.BICUBIC)
    m = min(w, h); cc = im.crop(((w - m) // 2, (h - m) // 2, (w - m) // 2 + m, (h - m) // 2 + m)).resize((S, S), Image.BICUBIC)
    M = max(w, h); pad = Image.new('RGB', (M, M)); pad.paste(im, ((M - w) // 2, (M - h) // 2)); pad = pad.resize((S, S), Image.BICUBIC)
    return [sq, cc, pad]
if VF != '-':
    name = os.environ.get('NAME', 'img')
    s = ort.InferenceSession(VF, so, providers=['CPUExecutionProvider'])
    outn = [o.name for o in s.get_outputs()]
    pick = 'pooler_output' if 'pooler_output' in outn else 'image_embeds'
    E, files, ts = [], [], []
    for it in imgs:
        try: im = Image.open(it['file']).convert('RGB')
        except Exception: continue
        x = np.stack([((np.asarray(v, dtype=np.float32) / 255 - mean) / std).transpose(2, 0, 1) for v in views(im)]).astype(np.float32)
        t = time.time()
        e = np.concatenate([s.run([pick], {s.get_inputs()[0].name: x[i:i + 1]})[0] for i in range(3)])
        ts.append((time.time() - t) / 3)
        E.append(norm(e.astype(np.float32))); files.append(it)
    np.save(f'{OUT}/{name}.npy', np.stack(E))
    json.dump(files, open(f'{OUT}/img.json', 'w'))
    print(tag, name, 'images', len(files), 'median ms per view (onnxruntime python)', round(1000 * float(np.median(ts))), flush=True)

if TF != '-':
    tok = Tokenizer.from_file(MD + '/tokenizer.json')
    if sig: tok.enable_padding(length=64, pad_id=tok.token_to_id('<pad>') or 0); tok.enable_truncation(64)
    else: tok.enable_padding(pad_id=49407); tok.enable_truncation(77)
    ts_ = ort.InferenceSession(TF, so, providers=['CPUExecutionProvider'])
    tin = [i.name for i in ts_.get_inputs()]
    tout = 'pooler_output' if sig else 'text_embeds'
    rows = json.load(open(R + '/results/rows.json'))['rows']
    wants = {x['want'] for x in imgs if x['want']}
    use = [i for i, r in enumerate(rows) if NROWS == 'all' or i < int(NROWS) or r['title'] in wants]
    T = {
      'movie': ['a still from the movie {t}', 'the poster of the movie {t}', '{t}'],
      'tv': ['a scene from the TV show {t}', 'the poster of the TV series {t}', '{t}'],
      'game': ['a screenshot of the video game {t}', 'the cover art of the video game {t}', '{t}'],
      'book': ['the cover of the book {t}', 'an illustration from {t}', '{t}'],
      'anime': ['a scene from the anime {t}', 'the poster of the anime {t}', '{t}'],
      'manga': ['a page from the manga {t}', 'the cover of the manga {t}', '{t}'],
      'comic': ['a panel from the comic {t}', 'the cover of the comic {t}', '{t}'],
    }
    def prompts(r):
        return [s.replace('{t}', r['title']) for s in T.get(r['type'], T['movie'])] + [f"{c} from {r['title']}" for c in (r.get('characters') or [])[:2]]
    NEG = ['a photo', 'a photo of a person', 'a portrait photo of a woman', 'a portrait photo of a man', 'a selfie', 'a group of people',
      'a photo of a dog', 'a photo of a cat', 'a photo of an animal', 'a photo of food', 'a photo of a meal on a plate',
      'a landscape photo', 'a photo of mountains', 'a photo of the sea', 'a photo of a city street', 'a photo of a building',
      'a photo of a car', 'a photo of a bicycle', 'a photo of a room', 'a photo of an office', 'a laptop on a desk',
      'a screenshot of a website', 'a text document', 'a chart', 'a logo', 'a meme', 'a photo of a crowd at a concert',
      'a sports match', 'a photo of a castle', 'a photo of a park', 'a product photo', 'a drawing', 'a map']
    MEDIA = ['a movie poster', 'a still frame from a movie', 'a black and white still from an old film', 'a scene from a TV series',
      'a screenshot of a video game', 'video game graphics', 'a pixel art video game screen', 'a 3D rendered animated film scene',
      'a cartoon', 'anime artwork', 'a manga page', 'a comic book panel', 'a book cover', 'a video game cover art',
      'a cosplayer dressed as a fictional character', 'a costumed character from a film', 'a film set', 'a theme park attraction based on a film',
      'a title card of a film', 'a movie trailer screenshot']
    def embt(texts):
        out = []
        for i in range(0, len(texts), 64):
            enc = tok.encode_batch([x.lower() for x in texts[i:i + 64]] if sig else texts[i:i + 64])
            ids = np.array([e.ids for e in enc], dtype=np.int64)
            feed = {'input_ids': ids}
            if 'attention_mask' in tin: feed['attention_mask'] = np.array([e.attention_mask for e in enc], dtype=np.int64)
            out.append(norm(ts_.run([tout], feed)[0].astype(np.float32)))
        return np.concatenate(out)
    t0 = time.time()
    P = [prompts(rows[i]) for i in use]
    F = embt([p for ps in P for p in ps])
    k, rowE = 0, []
    for ps in P: rowE.append(norm(F[k:k + len(ps)].sum(0))); k += len(ps)
    np.save(f'{OUT}/rows-{NROWS}-base.npy', np.stack(rowE)); json.dump(use, open(f'{OUT}/rows-{NROWS}-base.json', 'w'))
    np.save(f'{OUT}/neg.npy', embt(NEG)); np.save(f'{OUT}/media.npy', embt(MEDIA))
    print(tag, 'rows', len(use), f'{time.time() - t0:.0f}s', flush=True)
