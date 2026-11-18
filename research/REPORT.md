# SpolierBlocker on-device ML research (2026-11-18)

Machine: i5-10500H (6 cores / 12 threads), 16 GB RAM, Intel UHD 630 integrated GPU. `lspci` lists an RTX 3060, but `nvidia-smi` reports "No devices were found" and Vulkan sees only the Intel GPU, so in practice there is no dGPU. Other agents were running at the same time (load average 6–10), so latencies are ±30%; compare only rows measured back to back. Browsers: Chrome for Testing 157 and Zen 1.24.2b (Firefox 160), both with temporary profiles and the probe extension in `ext-probe/`.

## 1. Ranked list

| # | Item | What it buys (measured) | What it costs | Verdict | Source file |
|---|---|---|---|---|---|
| 1 | **Chrome: WASM threads**, by adding `cross_origin_embedder_policy: require-corp` and `cross_origin_opener_policy: same-origin` to the manifest | The offscreen document becomes `crossOriginIsolated: true`. Image model (CLIP-B/32): 201 → 74 ms. Fine-tuned text model: 17 → 7 ms. Fetching cross-origin page images still works. | +0 MB. Two manifest keys; `engine.js` already handles threads. Effort S. Chrome only. | **Do now** | `results/chrome-bench-cand.jsonl`, `chrome-bench-threads.jsonl`, `scripts/coep-fetch.mjs` |
| 2 | **Fine-tune the MiniLM text model end to end**, on the same data the current classifier uses | On the 300-post eval: AUC 0.942 → **0.960** (int8 ONNX in onnxruntime-web). F1 0.87 → 0.89, recall 0.92 → 0.96. | **+0 MB**: the same 23 MB model replaces the frozen one. 15 ms per post in Node, 1 thread. In Chrome 17 ms (1 thread) / 7 ms (4 threads) per sentence. 9 minutes of CPU training. Effort S–M. | **Do now** | `results/ft/minilm-ft-proj.json`, `scripts/ft-int8.mjs` output, `results/text-baseline.json` |
| 3 | **Images: SigLIP 2 base/16** with 4-bit weights (63 MB) instead of CLIP-B/32 (85 MB) | With 0 of 155 ordinary photos blocked: **36 correct titles vs 10** today. At 2% of ordinary photos blocked: 70 vs 37. Test fixtures: 17/31 vs 10/31. Posters: 25/27 vs 15/27. | −22 MB on disk. Slower: 494 ms (Chrome, 4 threads), 1.5 s (1 thread, Chrome or Zen); today 74 / 201 / 240 ms. Effort M (new preprocessing and recalibration). | **Do now, Chrome first.** A cheaper middle step is CLIP-B/16 (87 MB, 13/31 on fixtures, 59 right at 2%, 200 ms with 4 threads, 890 ms in Zen). | `results/img-score.jsonl`, `chrome-bench-cand.jsonl`, `zen-bench-cand.jsonl` |
| 4 | **Plot knowledge for posts that name nothing**: Wikipedia plot sentences embedded with the MiniLM model already shipped, plus distinctive names and places from the plots | Spoiler posts with every name stripped: the right work for 57/146 (39%). 16 of 3,000 ordinary sentences falsely tied to a work. Real Reddit comments: 238/388. Non-spoiler posts rarely match (4/139), so a plot match correlates with spoilers. "Arthur deserved better. That sunrise scene…" ranks RDR2 first. | 130 works make 10.3k sentences, 4.0 MB int8. About 15 ms per query. The top 2,000 works would be about 60 MB (estimate). Effort L. Text is CC BY-SA and needs attribution. | **Do later.** Start with the name/place part alone (about 1 MB; requiring 2 names gives 3/3000 false triggers), then embeddings for the top ~500 works. | `results/plot-minilm.log`, `results/plot/*.json` |
| 5 | Image-to-image gallery of poster/still embeddings | With SigLIP 2: 45/168 held-out queries right at 0 false positives (4 wrong); CLIP-B/32 gets 25. But only 1–2 of 8 independent fixture images were right. | About 19 MB for 5 images × 5,000 works. **The licence blocks it**: TMDB forbids ML use without a written agreement, Commons and Wikidata have almost no modern posters, and Wikipedia posters are fair use for Wikipedia only. | **Don't** until there is a licensable image source | `results/img-score.jsonl` (`gal_*` fields) |
| 6 | Small LLM as a second-stage spoiler judge | No zero-shot model ≤2B beats the shipped classifier (AUC 0.942). Qwen3.5-2B 0.915, Qwen3.5-0.8B 0.889, LFM2.5-1.2B 0.873, Gemma-3-1B 0.866, Qwen3-0.6B 0.805, Gemma-3-270M 0.554, LFM2.5-350M 0.395. As a second opinion on uncertain posts, Gemma-3-1B lifts F1 0.87 → 0.89: the same as item 2. | 0.3–1.3 GB on disk, 0.4–1.9 GB RAM, 0.25–1.8 s per post with 4 native threads. | **Don't** | `results/llm-eval300.log`, `results/llm/*.json`, `scripts/cascade.mjs` |
| 7 | Tiny VLMs naming the work in an image | Of 56 media images: Qwen3.5-0.8B 12, LFM2.5-VL-450M 6, SmolVLM2-500M 2, SmolVLM-256M 0. Qwen and LFM correctly answered "none" on 20/20 ordinary photos. | 0.7–4.1 GB peak RAM (Qwen with its F16 vision projector: 4.1 GB). 1.0–3.2 s per image. | **Don't.** SigLIP 2 does better at a tenth of the memory. | `results/vlm.log`, `results/vlm/*.json` |
| 8 | WebGPU | Off by default on this Linux iGPU in both browsers. With flags, Chrome runs CLIP-B/32 fp16 in 97 ms and SigLIP 2 fp16 in 334 ms. Int8 and 4-bit models on WebGPU are slow or wrong (CLIP int8: 667 ms and wrong output; SigLIP 2 4-bit: 2,090 ms). In Zen with the pref, the text model is slower than WASM (100 vs 24 ms). | fp16 copies double the download. | **Don't rely on it.** At most an optional fp16 fast path where an adapter exists. | `results/chrome-bench-webgpu-flags.jsonl`, `chrome-bench-cand.jsonl`, `zen-bench.jsonl` |
| 9 | WebNN | `navigator.ml` is missing in both browsers. | – | **Dead for now** | probe capability output |
| 10 | Threads in Firefox | Extension background page and tab are not cross-origin isolated and have no SharedArrayBuffer. Bugzilla 1673477 is still open. | – | **Not possible.** Size Firefox models for 1 thread. | probe capability output |
| 11 | Gemini Nano (Chrome Prompt API, Android AICore) | Not measured. | From documentation: Chrome needs 22 GB free disk and >4 GB VRAM or 16 GB RAM. Android: flagship phones only, foreground only, per-app quota, and it is unknown whether a re-signed app is accepted. | **Don't** for "any hardware" | documentation only |
| – | Goodreads training data | AUC 0.962 vs 0.964 without it. | Licence says "academic use only". | **Don't** | `results/ft/minilm-ft-proj+gr8k.json` |
| – | Bigger text encoders for item 4 | Combined score: bge-small 42/146, embeddinggemma-300m 44/146 (possibly set up wrong), MiniLM 57/146. | +34 MB / +309 MB | **Don't.** Reuse MiniLM. | `results/plot-bge.log`, `plot-egemma.log` |

## 2. Budget table (desktop browser)

| Config | What is in it | Disk | Memory | Latency per item, Chrome 4 threads / Zen 1 thread | What it buys |
|---|---|---|---|---|---|
| Today | CLIP-B/32 + MiniLM + tesseract | ~115 MB | 380–520 MB process (earlier runs) | image 201 ms in Chrome today (1 thread) / 240 ms in Zen; text 17 / 24 ms | baseline |
| **Lean (~300 MB)** | Today + Chrome threads + fine-tuned MiniLM + plot names/places (~1 MB) | ~116 MB | about the same as today | image 74 / 240 ms; text 7 / 22 ms | text AUC 0.94 → 0.96; 2.7x faster in Chrome; some name-free posts caught (names-only recall not measured separately; ~3 false triggers per 3,000 ordinary sentences) |
| **Balanced (~600 MB)** | Lean + SigLIP 2 4-bit instead of CLIP (CLIP-B/16 in Firefox) + plot embeddings for the top ~500 works (~15 MB) | ~110 MB | estimated +~100 MB; vision-only memory was not isolated | image 494 / 890–1,501 ms; text 7 / 22 ms | correct image titles at 0 false positives 10 → 36; ~39% of name-free spoiler posts get a work |
| **Max (~1 GB)** | Balanced + plot embeddings for the top 2,000 works (~60 MB) + CLIP-L/14 as a second opinion (307 MB) | ~430 MB | ~0.8–1 GB (estimate) | CLIP-L adds 1,027 / 4,223 ms per image | CLIP-L: cosplay top-1 111/334 vs 66 |

- **What 1 GB cannot buy:** a 2B LLM (1.9 GB RAM, AUC 0.915) adds nothing over item 2. No VLM good enough to name works was found below about 4 GB.
- **Android (8 GB phone), estimates only:** the same ONNX files run in ONNX Runtime Mobile (AAR 24.4 MB, or 7.5 MB in a reduced build, per its documentation). No phone was attached, so nothing on Android was measured. Suggested order:
  1. Fine-tuned MiniLM (23 MB, estimated 5–10 ms).
  2. Plot names and places.
  3. SigLIP 2 only if image blocking is wanted; its 4-bit kernel speed on ARM is unknown.

## 3. Key measurements

**Latency (median ms per item):**

| Model | Chrome 1 thread | Chrome 4 threads | Zen 1 thread |
|---|---|---|---|
| CLIP-B/32 int8 (current image model) | 201 | 74 | 240–260 |
| CLIP-B/16 int8 | 691 | 200 | 890 |
| CLIP-L/14 int8 | 3,099 | 1,027 | 4,223 |
| SigLIP 2, 4-bit | 1,507 | 494 | 1,501 |
| Fine-tuned MiniLM int8 | 17 | 7 | 22 |

A sweep across thread counts showed 4 threads is the sweet spot; 6 is no better.

**Image models** (`results/img-score.jsonl`). The test set has 392 media images: 31 fixtures (3 files named in `labels.json` are missing on disk), 334 Commons cosplay and character photos covering 50 works, and 27 Wikipedia lead images. It has 155 ordinary photos: 44 fixtures plus 111 hard negatives from Commons (costumes, rodeo, masks, castles…).

| Model | Disk | Fixture top-1 | Cosplay top-1 (of 334) | Poster top-1 | Right / wrong at 0 false positives | Right / wrong at 2% false positives |
|---|---|---|---|---|---|---|
| CLIP-B/32 int8 | 85 MB | 10/31 | 48 | 15/27 | 10 / 2 | 37 / 35 |
| CLIP-B/16 int8 | 87 MB | 13/31 | 66 | 18/27 | 13 / 4 | 59 / 83 |
| CLIP-L/14 int8 | 307 MB | 13/31 | 111 | 21/27 | 12 / 5 | 74 / 42 |
| **SigLIP 2, 4-bit** | **63 MB** | **17/31** | 66 | **25/27** | **36 / 5** | 70 / 59 |
| SigLIP 2, fp32 (reference) | 372 MB | 17/31 | 67 | 23/27 | 44 / 13 | 64 / 56 |

**SigLIP 2 setup gotchas:**
- **int8 breaks it.** The int8 file on Hugging Face scores 0/31, and my own int8 conversions score 8/31. Only weight-only 4-bit holds up; 8-bit weight-only was not tried.
- **Its text side needs lowercase input** and fixed-length padding to 64 tokens. It runs at build time only.

**MobileCLIP-S2 is unverified:** it gave random output, which I did not debug. Its Apple AMLR licence is a separate obstacle.

**Text:** the shipped classifier (snapshot taken at 10:49) scores AUC 0.942, P 0.83, R 0.92, F1 0.87 at threshold 0.5. The fine-tuned int8 model scores AUC 0.960, P 0.82, R 0.96, F1 0.89 at threshold 0.45, which was chosen on the validation split.

**Plot prototype** (`results/plot-minilm.log`):

| Query set | Top-1 | Top-3 | At 1% false positives | At 0.1% false positives | Names/places ≥1 (right / wrong) | Combined |
|---|---|---|---|---|---|---|
| Spoiler posts, names stripped (146) | 80 | 97 | 51 | 30 | 55 / 11 | 57 |
| Reddit comments (388) | 287 | 319 | 147 | 74 | 249 / 10 | 238 |
| Non-spoiler posts, names stripped (139) | 20 | – | – | – | – | 4 |

- **Ordinary sentences (out of 3,000) falsely tied to a work:** 100 with ≥1 name/place, 3 with ≥2, and 16 with the combined rule.
- **The three unnamed RDR2 probe posts:** only the "sunrise" one went to RDR2; "last ride" went to Arcane and "good man in the end" to Anna Karenina.
- **The Reddit row is optimistic,** because those 4 shows also have episode summaries in the database.

## 4. Not measured, and where the eval set could leak

**Not measured:**
- **OCR alternatives.** Scripts are ready but were not run after the stop:
  - 24 synthetic caption images in `data/ocr/`, made by `scripts/ocr-synth.mjs`.
  - `ocr-tesseract.mjs`, `ocr-florence.mjs` and `ocr-rapid.py`.
- **In-browser LLM speed** (wllama, WebLLM).
- **NLI zero-shot classifiers.**
- **A bigger fine-tuned text encoder.**
- **Any Android number.**
- **Gemini Nano.**
- **WebGPU on Windows or macOS.**
- **Vision-only memory per model.** `scripts/rss-model.mjs` is written but not run.
- **Whether tesseract workers still start under COEP.** Test this before shipping item 1.
- **MobileCLIP2.** The S2 run was version 1.
- **8-bit weight-only SigLIP 2.**
- **CLIP accuracy with all 23k title rows.**

**Leakage and bias:**
- **The shipped classifier's 0.942 is likely optimistic.** The other agent trained it on patterns that read much like the eval's "implied" posts. The fine-tune used the same data, so comparing the two is fair.
- **Nothing was tuned on the eval:** no threshold, not the LLM prompt (written once), and not the uncertainty band for the second-stage test (fixed in advance at 0.25–0.75).
- **One real leak.** I switched the VLM prompt after seeing that the first one made models answer a category instead of a title. Treat the VLM numbers from the second prompt as upper bounds.
- **Image cut-offs are not held out.** The "0 / 2% of ordinary photos blocked" cut-offs are set on the same photos they are reported on. That is fine for comparing models, but it is not calibration.
- **The gallery result is optimistic.** Gallery and query images come from the same Commons categories; only 1–2 of 8 independent images were right.

## 5. Disk and what can be deleted

`research/` is about 14 GB.

**Keep:**
- `models/ft/minilm-ft-proj/` (the int8 model to ship).
- From `models/hf/onnx-community/siglip2-base-patch16-224-ONNX/onnx/`: `vision_model_q4.onnx` and `text_model_fp16.onnx`, plus the repo's tokenizer and config files.
- `results/`, `scripts/` and `data/plots`.

**Safe to delete:**
- `models/gguf/` (5.8 GB): all the LLMs and VLMs.
- In `models/hf/`:
  - `Xenova/clip-vit-large-patch14`
  - `Xenova/mobileclip_s2`
  - `onnx-community/embeddinggemma-300m-ONNX`
  - `Xenova/bge-small-en-v1.5`
  - `Snowflake/`
  - `onnx-community/Florence-2-base-ft` (keep it if you want the OCR run)
  - `clip32/vision_fp32.onnx` and `minilm/fp32.onnx`
  - In the SigLIP 2 folder: `vision_model.onnx`, `vision_model_int8.onnx`, `vision_model_quantized.onnx` and `text_model_quantized.onnx`
- `models/ft/minilm-ft-proj+gr8k` (trained on Goodreads).
- `models/hf-cache`.
- `llama.cpp/` (363 MB).
- `.venv` (1.5 GB; only needed to re-run a fine-tune).
- `data/goodreads` (46 MB, academic-use only).
- `ext-probe/*/models`: these are hard links, so they free nothing on their own.

## 6. Reproduction

Run everything from `research/`, one command at a time.

| Step | Command |
|---|---|
| Install | `npm i` (pins transformers.js 4.3.2 and onnxruntime 1.31.1). Python: a uv 3.12 `.venv` with CPU torch, transformers, onnx, onnxruntime, onnxscript and rapidocr. llama.cpp at commit `398f00d`, built with cmake. |
| Browser checks and latency | `node scripts/chrome-probe.mjs default\|webgpu caps\|bench [headless]` with the env vars `MODELS=… THREADS=n GPU=1`. `node scripts/zen-probe.mjs default\|webgpu caps\|bench`. `node scripts/coep-fetch.mjs`. |
| Image data | `node research/scripts/rows.mjs` (run from the repo root), then `node scripts/fetch-commons.mjs`, `fetch-ordinary.mjs`, `images-list.mjs`. |
| Image models | `[TD=fp16 VD=q4 TAG=-q4] node scripts/img-embed.mjs <model-id>`, then `node scripts/img-score.mjs <tag>`. |
| Text | `node scripts/text-baseline.mjs`, `node scripts/dump-train.mjs`, `python -I scripts/finetune.py sentence-transformers/all-MiniLM-L6-v2 <name> proj\|proj+gr 3`, `node scripts/ft-report.mjs <name>`, `node scripts/ft-int8.mjs <name>`. |
| LLM | `node scripts/llm-eval.mjs models/gguf/<m>.gguf 4 eval300`, then `node scripts/cascade.mjs results/llm/*.json`. |
| VLM | `[P2=1] node scripts/vlm-eval.mjs <model.gguf> <mmproj.gguf> 4 80`. |
| Plot | `node scripts/fetch-plots.mjs`, `node scripts/fetch-plots-tv.mjs`, `node scripts/plot-eval.mjs Xenova/all-MiniLM-L6-v2`. |

Not done: OCR comparison, vision-only memory per model, anything on Android. Risks: under heavy load latencies are ±30%. The 0.942 baseline is likely optimistic. The Chrome threads change has not been checked with the tesseract workers under COEP.