// Small VLM via llama-server (CPU): "which work is this image from?" on media images + ordinary photos.
// usage: node scripts/vlm-eval.mjs <model.gguf> <mmproj.gguf> [threads=4] [maxImages=80]
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import sharp from 'sharp';
const R = path.resolve(import.meta.dirname, '..');
const [model, mmproj, threads = '4', maxN = '80'] = process.argv.slice(2);
const PORT = 8392;
const imgs = JSON.parse(fs.readFileSync(R + '/results/images.json'));
// fixed subset: all fixture media, every 3rd Commons cosplay/lead image, 20 ordinary
// fixed subset: 31 fixture media, 24 Commons (every 15th cosplay/lead image), 20 ordinary (every 8th)
const pick = [...imgs.filter((x) => x.src === 'fixture'), ...imgs.filter((x) => x.src === 'cosplay' || x.src === 'lead').filter((_, i) => i % 15 === 0),
  ...imgs.filter((x) => !x.want).filter((_, i) => i % 8 === 0).slice(0, 20)].slice(0, +maxN);
const srv = spawn(R + '/llama.cpp/build/bin/llama-server', ['-m', model, '--mmproj', mmproj, '-c', '2048', '-t', threads, '-tb', threads, '--port', String(PORT), '-np', '1', '--no-webui', '--log-disable'], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hwm = () => +(fs.readFileSync(`/proc/${srv.pid}/status`, 'utf8').match(/VmHWM:\s+(\d+)/)?.[1] ?? 0) / 1024;
const norm = (s) => (s ?? '').toLowerCase().normalize('NFKD').replace(/\p{M}/gu, '').replace(/[^a-z0-9]+/g, ' ').trim();
const STOP = new Set(['the', 'of', 'a', 'and', 'bros']);
const key = (t) => norm(t).split(' ').filter((w) => w.length > 2 && !STOP.has(w));
try {
  for (let i = 0; i < 240; i++) { await sleep(500); try { if ((await fetch(`http://127.0.0.1:${PORT}/health`)).ok) break; } catch {} }
  const res = [];
  for (const x of pick) {
    const jpg = await sharp(x.file).resize(384, 384, { fit: 'inside' }).jpeg({ quality: 90 }).toBuffer();
    const t = performance.now();
    const r = await fetch(`http://127.0.0.1:${PORT}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
      messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/jpeg;base64,' + jpg.toString('base64') } },
        { type: 'text', text: process.env.P2 ? 'What is the title of the movie, TV show, video game, anime or book shown in this image? Reply with the title only, or "none" if it is an ordinary photo.' : 'Is this image from a movie, TV show, video game, anime, comic or book? If yes, answer with only its title. If it is an ordinary photo, answer "none".' }] }],
      max_tokens: 16, temperature: 0, chat_template_kwargs: { enable_thinking: false } }) }).then((q) => q.json());
    const ms = performance.now() - t;
    const ans = r.choices?.[0]?.message?.content?.trim() ?? `ERR ${JSON.stringify(r).slice(0, 100)}`;
    const a = norm(ans), k = x.want ? key(x.want) : [];
    const right = x.want ? k.length > 0 && k.every((w) => a.includes(w)) : null;
    const saysNone = /\bnone\b|\bno\b|ordinary|not from/.test(a);
    res.push({ f: path.basename(x.file), src: x.src, want: x.want, ans, right, saysNone, ms: Math.round(ms) });
  }
  const M = res.filter((r) => r.want), O = res.filter((r) => !r.want);
  const med = (a) => [...a].sort((p, q) => p - q)[a.length >> 1];
  const tag = path.basename(model, '.gguf') + (process.env.P2 ? '-p2' : '');
  console.log(`${tag}: media right ${M.filter((r) => r.right).length}/${M.length} (fixture ${M.filter((r) => r.right && r.src === 'fixture').length}/${M.filter((r) => r.src === 'fixture').length}), ` +
    `ordinary answered none ${O.filter((r) => r.saysNone).length}/${O.length}, median ms/image ${med(res.map((r) => r.ms))}, peak RSS ${hwm().toFixed(0)} MB`);
  fs.mkdirSync(R + '/results/vlm', { recursive: true });
  fs.writeFileSync(`${R}/results/vlm/${tag}.json`, JSON.stringify(res, null, 1));
} finally { srv.kill('SIGTERM'); }
