# Development

Version 0.2.2. Run every command from the repository root unless stated.

## Prerequisites

| For | You need |
|---|---|
| Everything | Node.js and npm. `npm install` installs the dev dependencies (`@huggingface/transformers`, `onnxruntime-web`, `web-ext`, `puppeteer-core`, and `tesseract.js` with `@tesseract.js-data/eng`). Nothing in the build, the extension, the tests or the Android build uses the two Tesseract packages any more. Only the comparison scripts `research/scripts/v2-ocr-eval.mjs` and `ocr-tesseract.mjs` import them, and `package.json` still lists them. |
| First build | Network access. It downloads, into `build/.cache`, the SigLIP 2 vision model (fp32, about 378 MB), the SigLIP 2 text model (fp16, about 565 MB, build time only), the tokenizer (about 34 MB) and the two OCR models (about 5 and 8 MB). The vision and OCR files are checked against pinned sha256 values. Network access to Wikidata too, unless `tools/catalog/cache/` already holds the class queries (see below). |
| End-to-end test, Firefox | Zen at `/usr/bin/zen-browser`. The path is written into `package.json` and `test/e2e/run.mjs`. |
| End-to-end test, Chrome | Chrome for Testing in `build/browsers`. Install it with `npx @puppeteer/browsers install chrome@stable --path build/browsers`. |
| Retraining the classifier | Python 3 with `numpy`, `torch`, `transformers`, `onnx` and `onnxruntime`. See below. Network access for the Reddit and Wikipedia data. |
| Android | A JDK 21+, the Android SDK, and the other items in [android.md](android.md). |

## Machine locks

Several agents may work on this machine at once, and it has 16 GB. Two lock files serialise the heavy jobs. Run the command through `flock`; it waits until the lock is free.

| Lock | Hold it for |
|---|---|
| `flock ~/.cache/sb-heavy.lock <command>` | Training, Gradle, the emulator, the Morphe bootstrap and patching, benchmarks and evaluation scripts (`tools/eval-spoiler.mjs`, `tools/fp-posts.mjs`, `tools/fp-ocr.mjs`, `tools/fp-text.mjs`, `tools/calibrate-clip.mjs`, `tools/bench-ort-web.mjs`). |
| `flock ~/.cache/sb-browser.lock <command>` | Builds (`npm run build`, `npm run build:fixture`) and every browser run (`npm run e2e`, `npm start`, `tools/bench-engine.mjs`). |

Examples:

```sh
flock ~/.cache/sb-browser.lock npm run build:fixture
flock ~/.cache/sb-browser.lock npm run e2e -- chrome
flock ~/.cache/sb-heavy.lock node tools/eval-spoiler.mjs
```

`tools/bench-engine.mjs` runs a browser and measures time, so take the browser lock and make sure nobody holds the heavy lock: its timings are meaningless next to a Gradle build or training. If in doubt, take both (`flock ~/.cache/sb-heavy.lock flock ~/.cache/sb-browser.lock <command>`).

## npm scripts

| Script | Command | What it does |
|---|---|---|
| `npm test` | `node --test test/*.test.js` | Unit tests: `catalog.test.js`, `catalog-update.test.js`, `config.test.js`, `matcher.test.js`, `ocr.test.js`. |
| `npm run build` | `node tools/build.mjs` | Builds `dist/firefox` and `dist/chrome` from `data/catalog.json`. |
| `npm run build:fixture` | `node tools/build.mjs test/fixtures/catalog.small.json` | The same build from the small test catalog. Needed by the end-to-end test. It overwrites `dist/` and `build/data/`. Run `npm run build` afterwards to get the real catalog back. |
| `npm run e2e` | `node test/e2e/run.mjs` | End-to-end test. Takes `firefox` (default) or `chrome`: `npm run e2e -- chrome`. |
| `npm run lint` | `web-ext lint --source-dir dist/firefox` | Lints the Firefox build. |
| `npm start` | `web-ext run --source-dir dist/firefox --firefox=/usr/bin/zen-browser` | Opens Zen with the extension loaded. Edit the browser path for your machine. |

### What the build does

`tools/build.mjs [catalog.json] [--clip-n=2000]`:

1. Reads the catalog (default `data/catalog.json`). Stops with a message if it is missing.
2. Builds the matcher index (`index.bin`, `index.json`) with `src/shared/build-index.js`.
3. Embeds the title prompts with the SigLIP 2 text tower (cached in `build/clip-text-<hash>.json`) and packs the first `--clip-n` rows (default 2000) with the image cut-offs and the preprocessing constants into `clip-text.bin` and `clip-meta.json`.
4. Copies `catalog.json`, `common-words.txt` (from `tools/catalog/common-words.txt`), `catalog-classes.json` and `catalog-info.json` for the catalog update. `catalog-classes.json` is computed from the subclass queries (the seven work types, and a `sameSense` list for the `other` lookup). They are read from `tools/catalog/cache/` when present and fetched from Wikidata otherwise. `catalog-info.json` records the catalog file's modification time as `builtAt`.
5. Downloads the pinned fp32 SigLIP 2 vision model into `build/.cache`, converts its weights to int8 with `tools/quantize-vision.mjs` (no Python; the result is cached next to the download and redone when the script changes), and downloads the two OCR models.
6. Assembles `dist/firefox` and `dist/chrome`: `src/`, the data, vendor files (onnxruntime-web and a copy of transformers.js whose onnxruntime import is rewritten to the same module), the vision and OCR models, `models/ocr/dict.txt`, `models/spoiler`, and a `manifest.json`. The Chrome manifest differs as described in [how-it-works.md](how-it-works.md#background-firefox-and-chrome).

The classifier in `models/spoiler` is shipped as is. The build never retrains it.

## Tests

### Unit tests

```sh
npm test
```

- `test/matcher.test.js`: matcher rules on `test/fixtures/catalog.small.json`, including names that mean something else, type-fitting media words, same-sentence context, apostrophes and other languages.
- `test/catalog-update.test.js`: the catalog update with a fake fetch, merging and rebuilding, the alarm plan, the narrative filter, the `other` lookup and its query limit.
- `test/catalog.test.js`: groups and derived series on the real catalog. Skipped until `data/catalog.json` exists.
- `test/config.test.js`: the config (`src/options/config.js`): migration from 0.1, import and export, merge and replace, custom works in the index, and a catalog update keeping the custom works.
- `test/ocr.test.js`: the PP-OCR module with a fake onnxruntime (boxes, reading order, decoding, the confidence cut).

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
- Pages: `test/e2e/fixture.html` (the original flow: first paint, styles, popup search and "Add", the cover's buttons, the catalog update including 429 and malformed answers, pausing a site, OCR-only text), `feed.html` (a virtualised feed that recycles its nodes), `coverage.html` (direct messages, search suggestions, notifications, quote posts, a CSS background photo, short and dark blocks, open, closed and late shadow roots, an `about:srcdoc` frame, a cross-origin frame, the tab title) and `frame.html` (the embedded frame).
- The cases check the [contract](agents/contract.md): the labels and their order, the buttons, `unknownImages`, `blockUnlisted`, both styles and per-work style, rule 7 (own text against picture titles and OCR text), "I've seen it" writing `works` and the picker for a group of several works, the dark-page colour fallback, the settings button, and the layout rule (no overlap, no height change, covers belong to their post). The 0.2.2 cases were added to `test/e2e/run.mjs` but not run for this page; the "27 cases" count of 0.2.0 is out of date. A fourth group measures the scan cost on a long page and prints memory figures.
- The image cases do not name pictures in advance. The run asks the shipped engine (through the background, as the content script does) which `spoiler_*` and `pos_*` fixture pictures it titles with the fixture catalog, and which it calls generic media, keeping only pictures with no OCR text. It then uses those. `test/fixtures/catalog.small.json` holds Nosferatu (1922) so that `pos_nosferatu.jpg`, which has no text, is titled; if the engine titles no picture, the title cases are skipped and the report says so.
- Output goes to `test/e2e/out/` (not in git): a report per target and screenshots.
- The two targets use different ports, so they can run together. Do not do that on this machine (see the locks above).
- Switches: `ONLY=1` skips the original flow and runs only the contract cases. `ONLY=states,feed,coverage,perf` (any subset) runs those groups. `SB_CONTENT=<dir with content.js and content.css>` runs another content script, for example the 0.1 one, against the same pages.
- Debug aid: `node test/e2e/run.mjs firefox --eval 'async () => ...'` runs a function in an extension page.

### Evaluation scripts

| Command | What it measures |
|---|---|
| `node tools/eval-spoiler.mjs [modelDir=models/spoiler] [eval.jsonl]` | The classifier the way the extension runs it, on `test/fixtures/spoiler-eval.jsonl` (default) or `spoiler-eval2.jsonl`: precision, recall, rates per post kind, AUC. |
| `node tools/fp-posts.mjs [catalog] [-v] [--file=<jsonl>]` | The text matcher on `test/fixtures/fp-posts.jsonl` (the default): false positives on 636 everyday posts and recall on 297 posts about media. `-v` lists every miss and false positive. |
| `node tools/fp-posts.mjs --file=test/fixtures/headlines.jsonl` | The same on `test/fixtures/headlines.jsonl`: 500 YouTube-style titles in Headline Case and ALL CAPS (250 name a work, 250 do not). Each row has `text`, `media` and, for media rows, `expect`. |
| `node tools/fp-ocr.mjs [catalog] [-v] [--newline]` | The matcher on text read from pictures (`test/fixtures/ocr-noise.jsonl`, 400 rows: 320 whose picture text names no work, 80 whose picture shows a title). Each row is evaluated as `own` + U+0001 + `ocr`, as the callers pass it; `--newline` joins with a line break, as 0.2.0 did, for a "before" figure. |
| `node tools/fp-text.mjs [catalog]` | False positives of the text matcher on everyday prose. Downloads a corpus once into `build/corpus/`. |
| `[SB_RESEARCH=research] node tools/calibrate-clip.mjs [catalog] [--clip-n=N]` | The image verdict: fits the title cut-offs on a calibration split and reports them on the held-out split. Uses the images in `test/fixtures/images/labels.json`, plus, when `SB_RESEARCH` points at a `research/` directory, the research image sets. The held-out figures in the README need those sets. Uses `sharp` and `onnxruntime-node`, which come with `@huggingface/transformers`. |
| `node tools/bench-engine.mjs chrome\|firefox [regex]` | Per-image latency of the real engine inside the built extension (check and OCR, first call, median, 90th percentile, and a feed-like burst). Runs through `test/e2e/run.mjs --eval`, so it needs `dist/<target>`. |
| `node tools/bench-engine.mjs chrome\|firefox [regex] --stats > <browser>.json` | No timing. For each fixture image, the inputs of the title verdict (best row, score, margin, gap, media) from two separate batch-1 runs and one batch-4 run, as JSON. |
| `node tools/bench-stats-diff.mjs chrome.json firefox.json [clip-meta.json]` | Compares two `--stats` outputs: spread between runs, between batch 1 and batch 4, and between browsers, and the images closest to a cut-off (cut-offs from `build/data/clip-meta.json` unless given). This is how the cross-browser spread was measured. |
| `node tools/bench-ort-web.mjs <model.onnx> [size] [threads]` | Latency and memory of an ONNX model on onnxruntime-web. |
| `node test/rdr2-probe.mjs` | A probe, not a test: Red Dead Redemption 2 posts in both styles. Needs `dist/firefox`. |
| `node tools/catalog-update-live.mjs [--simulate-old-bundle]` | One real catalog update against live Wikidata with the extension's own code. Nothing is written. |

`tools/bench-clip.mjs` no longer exists. `tools/build-clip-text.mjs` (the title rows and the pinned model) and `tools/quantize-vision.mjs` are modules used by the build and `calibrate-clip.mjs`, not commands.

### Android unit tests

Generate the vectors, then run Gradle. The steps are in [android.md](android.md#parity-tests):

```sh
node android/tools/vectors.mjs
node android/tools/catalog-vectors.mjs
node android/tools/spoiler-vectors.mjs
node android/tools/clip-vectors.mjs
cd android && ./gradlew :extensions:blocker:testDebugUnitTest
```

`clip-vectors.mjs` feeds `ClipTest` and `OcrTest` (it runs the extension's own `pixels.js`, `engine.js` and `ocr.js` on the fixture images). The Gradle run also starts the separate task `ocrTestDebugUnitTest`; see [android.md](android.md#parity-tests).

## Rebuilding the data

### The catalog

```sh
node tools/catalog/build.mjs [minSitelinks=15]
node tools/catalog/check.mjs
```

- Queries Wikidata for seven work types, then what each work is (to keep only works told as a story), years, aliases and characters, then the "names that mean something else" lookup, and writes `data/catalog.json`. Set `CATALOG_OUT` to write elsewhere.
- It is slow and polite: it waits between queries and backs off on 429 and 5xx. Results are cached by query text in `tools/catalog/cache/` (not in git), so a rerun is fast. The query text is the cache key: changing a query string in `src/shared/catalog-rules.js` invalidates that cache. The name lookup sends its names to 400 fixed buckets, so a changed name only invalidates its own bucket.
- Then run `npm test` and `npm run build`.

### The common-word list

`tools/catalog/common-words.txt` is the list behind the `ambiguous` flag and the index rules. It is committed. `node tools/catalog/words.mjs` rebuilds it: the English list `tools/catalog/20k.txt` first (most frequent first; the index rules use its first 1,000, 3,000 and 10,000 lines, so keep that order), then the 5,000 most frequent subtitle words of each of English, Turkish, Spanish, Portuguese, German, French and Italian from `hermitdave/FrequencyWords` (OpenSubtitles 2018, CC BY-SA 4.0). It downloads each list once into `tools/catalog/cache/` and needs network access the first time. After a change, rebuild the catalog (`ambiguous` is stored in it), run `npm test` and `npm run build`, and re-run `fp-posts`, `fp-ocr` and the headlines set.

### The index

The matcher index is a build product. `npm run build` regenerates it from the catalog with `src/shared/build-index.js`. The extension's catalog update runs the same code, so both give identical bytes for the same catalog. `tools/fp-text.mjs` and `tools/fp-posts.mjs` measure the effect of rule changes. `SB_NO_COMMON_RULE=1` switches the "common word" rules off for a "before" figure. The rules were tuned while looking at `fp-posts.jsonl`, `headlines.jsonl` and `ocr-noise.jsonl`, so improving those numbers further is not evidence of a better matcher.

### The title rows and the cut-offs

Also part of `npm run build`. The prompts are in `tools/clip-prompts.mjs`: three prompts per work type plus up to two character prompts, 33 generic "ordinary photo" prompts and 20 "media" prompts. Embeddings are cached by a hash of the prompt list and the model id.

The cut-offs `minScore`, `margin`, `titleGap` and `mediaGate` are the `CUT` constant in `tools/build.mjs`. The row count is `--clip-n` (`npm run build -- --clip-n=N`). Change a cut-off only after running `tools/calibrate-clip.mjs` with the real catalog and the research image sets (`SB_RESEARCH=research`), and read the held-out line, not the fixture line: the shipped values are fitted on all images.

### Retraining the spoiler classifier

```sh
PYTHON=<python with the packages below> node tools/train-spoiler.mjs [outDir=models/spoiler]
```

Then `node tools/eval-spoiler.mjs` on both evaluation files, and `npm run build`.

- `tools/train-spoiler.mjs` assembles training items and calls `tools/spoiler-train/finetune.py`.
- Data: `test/fixtures/spoiler-train.json` (hand-written); patterns from `tools/spoiler-train/patterns.mjs` filled with titles and characters from the first 600 catalog works that have characters; `tools/spoiler-train/extra.mjs` (more hand-written implied spoilers, media talk and look-alike non-spoilers); English Wikipedia articles of the 300 most popular films, series, games and anime (CC BY-SA 4.0), downloaded into `build/spoiler-data/wiki/`; and the hand-labelled split of the `bobotran/spoiler-matching` dataset (CC BY-SA 3.0), downloaded into `build/spoiler-data/`. Nothing comes from `test/fixtures/spoiler-eval.jsonl`, `test/fixtures/spoiler-eval2.jsonl` or `test/rdr2-probe.mjs`.
- Patterns are split into train and validation by pattern, so a validation pattern's fills are never seen in training. Wikipedia items are split by work. The threshold is chosen on validation only, by balanced accuracy on the deduplicated validation items.
- Switches: `SB_NO_REDDIT=1` leaves the Reddit data out, `SB_NO_WIKI=1` leaves the Wikipedia data out, and `SB_BASE=<model id>` fine-tunes another encoder (all-MiniLM-L12-v2 was tried and was no better on validation). They are ablation switches.
- `finetune.py` fine-tunes the base model end to end for 3 epochs (mean pooling, one linear output), quantises it to int8 with onnxruntime, and writes `model_int8.onnx`, the tokenizer files and `meta.json` (`{ "threshold": ... }`). It downloads the base model from Hugging Face. It sets 6 torch threads.
- Python packages used by the script: `numpy`, `torch`, `transformers`, `onnx` (for `torch.onnx.export`) and `onnxruntime` (for `onnxruntime.quantization`). The script header says the shipped model was trained with torch 2.15 (CPU), transformers 5.23, onnx 1.23 and onnxruntime 1.32, in about 9 minutes on 6 CPU cores.
- It overwrites `models/spoiler` by default. Pass another `outDir` to compare first.
- The evaluation files are for reading results only. Never train on them or choose a threshold with them.

## Memory guidance for a 16 GB machine

The work in this repository is heavy, and builds, models, browsers and an emulator compete for memory.

- Run one heavy job at a time: a Gradle build, the Morphe bootstrap, patching, an emulator, an end-to-end run, training, or the catalog build. Do not start a browser test while Gradle runs. The two locks above enforce this between agents.
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
| `.impeccable/`, `.claude/` | Local tool directories (`.claude/` holds agent worktrees). |

Not ignored, so meant to be committed: `data/catalog.json`, `models/spoiler/`, `models/ocr/dict.txt`, the test fixtures, `src/`, `tools/` and the Android sources.
