# Development

Version 0.2.6. Run every command from the repository root unless stated.

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
- `test/catalog.test.js`: groups and derived series on the real catalog, and (0.2.3) the 0.2.3 phone cases, what each bare franchise name refers to (`test/fixtures/franchises.json`: 28 names, reviewed by hand), "More from this series" lists (`test/fixtures/series.json`: Resident Evil 42, Silent Hill 13 and God of War 9 works), the plain-sentence guard over the 300 most popular multi-word titles (`test/fixtures/top-names.json`: 1,200 sentences, at most 46 misses, 29 names expected to miss) and the YouTube rows (`test/fixtures/yt-rows.jsonl`: 91 rows of text the Android scanner passed, with the labels expected). Skipped until `data/catalog.json` exists.
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
- The cases check the [contract](agents/contract.md): the labels and their order, the buttons, `unknownImages`, `blockUnlisted`, both styles and per-work style, rule 7 (own text against picture titles and OCR text), "I've seen it" writing `works` and the picker for a group of several works, the dark-page colour fallback, the settings button, and the layout rule (no overlap, no height change, covers belong to their post). The 0.2.2 and 0.2.3 cases were added to `test/e2e/run.mjs` but not run for this page (the 0.2.3 ones: the picker's "More from this series" section, with a test-only series written into the fixture build's `index.json` because the small fixture catalog has no series, the several-groups picker, and "Show once" per post in the recycled feed); the "27 cases" count of 0.2.0 is out of date. A fourth group measures the scan cost on a long page and prints memory figures.
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

### Debugging on Android

To see what the Android scanner gives the matcher, raise the log tag on the device: `adb shell setprop log.tag.SpoilerBlock VERBOSE`, then `adb logcat -s SpoilerBlock:V`. Each evaluated item logs its class, the groups found and the full text (see [android.md](android.md#how-text-and-pixels-are-captured)). The log holds on-screen text, so treat it as personal data. Emulator only, as for all Android work here.

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

- Queries Wikidata for seven work types (at least 15 sitelinks; anime, manga and comics from 10 and books from 12, fetched after the main pass so its cached queries stay valid) and media franchises that stand in for an anime or manga, then what each work is (to keep only works told as a story), years, aliases, names in six other languages and characters; adds the main title of subtitled titles and, for works with at least 60 sitelinks, one name in another language as aliases (see [Catalog](how-it-works.md#catalog)); then the "names that mean something else" lookup, then (step 6, `tools/catalog/series.mjs`) series membership, and writes `data/catalog.json`. Step 6 fetches each work's P179 and P8345 statements, the class, parents and label of those series items (up to four levels up), rolls them up to franchises (never into a series of more than 80 works), and gives the works with no series one by title. It adds the top-level `series` table and each work's `series` ids. `tools/catalog/check.mjs` also checks that every `series` id is in the table, that Resident Evil, Silent Hill and God of War have at least 40, 13 and 9 works, and that Saga (comic), Maus, One-Punch Man and the alias "Der Pate" are there. The queries are cached like the others. Set `CATALOG_OUT` to write elsewhere.
- It is slow and polite: it waits between queries and backs off on 429 and 5xx. Results are cached by query text in `tools/catalog/cache/` (not in git), so a rerun is fast. The query text is the cache key: changing a query string in `src/shared/catalog-rules.js` invalidates that cache. The name lookup sends its names to 400 fixed buckets, so a changed name only invalidates its own bucket.
- Then run `npm test` and `npm run build`.

### The common-word list

`tools/catalog/common-words.txt` is the list behind the `ambiguous` flag and the index rules. It is committed. `node tools/catalog/words.mjs` rebuilds it: the English list `tools/catalog/20k.txt` first (most frequent first; the index rules use its first 1,000, 3,000 and 10,000 lines, so keep that order), then the 5,000 most frequent subtitle words of each of English, Turkish, Spanish, Portuguese, German, French and Italian from `hermitdave/FrequencyWords` (OpenSubtitles 2018, CC BY-SA 4.0). It downloads each list once into `tools/catalog/cache/` and needs network access the first time. After a change, rebuild the catalog (`ambiguous` is stored in it), run `npm test` and `npm run build`, and re-run `fp-posts`, `fp-ocr` and the headlines set.

### The index

The matcher index is a build product. `npm run build` regenerates it from the catalog with `src/shared/build-index.js`. The extension's catalog update runs the same code, so both give identical bytes for the same catalog. The index is format 3 and `index.json` carries a `series` column (about 1.96 MB; `index.bin` is 1,572,876 bytes). The table of `index.bin` has 131,072 slots and takes at most 81,920 entries (keys plus type-narrowed names) before it doubles to 3.1 MB; the 0.2.4 catalog fills 80,941. A catalog change that adds names must stay under that, or say why the bigger file is worth it. `tools/fp-text.mjs` and `tools/fp-posts.mjs` measure the effect of rule changes. `SB_NO_COMMON_RULE=1` switches the "common word" rules off for a "before" figure. The rules were tuned while looking at `fp-posts.jsonl`, `headlines.jsonl` and `ocr-noise.jsonl`, so improving those numbers further is not evidence of a better matcher.

### The title rows and the cut-offs

Also part of `npm run build`. The prompts are in `tools/clip-prompts.mjs`: three prompts per work type plus up to two character prompts, 33 generic "ordinary photo" prompts and 20 "media" prompts. Embeddings are cached by a hash of the prompt list and the model id.

The cut-offs `minScore`, `margin`, `titleGap` and `mediaGate` are the `CUT` constant in `tools/build.mjs`. The row count is `--clip-n` (`npm run build -- --clip-n=N`). Change a cut-off only after running `tools/calibrate-clip.mjs` with the real catalog and the research image sets (`SB_RESEARCH=research`), and read the held-out line, not the fixture line: the shipped values are fitted on all images.

### Footage head

`data/footage-head.json` is the footage head of contract rule 6: `{ version, dim: 768, cut, b, w: [768 numbers], note }`, one linear layer `score = w · e + b` on the L2-normalised `pooler_output` of the vision tower; an image or video frame is footage of a made work when `score >= cut`. `npm run build` and `npm run build:fixture` check its shape (the build fails otherwise) and copy it into `clip-meta.json` as `foot: { w, b, cut }`. `node research/scripts/refframes/head.mjs` retrains it and rewrites the file from the cached frame embeddings under `research/data/refframes/` (not in git); it sets `cut` to the score that 0.5% of the left-out real-life frames reach. Rebuild the extension to pick up a new file.

### Retraining the spoiler classifier

```sh
PYTHON=<python with the packages below> node tools/train-spoiler.mjs [outDir=models/spoiler]
```

Then `node tools/eval-spoiler.mjs` on both evaluation files, and `npm run build`.

- `tools/train-spoiler.mjs` assembles training items and calls `tools/spoiler-train/finetune.py`.
- Data: `test/fixtures/spoiler-train.json` (hand-written); patterns from `tools/spoiler-train/patterns.mjs` filled with titles and characters from the first 600 catalog works that have characters; `tools/spoiler-train/extra.mjs` (more hand-written implied spoilers, media talk and look-alike non-spoilers); `tools/spoiler-train/gaps.mjs` (implied spoilers without the obvious words, five other languages, more look-alikes); English Wikipedia articles of the 300 most popular films, series, games and anime (CC BY-SA 4.0), downloaded into `build/spoiler-data/wiki/`; and the hand-labelled split of the `bobotran/spoiler-matching` dataset (CC BY-SA 3.0), downloaded into `build/spoiler-data/`. Nothing comes from `test/fixtures/spoiler-eval.jsonl`, `test/fixtures/spoiler-eval2.jsonl` or `test/rdr2-probe.mjs`.
- Patterns are split into train and validation by pattern, so a validation pattern's fills are never seen in training. Wikipedia items are split by work. `test/fixtures/spoiler-val.jsonl` (673 hand-written posts in the four kinds of the eval files, never trained on) is added to validation. The threshold is chosen on validation only, by balanced accuracy averaged over the hand-written, pattern and `spoiler-val.jsonl` groups. Compare runs with `node tools/eval-spoiler.mjs <outDir> test/fixtures/spoiler-val.jsonl`; those figures are tuned-on. Run the two eval files only on the model you have already chosen.
- Switches: `SB_NO_REDDIT=1` leaves the Reddit data out, `SB_NO_WIKI=1` leaves the Wikipedia data out, and `SB_BASE=<model id>` fine-tunes another encoder (all-MiniLM-L12-v2 was tried and was no better on validation). They are ablation switches. `SB_EPOCHS=<n>` sets the number of epochs (default 4, as for the shipped model; 0.2.3 used 3).
- `finetune.py` fine-tunes the base model end to end for 4 epochs (`SB_EPOCHS`; mean pooling, one linear output), quantises it to int8 with onnxruntime, and writes `model_int8.onnx`, the tokenizer files and `meta.json` (`{ "threshold": ... }`). It downloads the base model from Hugging Face. It sets 6 torch threads.
- Python packages used by the script: `numpy`, `torch`, `transformers`, `onnx` (for `torch.onnx.export`) and `onnxruntime` (for `onnxruntime.quantization`). The script header says the shipped model was trained with torch 2.15 (CPU), transformers 5.23, onnx 1.23 and onnxruntime 1.32, in about 9 minutes on 6 CPU cores for 0.2.3; the current model (4 epochs, more data) took about 18 minutes.
- It overwrites `models/spoiler` by default. Pass another `outDir` to compare first.
- The evaluation files are for reading results only. Never train on them or choose a threshold with them.

### Title in context model

A second small model that decides the names the rules are unsure about; it is wired into the extension (`contextGroups` in `content.js`, `text.context` in the engine) and into Android (`ContextClassifier.java`, called from `SpoilerBlock.java`). It answers one question for one matcher hit: does this name, in this post, mean this work (or its franchise)?

```sh
PYTHON=<python with the packages above> node tools/train-context.mjs [outDir=models/context]
node tools/eval-context.mjs [modelDir=models/context] [files...] [-v] [--all-hits]
```

- Same family, tokenizer and runtime as the spoiler classifier: all-MiniLM-L6-v2 fine-tuned end to end as a sentence-pair classifier (mean pooling, one linear output), int8 ONNX. `models/context/` holds `model_int8.onnx` (inputs `input_ids`, `attention_mask`, `token_type_ids`; output `logit`), the tokenizer files and `meta.json` (`threshold`, `window`, `maxLength`, `truncation`).
- Input, defined in `tools/context-train/window.mjs` (the trainer, the evaluation and the Node runner all import it). The hit is the character span `[s, e)` of the post's own text (`tk.starts[h.i]`, `tk.ends[h.i + h.n - 1]`; never the OCR part after U+0001).
  - Segment A, the window: `a = max(0, s - 100)`; when `a > 0`, `a` moves to just after the first whitespace character at or after `a`, but never past `s`. `b = min(length, e + 100)`; when `b < length`, `b` moves back to the last whitespace character before `b` (excluded), but never before `e`. A is `text.slice(a, s) + '<' + text.slice(s, e) + '>' + text.slice(e, b)` with every whitespace run turned into one space, trimmed; the marks say which occurrence is asked about. Whitespace is JavaScript's `\s`. Example: `heat still has the best shootout ever put on screen`, hit `heat` gives A `<heat> still has the best shootout ever put on screen` and B `Heat [movie]` (19 tokens).
  - Segment B, the work: `<group label> [<types>]`, the distinct types of the group's works in the order movie, tv, game, book, anime, manga, comic, joined by `", "`: `Lost [tv]`, `Dune [movie, book]`.
  - Tokens: `[CLS] A [SEP] B [SEP]`, token type 0 up to and including the first `[SEP]`, 1 after it. When longer than `maxLength` (128), A's tokens are cut from the end (Python's `truncation='only_first'`). transformers.js's own pair truncation cuts the end of the whole sequence instead, so `tools/context-train/classify.mjs` assembles the ids itself. One pair per run, no padding, as for the spoiler classifier.
  - The probability is `sigmoid(logit)`. The product's decision for a name `Matcher.unsure()` returns: yes when it is at least `meta.threshold`, or at least `meta.thresholdOther` when the raw hit has the index's `other` bit (bit 3 of the hit value: mostly a person, a place or a brand). A `thresholdOther` above 1 means the model alone never accepts such a name. `meta.thresholdHeldOut` is the threshold with a 0.02 false-yes rate on held-out names, for reference.
- Data (`tools/train-context.mjs`): every pair is a raw matcher hit (`Matcher.scanTokens`) in a text, labelled automatically. Positives: catalog titles and characters filled into hand-written fan posts, short fan posts with no media word, video titles with a channel line (`tools/context-train/sentences.mjs`, most with no media word, plus Turkish, Spanish, Portuguese, German and French) and every `{T}`/`{C}` pattern of `tools/spoiler-train/`; sentences of the cached English Wikipedia articles (`build/spoiler-data/wiki/`), the plot summaries in `research/data/plots/` when present, and the Reddit comments of `bobotran/spoiler-matching` (`build/spoiler-data/`, `research/data/spoiler-matching/`) that name the work they discuss. Negatives: the same titles filled into hand-written posts where they are a song, a person, a shop, a pet or a place; hand-written everyday posts, plus (second round) sentence-initial everyday words in tech, science, money, work and daily-life talk, everyday two-word compounds, one- or two-word everyday posts, lowercase everyday words of Turkish, Spanish, Portuguese, German and French, and everyday headline-style video titles (these hand-written look-alikes are never capped, keep every casing variant and count twice in training); titles filled in as brands, apps, companies with stock words, songs and albums, local places, and people, places and events in history and sport talk; the everyday prose corpus of `tools/fp-text.mjs` (`build/corpus/`); everyday words written in lowercase in the Wikipedia, plot and Reddit texts; template words that happen to be titles; and shorter names inside a filled title that belong to an unrelated work ("Us" in "The Last of Us"). Nothing is downloaded: missing caches are skipped and the script says so.
- Augmentation: lowercase, ALL CAPS, Headline Case, media words removed, possessive. At most `SB_CAP` (10) pairs per name and label before augmentation, sources mixed.
- Validation holds out whole names (the group label's hash, 15%), so its figures are for names never trained on. The threshold is the lowest whose false-yes rate on those pairs is at most 0.02, measured with onnxruntime-web in Node after the export; the script prints the curve and writes that value as `threshold`. The shipped `threshold`, `thresholdOther` and `thresholdHeldOut` in `models/context/meta.json` were then set by hand from that curve and the product-decision sweep of `tools/eval-context.mjs`, so a retrain overwrites them. `test/fixtures/fp-posts.jsonl`, `headlines.jsonl` and `test/fixtures/context-val.jsonl` (hand-written posts, one name each) are read only by `tools/eval-context.mjs`, never for training or the threshold.
- `tools/eval-context.mjs` measures the product's decision by default: rules accept (`Matcher.evaluate`) OR (unsure name AND model yes). Per file it prints the rules alone, the decision per bucket at `meta`'s thresholds, a sweep of one threshold for all names and a sweep of the `other` threshold, and every everyday row the model covers, with the name and its probability (`-v` adds the media rows still missed). `--all-hits` asks about every raw hit instead (the first evaluation). `context-val.jsonl` rows are always asked hit by hit.
- Switches: `SB_CAP`, `SB_FILL` (popular works filled into templates, 2500), `SB_EPOCHS` (3), `SB_ITEMS` (where the pairs are written, `build/context-train-items.jsonl` by default), `SB_DATA_ONLY=1`, `SB_RETHRESHOLD=1` (keep the model, choose the threshold again), `SB_SCORES=<file>` (dump the validation scores).
- Run it under the heavy lock. About 45 minutes for 3 epochs on 6 cores (about 62,000 training pairs), then about 5 minutes to score the validation pairs in Node.
- Shipped model (run 6 of 6, about 74,000 training pairs, 50 minutes): held-out names (807 names, 11,731 pairs) recall / false-yes 0.975 / 0.020 at 0.83, 0.957 / 0.008 at 0.99, 0.937 / 0.005 at 0.998; non-English false-yes stays near 0.04 to 0.06 (few, mostly synthetic negatives). The curve figures above were recorded at training time and were not re-measured for this page. Shipped thresholds, in `models/context/meta.json`: `threshold` 0.95 and `thresholdOther` 0.999 (`thresholdHeldOut` 0.83 is the value with false-yes 0.02 on the held-out names). The main loop chose 0.95 and 0.999 from the sweep that `eval-context.mjs` prints, weighing recall; they are not the lowest false-yes values. Product decision, measured with `node tools/eval-context.mjs` on 2026-11-20 (both files tuned-on): `fp-posts.jsonl` rules alone 282/312 found (90.4%) with 2/651 everyday posts covered; rules OR model 296/312 (94.9%) with 4/651 (0.6%). `headlines.jsonl` rules alone 180/250 (72.0%) with 5/250 (2.0%); rules OR model 227/250 (90.8%) with 10/250 (4.0%). `test/fixtures/posts-dev.jsonl` (`node tools/eval-context.mjs test/fixtures/posts-dev.jsonl`; a development set whose per-class errors informed one training round, so tuned-on): rules alone 107/200 media posts found (53.5%) with 0/200 everyday posts covered; rules OR model 162/200 (81.0%) with 0/200. `test/fixtures/posts-heldout.jsonl` (400 fresh posts, never looked at or tuned on; measured once by the main loop, not by this page's author): the released 0.2.3 matcher found 96/200 media posts (48.0%) with 0/200 everyday posts covered; current rules alone 113/200 (56.5%), 0/200; rules or model 156/200 (78.0%), 1/200 (0.5%). By type with the model, from a count that normalises titles and so gives 160/200: movie 27/33, tv 27/33, game 29/33, book 20/27, anime 21/27, manga 21/24, comic 15/23. So the 95 % target is not met on fresh posts. `context-val.jsonl` at 0.95: English ordinary names yes 2/57 (false yes), English titles 39/50, non-English ordinary names yes 5/10 (false yes), non-English titles 10/13; the non-English sets are tiny.
- int8 model 22.9 MB. 12 to 26 ms per call with onnxruntime-web, one thread, in Node (longer windows cost more).

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
