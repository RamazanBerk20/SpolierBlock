# Real-world-like OCR set: YouTube-style thumbnails, subtitle frames, game achievement/HUD popups, memes, post
# screenshots and stylised title cards, rendered over the research photos and degraded like feed images (downscaled,
# JPEG). Text names catalog works (titles, characters) so OCR can be scored end to end through the matcher.
# usage: python -I v2-ocr-set.py <research dir> <out dir>      -> <out>/*.jpg + truth.json
import json, os, random, sys
from PIL import Image, ImageDraw, ImageFont, ImageFilter

R, OUT = sys.argv[1], sys.argv[2]
FONTS = R + '/results/v2/fonts/'
os.makedirs(OUT, exist_ok=True)
rnd = random.Random(20261118)
rows = json.load(open(R + '/results/rows.json'))['rows']
works = [r for r in rows[:1500] if r['type'] in ('movie', 'tv', 'game', 'anime') and len(r['title']) <= 28]
chars = [(r, c) for r in works for c in (r.get('characters') or [])[:3] if 6 <= len(c) <= 22 and c.isascii()]
bgs = [x['file'] for x in json.load(open(R + '/results/images.json'))]

def font(name, size):
    p = name if name.startswith('/') else FONTS + name
    f = ImageFont.truetype(p, size)
    if name.endswith(('Montserrat.ttf', 'Oswald.ttf', 'Cinzel.ttf')):
        try: f.set_variation_by_axes([800])
        except Exception: pass
    return f

SYS = '/usr/share/fonts/'
SANS = [SYS + 'liberation/LiberationSans-Regular.ttf', SYS + 'noto/NotoSans-Regular.ttf', SYS + 'TTF/OpenSans-Regular.ttf', SYS + 'TTF/DejaVuSans.ttf']
SANS_B = [SYS + 'liberation/LiberationSans-Bold.ttf', SYS + 'noto/NotoSans-Bold.ttf', SYS + 'TTF/OpenSans-Bold.ttf']
HEAVY = ['Anton-Regular.ttf', 'BebasNeue-Regular.ttf', 'Montserrat.ttf', 'Oswald.ttf', SYS + 'noto/NotoSans-Black.ttf', SYS + 'TTF/OpenSans-ExtraBold.ttf']
FANCY = ['Cinzel.ttf', 'Creepster-Regular.ttf', 'Bangers-Regular.ttf', 'PressStart2P-Regular.ttf', SYS + 'gsfonts/URWBookman-Demi.otf',
         SYS + 'noto/NotoSerif-Black.ttf', SYS + 'gsfonts/C059-Bold.otf', 'Anton-Regular.ttf']

def bg(w, h, dim=1.0):
    im = Image.open(rnd.choice(bgs)).convert('RGB')
    s = max(w / im.width, h / im.height)
    im = im.resize((max(w, round(im.width * s)), max(h, round(im.height * s))))
    x, y = (im.width - w) // 2, (im.height - h) // 2
    im = im.crop((x, y, x + w, y + h))
    return Image.eval(im, lambda v: int(v * dim)) if dim != 1 else im

def fit(draw, text, fname, size, maxw, stroke=0):
    while size > 8:
        f = font(fname, size)
        if draw.textlength(text, font=f) + 2 * stroke <= maxw: return f
        size -= 2
    return font(fname, size)

def wrap(text, n):
    words, lines, cur = text.split(), [], ''
    for w in words:
        if cur and len(cur) + 1 + len(w) > n: lines.append(cur); cur = w
        else: cur = (cur + ' ' + w).strip()
    return lines + [cur]

def out(im, w, q):
    im = im.resize((w, round(im.height * w / im.width)), Image.LANCZOS)
    return im, q

T_THUMB = ['{T} ENDING EXPLAINED', 'I FINALLY PLAYED {T}', '{T} IS A MASTERPIECE', '{C} DIES?!', 'WHY {T} FAILED', '{T} REVIEW',
           '{T} SEASON 2 BREAKDOWN', 'THE TRUTH ABOUT {C}', '{T} - 100% WALKTHROUGH', 'EVERY {T} SECRET', '{C} RETURNS']
T_SUB = ['{C}, wait! Don\'t go in there!', 'I know what {C} did to us.', 'We have to find {C} before dawn.', 'Is that really {C}?',
         'Nobody remembers {C} anymore.', 'Tell {C} I\'m sorry.', 'You sound just like {C}.']
T_HUD = [('Achievement Unlocked', 'Defeat {C}'), ('Trophy earned', 'Escaped with {C}'), ('NEW QUEST', 'Find {C}'), ('Achievement Unlocked', 'Completed {T}'),
         ('Quest complete', 'Saved {C}')]
T_MEME = [('WHEN {C}', 'FINALLY SHOWS UP'), ('ME AFTER FINISHING', '{T}'), ('NOBODY:', '{C}:'), ('{T} FANS', 'BE LIKE'), ('ONE DOES NOT SIMPLY', 'SKIP {T}')]
T_POST = ['just finished {T} and I am not okay', 'can we talk about what happened to {C}', '{T} season finale tonight, no spoilers please',
          'hot take: {T} has the best ending ever', 'still thinking about {C} in {T}']

def pick(tpl):
    if '{C}' in tpl or (isinstance(tpl, tuple) and any('{C}' in t for t in tpl)):
        w, c = rnd.choice(chars)
    else:
        w, c = rnd.choice(works), None
    f = lambda s, up: s.replace('{T}', w['title'].upper() if up else w['title']).replace('{C}', (c or '').upper() if up else (c or ''))
    return w, f

truth = {}
def save(name, im, w, q, lines, want, style):
    im, q = out(im, w, q)
    im.save(f'{OUT}/{name}.jpg', quality=q)
    truth[name + '.jpg'] = {'lines': lines, 'want': want, 'style': style, 'w': im.width, 'h': im.height}

for i in range(60):  # YouTube-style thumbnail: 1280x720 -> 320..480 px wide
    W, H = 1280, 720
    im = bg(W, H)
    d = ImageDraw.Draw(im)
    tpl = rnd.choice(T_THUMB); wk, f = pick(tpl); text = f(tpl, True)
    lines = wrap(text, rnd.choice([12, 16, 22]))
    fn = rnd.choice(HEAVY); st = rnd.choice([6, 8, 12])
    fill = rnd.choice(['#ffffff', '#ffe600', '#ff2b2b', '#36ff5a', '#ffffff'])
    y = rnd.choice([40, 360 - 90 * len(lines) // 2, 700 - 150 * len(lines)])
    side = rnd.choice(['l', 'c', 'r'])
    for ln in lines:
        fo = fit(d, ln, fn, 150, W * rnd.choice([0.6, 0.75, 0.9]), st)
        tw = d.textlength(ln, font=fo)
        x = {'l': 40, 'c': (W - tw) / 2, 'r': W - tw - 40}[side]
        if rnd.random() < 0.25:
            d.rectangle([x - 16, y - 6, x + tw + 16, y + fo.size * 1.15], fill=rnd.choice(['#d00000', '#000000', '#ffe600']))
            d.text((x, y), ln, font=fo, fill='#ffffff' if fill == '#ffe600' else fill)
        else:
            d.text((x, y), ln, font=fo, fill=fill, stroke_width=st, stroke_fill='#000000')
        y += fo.size * 1.2
    if rnd.random() < 0.4: im = im.rotate(rnd.uniform(-5, 5), resample=Image.BICUBIC, fillcolor=(20, 20, 20))
    save(f'thumb_{i}', im, rnd.choice([320, 400, 480]), rnd.choice([60, 75, 85]), [text], wk['title'], 'thumb')

for i in range(50):  # subtitle frame: 1280x720 frame sampled at 448 px wide (the extension's video frame size)
    W, H = 1280, 720
    im = bg(W, H, 0.8)
    d = ImageDraw.Draw(im)
    tpl = rnd.choice(T_SUB); wk, f = pick(tpl); text = f(tpl, False)
    lines = wrap(text, 34)
    fo = font(rnd.choice(SANS + SANS_B), rnd.choice([40, 46, 52]))
    y = H - 50 - len(lines) * fo.size * 1.25
    box = rnd.random() < 0.35
    for ln in lines:
        tw = d.textlength(ln, font=fo)
        x = (W - tw) / 2
        if box:
            ov = Image.new('RGBA', im.size); ImageDraw.Draw(ov).rectangle([x - 12, y - 4, x + tw + 12, y + fo.size * 1.2], fill=(0, 0, 0, 170))
            im = Image.alpha_composite(im.convert('RGBA'), ov).convert('RGB'); d = ImageDraw.Draw(im)
            d.text((x, y), ln, font=fo, fill='#ffffff')
        else:
            d.text((x, y), ln, font=fo, fill=rnd.choice(['#ffffff', '#ffffff', '#fff35c']), stroke_width=3, stroke_fill='#000000')
        y += fo.size * 1.25
    save(f'sub_{i}', im, 448, rnd.choice([70, 85]), [text], wk['title'], 'subtitle')

for i in range(40):  # game HUD: achievement / trophy toast or quest banner over a darkened frame -> 640 px
    W, H = 1280, 720
    im = bg(W, H, 0.6)
    d = ImageDraw.Draw(im)
    tpl = rnd.choice(T_HUD); wk, f = pick(tpl); head, body = tpl[0], f(tpl[1], False)
    kind = rnd.choice(['xbox', 'steam', 'quest'])
    if kind == 'xbox':
        x0, y0 = 340, 560
        d.rounded_rectangle([x0, y0, x0 + 600, y0 + 110], radius=55, fill='#1b1b1b')
        d.ellipse([x0 + 12, y0 + 12, x0 + 98, y0 + 98], fill='#107c10')
        d.text((x0 + 120, y0 + 18), head, font=font(rnd.choice(SANS), 28), fill='#cccccc')
        d.text((x0 + 120, y0 + 56), body, font=fit(d, body, rnd.choice(SANS_B), 34, 460), fill='#ffffff')
    elif kind == 'steam':
        x0, y0 = W - 520, H - 150
        d.rectangle([x0, y0, x0 + 500, y0 + 130], fill='#23313f')
        d.rectangle([x0 + 14, y0 + 14, x0 + 116, y0 + 116], fill='#6b8aa6')
        d.text((x0 + 134, y0 + 24), head + '!', font=font(rnd.choice(SANS_B), 26), fill='#ffffff')
        d.text((x0 + 134, y0 + 66), body, font=fit(d, body, rnd.choice(SANS), 26, 350), fill='#a7b7c6')
    else:
        fo = fit(d, body.upper(), rnd.choice(['Cinzel.ttf', SYS + 'gsfonts/C059-Bold.otf', 'Oswald.ttf']), 64, 1000, 3)
        tw = d.textlength(body.upper(), font=fo)
        d.text(((W - tw) / 2, 140), head.upper(), font=font(rnd.choice(SANS), 30), fill='#e8d9a0')
        d.text(((W - tw) / 2, 190), body.upper(), font=fo, fill='#f4ecd0', stroke_width=3, stroke_fill='#000000')
        body = body.upper()
    save(f'hud_{i}', im, 640, rnd.choice([70, 85]), [head, body], wk['title'], 'hud')

for i in range(50):  # meme: classic top/bottom caption (Impact-like) or modern white caption bar -> 500..640 px
    tpl = rnd.choice(T_MEME); wk, f = pick(tpl)
    if rnd.random() < 0.6:
        W, H = 800, 800
        im = bg(W, H); d = ImageDraw.Draw(im)
        top, bot = f(tpl[0], True), f(tpl[1], True)
        fn = rnd.choice(['Anton-Regular.ttf', 'Oswald.ttf', SYS + 'TTF/OpenSans-ExtraBold.ttf'])
        for t, y in ((top, 20), (bot, H - 130)):
            fo = fit(d, t, fn, 96, W - 40, 5)
            d.text(((W - d.textlength(t, font=fo)) / 2, y), t, font=fo, fill='#ffffff', stroke_width=5, stroke_fill='#000000')
        lines = [top, bot]
    else:
        W, H = 800, 860
        im = Image.new('RGB', (W, H), 'white'); im.paste(bg(W, 640), (0, 220)); d = ImageDraw.Draw(im)
        t = f(tpl[0] + ' ' + tpl[1], False).capitalize() if rnd.random() < 0.5 else f(tpl[0] + ' ' + tpl[1], False)
        fo = font(rnd.choice(SANS), 46); y = 30
        for ln in wrap(t, 30):
            d.text((30, y), ln, font=fo, fill='#000000'); y += 58
        lines = [t]
    save(f'meme_{i}', im, rnd.choice([500, 640]), rnd.choice([65, 80]), lines, wk['title'], 'meme')

for i in range(30):  # post screenshot (light / dark), small UI text -> 600 px
    tpl = rnd.choice(T_POST); wk, f = pick(tpl); t = f(tpl, False)
    dark = rnd.random() < 0.5
    W, H = 1200, 520
    im = Image.new('RGB', (W, H), '#15202b' if dark else '#ffffff'); d = ImageDraw.Draw(im)
    fg = '#e7e9ea' if dark else '#0f1419'
    d.ellipse([40, 40, 140, 140], fill='#888888')
    d.text((170, 50), 'Some User', font=font(SANS_B[0], 34), fill=fg)
    d.text((170, 95), '@someuser · 2h', font=font(SANS[0], 30), fill='#8b98a5')
    y = 180
    fo = font(rnd.choice(SANS), 40)
    for ln in wrap(t, 44):
        d.text((40, y), ln, font=fo, fill=fg); y += 54
    save(f'post_{i}', im, 600, 80, [t], wk['title'], 'post')

for i in range(30):  # stylised title card / key art: display fonts, outlines, glow -> 320..480 px
    W, H = 1280, 720
    im = bg(W, H, rnd.choice([0.35, 0.6, 1.0])); d = ImageDraw.Draw(im)
    wk = rnd.choice(works); t = wk['title'].upper() if rnd.random() < 0.7 else wk['title']
    fn = rnd.choice(FANCY)
    lines = wrap(t, 14)
    y = H / 2 - len(lines) * 70
    col = rnd.choice(['#e50914', '#f5c518', '#ffffff', '#9ad7ff'])
    glow = rnd.random() < 0.4
    for ln in lines:
        fo = fit(d, ln, fn, 150, W * 0.85, 4)
        x = (W - d.textlength(ln, font=fo)) / 2
        if glow:
            g = Image.new('RGBA', im.size); ImageDraw.Draw(g).text((x, y), ln, font=fo, fill=col)
            im = Image.alpha_composite(im.convert('RGBA'), g.filter(ImageFilter.GaussianBlur(12))).convert('RGB'); d = ImageDraw.Draw(im)
            d.text((x, y), ln, font=fo, fill='#ffffff')
        else:
            d.text((x, y), ln, font=fo, fill=col, stroke_width=rnd.choice([0, 3]), stroke_fill='#000000')
        y += fo.size * 1.15
    save(f'title_{i}', im, rnd.choice([320, 480]), rnd.choice([65, 80]), [t], wk['title'], 'title')

json.dump(truth, open(OUT + '/truth.json', 'w'), indent=1)
print(len(truth), 'images')
