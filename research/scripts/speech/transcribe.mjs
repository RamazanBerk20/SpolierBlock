// usage: node transcribe.mjs  (run from repo root) -> research/data/speech/transcripts.json
import fs from 'node:fs'; import path from 'node:path';
const R = path.resolve('research/data/speech');
const { pipeline, env } = await import(path.resolve('node_modules/@huggingface/transformers/src/transformers.js'));
env.cacheDir = path.join(R, 'models'); env.allowLocalModels = false;
const manifest = JSON.parse(fs.readFileSync(path.join(R, 'manifest.json'), 'utf8'));
const wav = (f) => { const b = fs.readFileSync(f); let o = 12; while (b.toString('ascii', o, o + 4) !== 'data') o += 8 + b.readUInt32LE(o + 4);
  const n = Math.min(480000, (b.length - o - 8) >> 1), a = new Float32Array(n); for (let i = 0; i < n; i++) a[i] = b.readInt16LE(o + 8 + 2 * i) / 32768; return a; };
const configs = [['Xenova/whisper-tiny.en', 'q8'], ['Xenova/whisper-base.en', 'q8'], ['Xenova/whisper-tiny', 'q8'], ['Xenova/whisper-tiny.en', 'fp32']];
const out = fs.existsSync(path.join(R, 'transcripts.json')) ? JSON.parse(fs.readFileSync(path.join(R, 'transcripts.json'), 'utf8')) : {};
for (const [model, dtype] of configs) {
  const key = `${model.split('/')[1]}-${dtype}`; out[key] ??= { threads: {}, text: {} };
  for (const threads of [4, 1]) {
    const p = await pipeline('automatic-speech-recognition', model, { dtype, session_options: { intraOpNumThreads: threads, interOpNumThreads: 1 } });
    const lang = model.endsWith('.en') ? {} : { language: 'english', task: 'transcribe' };
    await p(new Float32Array(16000 * 3), lang); // warm-up
    let t = 0, secs = 0;
    for (const c of manifest) {
      const a = wav(path.join(R, 'clips', c.id + '.wav')); if (a.length < 16000) continue;
      const t0 = performance.now(); const r = await p(a, lang); const dt = performance.now() - t0;
      t += dt; secs += a.length / 16000; if (threads === 4) out[key].text[c.id] = r.text.trim();
    }
    out[key].threads[threads] = { sec_per_30s: +(t / 1000 / (secs / 30)).toFixed(2), audio_s: secs };
    console.log(key, threads, out[key].threads[threads]); await p.dispose?.();
    fs.writeFileSync(path.join(R, 'transcripts.json'), JSON.stringify(out, null, 1));
  }
}
