# SpolierBlock

Version 0.2.0.

SpolierBlock hides spoilers about films, shows, games, books, manga, anime and comics. It runs entirely on the device.

Every work has one of three states: seen, blocked, or not listed. A work that is not listed is covered by default (a setting turns that off). A cover says why it is there ("Mentions {title}", "Spoiler about {title}", "Image from {title}") and has three buttons: "Show once", "I've seen it" and ⋮ (settings). Marking a work as seen is stored locally, and from then on posts about it are left alone. The exact rules and wording are in [docs/agents/contract.md](docs/agents/contract.md).

The product is spelled "SpolierBlock" (repository `RamazanBerk20/SpolierBlock`, export file `spolierblock-config.json`). Android identifiers use the usual spelling: package `dev.spoilerblock`, class `SpoilerBlock`, patch `SpoilerBlock`.

There are three parts:

| Part | What it is | Where |
|---|---|---|
| Browser extension | Manifest V3 extension for Firefox-family browsers (tested on Zen) and Chromium. One codebase. | `src/`, `manifest.json`, `tools/build.mjs` |
| Android patch bundle | A Morphe patch bundle that adds the blocker to YouTube 21.30.216, X 12.19.1-release.0 and Instagram 452.1.0.53.64. | `android/patches/`, `android/extensions/blocker/` |
| Android companion app | A small app (`dev.spoilerblock`) that owns the settings shared by all patched apps. Optional. | `android/companion/` |

The extension is a development build that you load by hand. The patch bundle needs APKs that you supply yourself. See [Status and known limits](#status-and-known-limits) before relying on any of them.

## What it does

- **Text matching.** A hash-index matcher over a catalog of 24,670 works built from Wikidata. It knows titles, aliases, character names and series names. Names shared by several works form one group. Ambiguous names (such as "Lost" or "It") need corroboration before they match, and a name whose usual meaning is not a work ("Palestine", "Napoleon") matches only next to a media word that fits the work's type. Sequel numbers match in both forms ("GTA 6", "GTA VI"). The catalog holds narrative works only: scripture, reference works, most non-fiction, documentaries and news or talk shows are left out.
- **Three states and two styles.** Each work you touch is "seen" or "blocked". Each work, or all works by default, uses a style: `all` (cover anything about the work) or `spoilers` (cover only what a classifier calls a spoiler). The classifier is all-MiniLM-L6-v2, fine-tuned and quantised to int8 (`models/spoiler`). It scores each sentence and takes the highest score. If it fails, the post stays covered.
- **Settings.** The extension has a settings page in its own tab (Library, Add by hand, Blocking, Data, About) and a small popup. You can add works the catalog does not know by hand, and export or import everything as one file that works on both platforms.
- **Images and video thumbnails.** A SigLIP 2 vision model (weights quantised to int8) compares an image with precomputed title rows. The result is either a confident title or "looks like film, show or game media, no title". The engine resizes the picture itself (`src/background/pixels.js`), so every browser feeds the model the same numbers. OCR (PaddleOCR v5) reads text in the image and passes it to the same text matcher. Media stays dimmed until both verdicts are in. Naming a work from a picture that has no text is weak. OCR is the dependable image signal. An unidentified media image is covered only when "Cover unrecognised film and game images" is on; it is off by default.
- **Opt-in catalog update.** Off by default. You can choose daily, weekly or monthly, or press "Update now". It downloads new titles directly from Wikidata's public query service. This is the only network use. Nothing about you is sent.
- **Threads.** The Chrome build is cross-origin isolated, so the models run on up to 4 WASM threads. The Firefox build runs on one thread.
- **Android.** The same catalog and matcher rules, ported to Java and tested against the JavaScript version. The same classifier through ONNX Runtime. A full-screen settings screen opens from the ⋮ button on a cover, from an app shortcut, or from the host app's own settings. Push notification text is checked too. Images use the same models as the browser (SigLIP 2 and PaddleOCR on ONNX Runtime 1.22), with the same resize and cut-offs. A picture still being judged is shaded on its own and the post's text stays readable. Optional NNAPI acceleration of the title model is there, but it has never run on a real phone. See [docs/android.md](docs/android.md).

## Status and known limits

Measured results, from the maintainer's runs on this repository's fixtures. Where a figure was not re-run for this page, it says so.

**Text matcher**, `node tools/fp-posts.mjs` on `test/fixtures/fp-posts.jsonl` (630 everyday posts, 290 posts about media; re-run for this page):

| | 0.1 | 0.2 |
|---|---|---|
| Everyday posts wrongly covered | 51 of 630 | 9 of 630 |
| Media posts matched | 156 of 290 | 224 of 290 |
| of which non-English posts | 33 of 70 | 63 of 70 |
| Wrongly covered sentences of everyday prose (`tools/fp-text.mjs`) | 15.8 per 1,000 | 3.8 per 1,000 |

The 0.1 column and the `fp-text` row are the maintainers' figures and were not re-run here. The rules were tuned while looking at this benchmark, so it is not held out.

**Spoiler classifier**, wrongly blocked or caught, out of the number of posts (`node tools/eval-spoiler.mjs`; the 0.2 column was re-run for this page):

| Kind of post | `spoiler-eval.jsonl`, 0.1 | `spoiler-eval.jsonl`, 0.2 | `spoiler-eval2.jsonl`, 0.1 | `spoiler-eval2.jsonl`, 0.2 |
|---|---|---|---|---|
| Explicit spoilers caught | 60 of 60 | 59 of 60 | 60 of 60 | 57 of 60 |
| Implied spoilers caught | 84 of 90 | 77 of 90 | 74 of 80 | 76 of 80 |
| Neutral posts wrongly blocked | 15 of 90 | 6 of 90 | 28 of 100 | 12 of 100 |
| Tricky non-spoilers wrongly blocked | 17 of 60 | 6 of 60 | 42 of 80 | 17 of 80 |
| ROC AUC | 0.960 | 0.969 | 0.901 | 0.956 |

Neither file was used for training or for choosing the threshold. `spoiler-eval2.jsonl` was written without looking at the training data, but by the same model family that wrote part of the new training examples, so its look-alike cases resemble them. The threshold is now 0.75 (it was 0.45), chosen by balanced accuracy on validation data.

**Image titles and OCR** (the maintainer's figures from the image work; not re-run for this page; other jobs were running, so timings are good to about 30 percent). The title figure was re-measured after the catalog merge and the new resize; the other rows are from before them:

| Measure | Result |
|---|---|
| Title check on a held-out split (397 media, 466 ordinary photos) | 22 right, 8 wrong, 2 ordinary photos named, with the merged catalog (before the catalog merge: 28 right, 4 wrong, 0 named). The calibration is noisy: the two halves of the split pick very different cut-offs, so a few images move the result. The 0.1 model with its own cut-offs on an earlier split: 14 right, 6 wrong, 1 named, plus 17 with the generic label. |
| Title check on `test/fixtures/images` | 5 of 31 media images titled right, 0 wrong, 0 of 44 ordinary photos named (measured before the recalibration, not re-run). The cut-offs were fitted on a set that includes these images, so this is not held out. |
| OCR captions read, synthetic but realistic set (thumbnails, subtitles, HUDs, memes, post screenshots) | 171 of 185, against 34 of 185 with Tesseract. The OCR settings were tuned on the same set. |
| Cross-browser score spread, Chrome against Firefox, fixture images (`tools/bench-stats-diff.mjs`) | Up to 0.010 with canvas scaling, at most 0.0013 now that the engine resizes in JavaScript. |
| Time per screenful, Chrome 4 threads | title check 65 to 197 ms, OCR 358 to 175 ms |
| Time per screenful, Zen 1 thread | title check 205 to 482 ms, OCR 383 to 341 ms |
| Process memory, Chrome and Zen | 491 and 411 MB before, 467 and 351 MB now |

Title checks are slower than in 0.1 and OCR is faster. Image recognition is still weak: it names few titles, and a wrong title is possible (8 wrong titles and 2 ordinary photos named on the held-out split). The dependable signals are text inside images (OCR) and the text around a post.

**Not tested**

- Real social sites in a browser. The end-to-end tests use fixture pages.
- Firefox for Android.
- Any real phone. Android only ran in an x86_64 emulator (an arm64 build under translation too). NNAPI acceleration, arm64 and every Android speed figure have never run on a real phone.
- X and Instagram feeds on Android. They were only launched to their login screens in 0.1. Nothing has run in X or Instagram since, and the settings row added to X's own settings screen has never been run.
- The Android fix for a feed that jumped on a real phone (image capture drawing host views). It was checked only by frame counters in the demo app on the emulator.
- Video frames on Android. Only thumbnails and posters are scanned there.
- TalkBack with real content, and push notifications from a real app. Both were tried only in the demo.

**Behaviour to know about**

- In `spoilers` style a bare title mention is shown, so a trailer title is not hidden. `all` style hides it.
- Posts that name nothing ("that ending destroyed me") are not caught.
- A single-word title at the start of a sentence, with no media word in that sentence, is not matched.
- Not scanned in the browser: backgrounds set by a stylesheet, loose text directly inside a very large container, and media inside shadow roots is not dimmed until its verdict arrives.
- Chinese, Japanese and Thai text has no word spaces, so titles inside such text do not match.
- Each frame of a page loads its own copy of the index (about 3.3 MB).
- Android patch sizes: the 0.2.0 bundle is 138 MB and the companion APK 1.5 MB. How much a patched app grows was measured for 0.1 only (roughly 100 to 115 MB over the original); not re-measured. X additionally needs `extractNativeLibs` set to true, which the patch does.
- Patching and using modified X, Instagram or YouTube apps is against those services' terms. APKs are not included in this repository. You must supply your own and must not redistribute the patched files.

## Privacy

- Everything runs locally: matching, classification, image recognition and OCR. The models ship inside the extension and the bundle.
- Your library and settings stay in the browser's extension storage (`storage.local`), or on Android in the app's private preferences, or in the companion app's.
- The one network call is the catalog update, and only when you turn it on or press "Update now". It sends a SPARQL query to `https://query.wikidata.org/sparql`. The request carries no cookies and no referrer, and nothing about you or your browsing.
- The Firefox manifest declares `data_collection_permissions: required: none`.
- The extension asks for `storage`, `alarms` and access to all sites (`<all_urls>`). The Chrome build also asks for `offscreen`. The content script runs in every frame of every page.
- The browser extension's background code refetches cross-origin images itself to score them. Those requests go to the sites that already served the images.
- Android companion app: it asks for no permissions. It answers only the packages on a fixed list, by package name; see [docs/android.md](docs/android.md#the-companion-app-and-the-shared-config) for what that does and does not protect.

## Install from a release

A release has these files:

| File | What it is |
|---|---|
| `spolierblock-0.2.0-firefox.zip` | The Firefox build. Unpack it and load it as in the [load steps](#quick-start-browser-extension) below, choosing the unpacked `manifest.json`. |
| `spolierblock-0.2.0-chrome.zip` | The Chrome build. Unpack it and use "Load unpacked" on the folder. |
| `patches-0.2.0.mpp` | The Morphe patch bundle. Use it with `android/apply.sh` (see [docs/android.md](docs/android.md)), or add it as a local patch source in Morphe Manager (not verified). |
| `spolierblock-companion-0.2.0.apk` | Optional companion app. It keeps one list shared by all patched apps. |
| `SHA256SUMS.txt` | Checksums of the files above. |

No YouTube, X or Instagram APK is ever distributed. You supply your own.

**Keep your signing key.** `android/keystore/` holds the local key that signs the patched apps and the companion app. It is created on the first patch and is not in git. Back it up outside the repository. If you lose it, apps you installed cannot be updated in place: you would have to uninstall them (and lose their data) and install builds signed with a new key.

## Quick start: browser extension

Prerequisites:

- Node.js with npm. The scripts use ES modules and `node --test`.
- Network access for the first build. It downloads the SigLIP 2 vision model (about 378 MB), the SigLIP 2 text model (about 565 MB, used only at build time to embed title names), a tokenizer and the two OCR models, into `build/.cache`. Each file is checked against a pinned sha256.
- `tools/catalog/cache/` or network access. The build asks Wikidata for class lists when that cache is missing (see [docs/development.md](docs/development.md)).

Build:

```sh
npm install
npm run build
```

This writes `dist/firefox` and `dist/chrome` (about 160 MB each).

Load in Firefox or Zen:

1. Open `about:debugging#/runtime/this-firefox`.
2. Choose "Load Temporary Add-on...".
3. Select `dist/firefox/manifest.json`.

Temporary add-ons are removed when the browser restarts. Firefox 140 or newer is required (Firefox for Android 142, untested).

Load in Chrome or another Chromium browser:

1. Open `chrome://extensions`.
2. Turn on "Developer mode".
3. Choose "Load unpacked" and select `dist/chrome`.

`npm start` runs `web-ext run` on `dist/firefox` with the browser path `/usr/bin/zen-browser`. That path is for the maintainer's Linux machine. Edit the `start` script in `package.json` or run `web-ext` yourself with your own `--firefox=` path.

After loading, click the toolbar icon for the quick panel: the cover count of the page, pause on this site, search and mark a work as seen. "All settings" opens the settings page. The suggested shortcut Alt+Shift+B turns blocking on or off. The toolbar badge shows the number of covers on the page, or "off".

## Quick start: Android

See [docs/android.md](docs/android.md). In short: build the extension data (`npm run build`), set up the Morphe tooling once (`android/tools/bootstrap-morphe.sh`), build the bundle (`./gradlew :patches:buildAndroid` in `android/`), then patch an APK you supply with `android/apply.sh`. The bundle build reads the image models from `dist/firefox`, so `npm run build` must come first.

## Repository layout

| Path | Contents |
|---|---|
| `manifest.json` | Extension manifest (Firefox form; the build derives the Chrome one). |
| `src/content/` | Content script, text matcher, overlay CSS. |
| `src/background/` | Background script, inference engine, PP-OCR module, offscreen page (Chrome), catalog update. |
| `src/options/` | Settings page, and the config module and UI helpers shared with the popup. |
| `src/popup/` | The toolbar quick panel. |
| `src/shared/` | Catalog rules and the index builder, shared by the browser and Node. |
| `data/catalog.json` | The work catalog (24,670 works). |
| `models/spoiler/` | The fine-tuned spoiler classifier (int8 ONNX, tokenizer, threshold). |
| `models/ocr/` | The OCR character list. The OCR models themselves are downloaded by the build. |
| `tools/` | Build, catalog, calibration, evaluation and training scripts. |
| `test/` | Unit tests, fixtures, end-to-end runner. |
| `android/` | Morphe patch bundle, Java extension, companion app, demo app, scripts. |
| `research/` | On-device model research: `REPORT.md` and the scripts behind it. Downloaded data, models and result files are not in git. `REPORT.md` was written for 0.1; its image section is out of date. |
| `docs/` | Documentation. |

Generated and local-only: `dist/`, `build/`, `node_modules/`, `tools/catalog/cache/`, and under `android/`: `apks/`, `out/`, `keystore/`, build outputs.

## Documentation

- [docs/how-it-works.md](docs/how-it-works.md): architecture, storage, matcher rules, styles, image pipeline, catalog.
- [docs/android.md](docs/android.md): the patch bundle, companion app, building, patching apps, settings, tests.
- [docs/development.md](docs/development.md): npm scripts, tests, rebuilding data, retraining, machine locks and memory guidance.
- [docs/agents/contract.md](docs/agents/contract.md): the config, decision rule and cover wording that the extension and Android must agree on.

For coding agents:

- [AGENTS.md](AGENTS.md): the entry point (repo map, verification commands, hard rules). [CLAUDE.md](CLAUDE.md) imports it.
- [docs/agents/delegation.md](docs/agents/delegation.md): how to split work between agents in this repository.
- [docs/agents/ui.md](docs/agents/ui.md): the existing look and the rules for UI changes.
- [docs/agents/pitfalls.md](docs/agents/pitfalls.md): traps specific to this repository.

## Attribution

| What | Source | Licence or terms |
|---|---|---|
| Work catalog | Wikidata (titles, aliases, characters, dates) | CC0 |
| Image title model | `onnx-community/siglip2-base-patch32-256-ONNX`, pinned revision (ONNX build of Google's SigLIP 2 base, patch 32, 256 px). The build converts its weights to int8. | Apache-2.0, per the model card |
| OCR models | PaddleOCR v5 mobile detector and English recogniser (PP-OCRv5), ONNX files published by RapidOCR (`RapidAI/RapidOCR` v3.10.0) | Apache-2.0, per the model card |
| Text model base | `sentence-transformers/all-MiniLM-L6-v2`, fine-tuned here | See the model card |
| Spoiler training data | Reddit episode-discussion comments from the `bobotran/spoiler-matching` dataset (hand-labelled split) | CC BY-SA 3.0 |
| Spoiler training data | English Wikipedia plot, production and reception sentences of the 300 most popular works | CC BY-SA 4.0 |

The classifier in `models/spoiler` was trained on that Reddit data, that Wikipedia text, and hand-written sentences and patterns. The held-out evaluation sets are hand-written and were not used for training or threshold choice.

Runtime libraries: onnxruntime-web and `@huggingface/transformers` (browser; transformers.js is used for the tokenizer at run time and for the text model at build time); ONNX Runtime for Android 1.22.0 (Android); Morphe patcher and CLI (patching). `tesseract.js` and `@tesseract.js-data/eng` are still listed in `package.json`, but nothing in the build, the extension or the Android code uses them; only two comparison scripts under `research/scripts/` do. Tesseract is no longer part of any shipped build.

## Licence

GNU General Public License, version 3. See [LICENSE](LICENSE).

This covers the code in this repository. Third-party data and models keep their own terms, listed under [Attribution](#attribution): in particular the spoiler classifier in `models/spoiler` was trained partly on CC BY-SA 3.0 and CC BY-SA 4.0 data, and the test images in `test/fixtures/images` are third-party pictures used for testing only.
