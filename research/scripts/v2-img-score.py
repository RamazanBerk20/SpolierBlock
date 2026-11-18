# Title verdict on a calibration / held-out split. Media images are split by work (a work's images are all on one side),
# ordinary photos by file name. Cut-offs are chosen on the calibration split only (no ordinary photo blocked, then most
# right titles minus 3x wrong titles) and reported on the held-out split.
# usage: python -I v2-img-score.py <research dir> <tag>[:<rows file suffix>] [view: sq|cc|pad|mean|max] [N rows] [img.npy override]
import json, sys, zlib
import numpy as np

R, TAGS = sys.argv[1], sys.argv[2]
VIEW = sys.argv[3] if len(sys.argv) > 3 else 'sq'
NMAX = int(sys.argv[4]) if len(sys.argv) > 4 else 10**9
V2 = R + '/results/v2'
tag, _, suf = TAGS.partition(':')
suf = suf or '2000-base'
D = f'{V2}/emb/{tag}'
rows = json.load(open(R + '/results/rows.json'))['rows']
imgs = json.load(open(f'{D}/img.json'))
E = np.load(sys.argv[5] if len(sys.argv) > 5 else f'{D}/img.npy')  # [n, 3 views, d]
use = json.load(open(f'{D}/rows-{suf}.json'))
RE = np.load(f'{D}/rows-{suf}.npy')
keep = [k for k, i in enumerate(use) if i < NMAX]
use, RE = [use[k] for k in keep], RE[keep]
RE = np.round(RE * 127) / 127  # int8 rows as shipped
NEG, MED = np.load(f'{D}/neg.npy'), np.load(f'{D}/media.npy')
vi = {'sq': 0, 'cc': 1, 'pad': 2}
def nrm(x): return x / np.linalg.norm(x, axis=-1, keepdims=True)
if VIEW in vi: X = E[:, vi[VIEW]]
elif VIEW == 'mean': X = nrm(E.mean(1))
else: X = None
S = np.max(np.einsum('nvd,rd->nvr', E, RE), 1) if VIEW == 'max' else X @ RE.T  # [n, rows]
neg = (np.max(np.einsum('nvd,kd->nvk', E, NEG), 1) if VIEW == 'max' else X @ NEG.T).max(1)
med = (np.max(np.einsum('nvd,kd->nvk', E, MED), 1) if VIEW == 'max' else X @ MED.T).max(1)

# families: rows sharing a work (union-find), as tools/build-clip-text.mjs rowFamilies
par = list(range(len(use)))
def find(i):
    while par[i] != i: par[i] = par[par[i]]; i = par[i]
    return i
byw = {}
for k, i in enumerate(use):
    for w in rows[i]['works']:
        if w in byw: par[find(k)] = find(byw[w])
        else: byw[w] = k
fam = np.array([find(k) for k in range(len(use))])
tw = {}
def correct(k, want):
    if want not in tw: tw[want] = {w for r in rows if r['title'] == want for w in r['works']}
    return bool(set(rows[use[k]]['works']) & tw[want])

best = S.argmax(1); bs = S[np.arange(len(S)), best]
gap = np.array([bs[n] - S[n][fam != fam[best[n]]].max() for n in range(len(S))])
marg = bs - neg
media = med - neg
h = lambda s: zlib.crc32(s.encode()) % 2
split = np.array([h(x['want']) if x['want'] else h(x['file'].split('/')[-1]) for x in imgs])
isM = np.array([bool(x['want']) for x in imgs])
ok = np.array([bool(x['want']) and correct(best[n], x['want']) for n, x in enumerate(imgs)])

def evalat(mask, tm, tg, ts=-9):
    hit = mask & (marg >= tm) & (gap >= tg) & (bs >= ts)
    return int((hit & isM & ok).sum()), int((hit & isM & ~ok).sum()), int((hit & ~isM).sum())
cal, held = split == 0, split == 1
# (margin over the generic prompts, gap to the best unrelated title, absolute score of the best title)
q = lambda x, k: [-9] + list(np.quantile(x[isM], np.linspace(0, 1, k + 1))[:-1])
grid = [(tm, tg, ts) for tm in q(marg, 40) for tg in np.arange(0, 0.08, 0.0025) for ts in q(bs, 25)]
def choose(mask, maxfp=0):
    bestv, arg = -1e9, None
    for tm, tg, td in grid:
        r, w, f = evalat(mask, tm, tg, td)
        if f <= maxfp and r - 3 * w > bestv: bestv, arg = r - 3 * w, (tm, tg, td)
    return arg
nm = lambda m: (int((m & isM).sum()), int((m & ~isM).sum()))
out = {'tag': tag, 'rows': suf, 'N': len(use), 'view': VIEW}
for nmx, (a, b) in (('cal->held', (cal, held)), ('held->cal', (held, cal))):
    th = choose(a)
    out[nmx] = {'thr': [round(float(x), 4) for x in th], 'fit': evalat(a, *th), 'report': evalat(b, *th), 'n_media_ordinary': nm(b)}
# top-1 among media (no threshold) and pooled
out['top1'] = f'{int(ok.sum())}/{int(isM.sum())}'
src = np.array([x['src'] for x in imgs])
by = {}
for nmx, b in (('cal->held', held), ('held->cal', cal)):
    tm, tg, ts = out[nmx]['thr']
    hit = b & (marg >= tm) & (gap >= tg) & (bs >= ts)
    for k in set(src[isM]):
        r = by.setdefault(k, [0, 0, int((isM & (src == k)).sum())])
        r[0] += int((hit & isM & ok & (src == k)).sum()); r[1] += int((hit & isM & ~ok & (src == k)).sum())
out['by_src_right_wrong_of'] = by
r1, w1, f1 = out['cal->held']['report']; r2, w2, f2 = out['held->cal']['report']
out['pooled_report'] = {'right': r1 + r2, 'wrong': w1 + w2, 'ordinary_blocked': f1 + f2, 'of': [int(isM.sum()), int((~isM).sum())]}
import os
if os.environ.get('FIXED'):  # the 0.1 rule with its shipped cut-offs: minScore,margin,mediaGate,titleGap
    ms, mg, gt, tg = map(float, os.environ['FIXED'].split(','))
    hit = (bs >= ms) & (marg >= mg) & (media >= gt)
    named = hit & (gap >= tg)
    out['fixed'] = {'cut': os.environ['FIXED'], 'right': int((named & isM & ok).sum()), 'wrong': int((named & isM & ~ok).sum()),
                    'generic_media': int((hit & ~named & isM).sum()), 'ordinary_named': int((named & ~isM).sum()), 'ordinary_generic': int((hit & ~named & ~isM).sum())}
print(json.dumps(out))
with open(f'{V2}/img-score.jsonl', 'a') as f: f.write(json.dumps(out) + '\n')
