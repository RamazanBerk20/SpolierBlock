// Zero-shot spoiler judgement with a small GGUF LLM via llama-server (CPU). Score = P(yes) / (P(yes)+P(no)) of the first answer token.
// usage: node scripts/llm-eval.mjs <model.gguf> [threads=4] [set=eval300|dev]
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { report } from './metrics.mjs';
const R = path.resolve(import.meta.dirname, '..');
const [model, threads = '4', set = 'eval300'] = process.argv.slice(2);
const PORT = 8391;
const ev = set === 'dev'
  ? [...JSON.parse(fs.readFileSync(R + '/../test/fixtures/spoiler-train.json')), ...JSON.parse(fs.readFileSync(R + '/../test/fixtures/spoiler-eval.json'))].map(([text, label]) => ({ text, label, kind: label ? 'pos' : 'neg' }))
  : fs.readFileSync(R + '/results/snap/spoiler-eval.jsonl', 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const SYS = 'You are a spoiler detector for social media posts about movies, TV shows, video games, books, anime and manga. ' +
  'A post is a SPOILER if it reveals or strongly hints at what happens in the story: a death, a twist, a betrayal, who wins or loses, how it ends, a character\'s fate, or a late-story event or reveal. ' +
  'A post is NOT a spoiler if it only gives opinions, praise or criticism, release dates, prices, trailers, casting, gameplay tips, early premise, or speculation and questions about the future. Answer with one word: yes or no.';
const srv = spawn(R + '/llama.cpp/build/bin/llama-server', ['-m', model, '-c', '1024', '-t', threads, '-tb', threads, '--port', String(PORT), '-np', '1', '--no-webui', '--log-disable'], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hwm = () => +(fs.readFileSync(`/proc/${srv.pid}/status`, 'utf8').match(/VmHWM:\s+(\d+)/)?.[1] ?? 0) / 1024;
try {
  for (let i = 0; i < 120; i++) { await sleep(500); try { if ((await fetch(`http://127.0.0.1:${PORT}/health`)).ok) break; } catch {} }
  const ps = [], pm = [], ptoks = [];
  for (const r of ev) {
    const res = await fetch(`http://127.0.0.1:${PORT}/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
      messages: [{ role: 'system', content: SYS }, { role: 'user', content: `Post: "${r.text}"\nIs this post a spoiler? Answer yes or no.` }],
      max_tokens: 1, temperature: 0, logprobs: true, top_logprobs: 20, chat_template_kwargs: { enable_thinking: false }, cache_prompt: true }) }).then((x) => x.json());
    const top = res.choices?.[0]?.logprobs?.content?.[0]?.top_logprobs ?? [];
    let y = 0, n = 0;
    for (const t of top) { const k = t.token.trim().toLowerCase(); if (k === 'yes') y += Math.exp(t.logprob); else if (k === 'no') n += Math.exp(t.logprob); }
    ps.push(y + n > 0 ? y / (y + n) : 0.5);
    pm.push(res.timings?.prompt_ms ?? 0); ptoks.push(res.timings?.prompt_n ?? 0);
  }
  const tag = path.basename(model, '.gguf');
  const med = (a) => [...a].sort((x, y) => x - y)[a.length >> 1];
  console.log(`${tag} threads ${threads}: median new prompt tokens ${med(ptoks)}, median prompt ms ${med(pm).toFixed(0)}, peak RSS ${hwm().toFixed(0)} MB`);
  report(tag, ev, ps, 0.5);
  fs.mkdirSync(R + '/results/llm', { recursive: true });
  fs.writeFileSync(`${R}/results/llm/${tag}-${set}.json`, JSON.stringify(ps));
} finally { srv.kill('SIGTERM'); }
