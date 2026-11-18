# Development

Version 0.1.0. Run every command from the repository root unless stated.

## Prerequisites

| For | You need |
|---|---|
| Everything | Node.js and npm. `npm install` installs the dev dependencies (`@huggingface/transformers`, `onnxruntime-web`, `tesseract.js`, `@tesseract.js-data/eng`, `web-ext`, `puppeteer-core`). |
| First build | Network access to download the CLIP model into `build/.cache`. Network access to Wikidata too, unless `tools/catalog/cache/` already holds the class queries (see below). |
| End-to-end test, Firefox | Zen at `/usr/bin/zen-browser`. The path is written into `package.json` and `test/e2e/run.mjs`. |
| End-to-end test, Chrome | Chrome for Testing in `build/browsers`. Install it with `npx @puppeteer/browsers install chrome@stable --path build/browsers`. |
| Retraining the classifier | Python 3 with `numpy`, `torch`, `transformers`, `onnx` and `onnxruntime`. See below. |
| Android | A JDK 21+, the Android SDK, and the other items in [android.md](android.md). |

## npm scripts

| Script | Command | What it does |
|---|---|---|
| `npm test` | `node --test test/*.test.js` | Unit tests: `catalog.test.js`, `catalog-update.test.js`, `matcher.test.js`. |
| `npm run build` | `node tools/build.mjs` | Builds `dist/firefox` and `dist/chrome` from `data/catalog.json`. |
| `npm run build:fixture` | `node tools/build.mjs test/fixtures/catalog.small.json` | The same build from the small test catalog. Needed by the end-to-end test. It overwrites `dist/` and `build/data/`. Run `npm run build` afterwards to get the real catalog back. |
| `npm run e2e` | `node test/e2e/run.mjs` | End-to-end test. Takes `firefox` (default) or `chrome`: `npm run e2e -- chrome`. |
| `npm run lint` | `web-ext lint --source-dir dist/firefox` | Lints the Firefox build. |
| `npm start` | `web-ext run --source-dir dist/firefox --firefox=/usr/bin/zen-browser` | Opens Zen with the extension loaded. Edit the browser path for your machine. |

### What the build does

`tools/build.mjs [catalog.json] [--clip-n=2000]`:

1. Reads the catalog (default `data/catalog.json`). Stops with a message if it is missing.
2. Builds the matcher index (`index.bin`, `index.json`) with `src/shared/build-index.js`.
3. Embeds the title prompts with the CLIP text model (cached in `build/clip-text-<hash>.json`) and packs the first `--clip-n` rows (default 2000) with the image cut-offs into `clip-text.bin` and `clip-meta.json`.
4. Copies `catalog.json`, `common-words.txt` (from `tools/catalog/20k.txt`), `catalog-classes.json` and `catalog-info.json` for the catalog update. `catalog-classes.json` is computed from the subclass queries. They are read from `tools/catalog/cache/` when present and fetched from Wikidata otherwise.
5. Makes sure the CLIP vision model is in `build/.cache`.
6. Assembles `dist/firefox` and `dist/chrome`: `src/`, the data, vendor files (onnxruntime-web, transformers.js, tesseract.js, its core and `eng` data), the CLIP model, `models/spoiler`, and a `manifest.json`. The Chrome manifest differs as described in [how-it-works.md](how-it-works.md#background-firefox-and-chrome).

The classifier in `models/spoiler` is shipped as is. The build never retrains it.

## Tests

### Unit tests

```sh
npm test
```

- `test/matcher.test.js`: matcher rules on `test/fixtures/catalog.small.json`.
- `test/catalog-update.test.js`: the catalog update with a fake fetch, merging and rebuilding, and the alarm plan.
- `test/catalog.test.js`: groups and derived series on the real catalog. Skipped until `data/catalog.json` exists.

A sanity check of the catalog file itself (types, field shapes, ordering, a few known titles):

```sh
node tools/catalog/check.mjs
```

### End-to-end

```sh
npm run build:fixture
npm run e2e -- firefox
npm run e2e -- chrome
```

- It copies `dist/<target>` to `build/e2e-ext/<target>`, adds `data/update-config.json` pointing the catalog update at a local mock SPARQL server, and starts a temporary-profile browser. Firefox runs Zen headless through `web-ext` and WebDriver BiDi. Chrome runs Chrome for Testing with the extension enabled.
- All traffic that is not loopback goes through a proxy that refuses it, and the report lists every attempt. The test fails if the mock SPARQL server sees a request before the update is switched on or pressed. Other refused requests are only listed.
- It checks first paint, the two modes, the popup's search and "Add", the overlay's "I've seen" and "Show once", the catalog update (including 429 and malformed answers), pausing a site, OCR-only text, and prints memory figures.
- Output goes to `test/e2e/out/` (not in git): a report per target and screenshots.
- The two targets use different ports, so they can run together. On a memory-constrained machine run one at a time (see below).
- Debug aid: `node test/e2e/run.mjs firefox --eval 'async () => ...'` runs a function in an extension page.

### Evaluation scripts

| Command | What it measures |
|---|---|
| `node tools/eval-spoiler.mjs [modelDir=models/spoiler] [eval.jsonl]` | The classifier on `test/fixtures/spoiler-eval.jsonl` the way the extension runs it: precision, recall, rates per post kind, AUC. |
| `node tools/fp-text.mjs [catalog]` | False positives of the text matcher on everyday prose. Downloads a corpus once into `build/corpus/`. |
| `node tools/calibrate-clip.mjs [catalog]` | The image verdict against `test/fixtures/images/labels.json`: tables over row counts and cut-offs. Uses `sharp`, which comes with `@huggingface/transformers`. `SHOW=N,minScore,margin,gate` prints the detail of one setting. |
| `node test/rdr2-probe.mjs` | A probe, not a test: Red Dead Redemption 2 posts in both modes. Needs `dist/firefox`. |
| `node tools/catalog-update-live.mjs [--simulate-old-bundle]` | One real catalog update against live Wikidata with the extension's own code. Nothing is written. |
| `node tools/bench-clip.mjs <hf-model-id> [catalog]` | Compares a candidate CLIP model on the image fixtures. |
| `node tools/bench-ort-web.mjs <model.onnx> [size] [threads]` | Latency and memory of an ONNX model on onnxruntime-web. |

### Android unit tests

Generate the vectors, then run Gradle. The steps are in [android.md](android.md#parity-tests):

```sh
node android/tools/vectors.mjs
node android/tools/catalog-vectors.mjs
node android/tools/spoiler-vectors.mjs
node android/tools/clip-vectors.mjs
cd android && ./gradlew :extensions:blocker:testDebugUnitTest
```

## Rebuilding the data

### The catalog

```sh
node tools/catalog/build.mjs [minSitelinks=15]
node tools/catalog/check.mjs
```

- Queries Wikidata for seven work types, then years, aliases and characters, and writes `data/catalog.json`. Set `CATALOG_OUT` to write elsewhere.
- It is slow and polite: it waits between queries and backs off on 429 and 5xx. Results are cached by query text in `tools/catalog/cache/` (not in git), so a rerun is fast. Changing a query string in `src/shared/catalog-rules.js` invalidates that cache.
- Then run `npm test` and `npm run build`.

### The index

The matcher index is a build product. `npm run build` regenerates it from the catalog with `src/shared/build-index.js`. The extension's catalog update runs the same code, so both give identical bytes for the same catalog. `tools/fp-text.mjs` measures the effect of rule changes on false positives. `SB_NO_COMMON_RULE=1` switches the "common word" rules off for a "before" figure.

### The CLIP text matrix and calibration

Also part of `npm run build`. The prompts are in `tools/clip-prompts.mjs`: one set per work type, 33 generic "ordinary photo" prompts and 20 "media" prompts. Embeddings are cached by a hash of the prompt list, the model id and the generic prompts.

The cut-offs `CLIP_MIN_SCORE`, `CLIP_MARGIN`, `CLIP_MEDIA_GATE` and `CLIP_TITLE_GAP` are constants in `tools/build.mjs`. The row count is `--clip-n` (`npm run build -- --clip-n=N`). Change a cut-off only after running `tools/calibrate-clip.mjs` with the real catalog. Its figures are on the same fixtures the cut-offs were set on, so they are not held-out.

### Retraining the spoiler classifier

```sh
PYTHON=<python with the packages below> node tools/train-spoiler.mjs [outDir=models/spoiler]
```

Then `node tools/eval-spoiler.mjs` and `npm run build`.

- `tools/train-spoiler.mjs` assembles training items and calls `tools/spoiler-train/finetune.py`.
- Data: `test/fixtures/spoiler-train.json` (hand-written), patterns from `tools/spoiler-train/patterns.mjs` filled with titles and characters from the first 600 catalog works that have characters, and the hand-labelled split of the `bobotran/spoiler-matching` dataset (CC BY-SA 3.0), downloaded into `build/spoiler-data/`. Nothing comes from `test/fixtures/spoiler-eval.jsonl` or `test/rdr2-probe.mjs`.
- Patterns are split into train and validation by pattern, so a validation pattern's fills are never seen in training. The threshold is chosen on validation only.
- `SB_NO_REDDIT=1` leaves the Reddit data out (an ablation switch).
- `finetune.py` fine-tunes `sentence-transformers/all-MiniLM-L6-v2` end to end for 3 epochs (mean pooling, one linear output), quantises it to int8 with onnxruntime, and writes `model_int8.onnx`, the tokenizer files and `meta.json` (`{ "threshold": ... }`). It downloads the base model from Hugging Face. It sets 6 torch threads.
- Python packages used by the script: `numpy`, `torch`, `transformers`, `onnx` (for `torch.onnx.export`) and `onnxruntime` (for `onnxruntime.quantization`). The script header says the shipped model was trained with torch 2.15 (CPU), transformers 5.23, onnx 1.23 and onnxruntime 1.32, in about 9 minutes on 6 CPU cores.
- It overwrites `models/spoiler` by default. Pass another `outDir` to compare first.

## Memory guidance for a 16 GB machine

The work in this repository is heavy, and builds, models, browsers and an emulator compete for memory.

- Run one heavy job at a time: a Gradle build, the Morphe bootstrap, patching, an emulator, an end-to-end run, training, or the catalog build. Do not start a browser test while Gradle runs.
- The flags the scripts already set:

  | Where | Setting |
  |---|---|
  | `android/gradle.properties` | `org.gradle.jvmargs = -Xmx2g`, `org.gradle.workers.max = 2`, `kotlin.daemon.jvmargs = -Xmx1g`, parallel and caching on |
  | `android/apply.sh` | the patcher runs with `-Xmx3g` |
  | `android/extensions/blocker/build.gradle.kts` | Java unit tests run with `maxHeapSize = "1g"` |

- No script sets emulator memory flags.
- `android/tools/bootstrap-morphe.sh` builds two upstream Gradle projects with their own settings. Do it once and do not run anything else beside it.
- The end-to-end run starts a browser with the models loaded. The report records the process size.

## What is deliberately not in git

| Not in git | Why |
|---|---|
| `android/apks/` | Third-party APKs. They must be supplied by the user and never redistributed. |
| `android/out/` | Patched APKs. Same reason. |
| `android/keystore/` | Your local signing key and its password. |
| `android/tools/morphe-desktop-*.jar`, `android/tools/morphe-data/` | The Morphe CLI and its working data. `bootstrap-morphe.sh` fetches the jar. |
| `android/.gradle/`, `android/build/`, `*/build/`, `android/local.properties`, `android/.kotlin/` | Build outputs and local paths. |
| `android/evidence/` | Emulator screenshots and logs. They contain third-party content. |
| `dist/`, `build/`, `node_modules/` | Build outputs and dependencies. |
| `test/e2e/out/` | End-to-end reports and screenshots. |
| `tools/catalog/cache/`, `*.log` | Wikidata query cache and logs. |
| `research/*` except `REPORT.md`, `scripts/` and `package.json` | Downloaded data, models and results from the research work (about 14 GB according to the report). |
| `.impeccable/` | Local tool directory. |

Not ignored, so meant to be committed: `data/catalog.json`, `models/spoiler/`, the test fixtures, `src/`, `tools/` and the Android sources.
