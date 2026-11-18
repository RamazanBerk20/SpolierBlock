# Samples balanced sentence-level spoiler labels from the (possibly partially downloaded) UCSD Goodreads spoiler dump.
# Research/evaluation use only (dataset is "academic use only"); output data/goodreads/sample.jsonl
import zlib, json, random, sys
random.seed(1)
d = zlib.decompressobj(16 + zlib.MAX_WBITS)
buf = b''; pos, neg = [], []
with open(sys.argv[1], 'rb') as f:
    while len(pos) < 15000:
        chunk = f.read(1 << 20)
        if not chunk: break
        try: buf += d.decompress(chunk)
        except zlib.error: break
        *lines, buf = buf.split(b'\n')
        for l in lines:
            try: r = json.loads(l)
            except Exception: continue
            for lab, s in r['review_sentences']:
                if 20 <= len(s) <= 220: (pos if lab else neg).append(s)
random.shuffle(pos); random.shuffle(neg)
n = min(len(pos), 15000)
out = [{'text': s, 'y': 1} for s in pos[:n]] + [{'text': s, 'y': 0} for s in neg[:n]]
random.shuffle(out)
open(sys.argv[2], 'w').write('\n'.join(json.dumps(x) for x in out))
print('pos available', len(pos), 'neg', len(neg), 'written', len(out))
