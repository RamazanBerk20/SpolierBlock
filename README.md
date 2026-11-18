# SpolierBlocker

Version 0.1.0.

SpolierBlocker hides spoilers about films, shows, games, books, manga, anime and comics. It runs entirely on the device.

Every work is treated as unseen by default. Anything about an unseen work is covered with the text "Contains spoiler about {title}" and two buttons: "Show once" and "I've seen {title}". Marking a work as seen is stored locally, and from then on posts about it are left alone.

The project name is spelled "SpolierBlocker". The Android package and classes use "SpoilerBlocker".

There are two parts:

| Part | What it is | Where |
|---|---|---|
| Browser extension | Manifest V3 extension for Firefox-family browsers (tested on Zen) and Chromium. One codebase. | `src/`, `manifest.json`, `tools/build.mjs` |
| Android patch bundle | A Morphe patch bundle that adds the blocker to YouTube 21.30.216, X 12.19.1-release.0 and Instagram 452.1.0.53.64. | `android/` |

The extension is a development build that you load by hand. The patch bundle needs APKs that you supply yourself. See [Status and known limits](#status-and-known-limits) before relying on either.

## What it does

- **Text matching.** A hash-index matcher over a catalog of 25,467 works built from Wikidata. It knows titles, aliases, character names and series names. Names shared by several works form one group. Ambiguous names (such as "Lost" or "It") need corroboration before they match. Sequel numbers match in both forms ("GTA 6", "GTA VI", "Grand Theft Auto VI").
- **Two modes.**
  - `any` (default): block anything about an unseen title.
  - `spoiler`: block only when a classifier says a sentence is an actual spoiler. The classifier is all-MiniLM-L6-v2, fine-tuned and quantised to int8 (`models/spoiler`). It scores each sentence and takes the highest score. If it fails, the post stays blocked.
- **Images and video thumbnails.** CLIP ViT-B/32 (int8) compares an image with precomputed title prompts. The result is either a confident title or the generic label "May contain a spoiler (unrecognised film, show or game image)". OCR (Tesseract) reads text in the image and passes it to the same text matcher. Media stays covered until both verdicts are in.
- **Opt-in catalog update.** Off by default. You can choose daily, weekly or monthly, or press "Update now". It downloads new titles directly from Wikidata's public query service. This is the only network use. Nothing about you is sent.
- **Threads.** The Chrome build is cross-origin isolated, so the models run on up to 4 WASM threads. The Firefox build runs on one thread.
- **Android.** The same catalog and matcher rules, ported to Java and tested against the JavaScript version. The same classifier through ONNX Runtime, the same CLIP model, and Tesseract for OCR. A settings dialog opens from the ⋮ button on a cover or from an app shortcut. It has the seen list, "Only block actual spoilers", "Scan images and video" and the catalog update.

## Status and known limits

Measured results, from the maintainer's runs on this repository's fixtures.

**Spoiler classifier**, on the 300 held-out posts in `test/fixtures/spoiler-eval.jsonl` (`node tools/eval-spoiler.mjs`):

| Kind of post | Result |
|---|---|
| Explicit spoilers (60) | 60 caught |
| Implied spoilers (90) | 84 caught |
| Neutral posts (90) | 15 wrongly blocked |
| Tricky non-spoilers (60) | 17 wrongly blocked |

**Image model**, on the images in `test/fixtures/images`:

| Group | Result |
|---|---|
| 31 media images | 1 titled correctly, 15 blocked with the generic label, 15 missed |
| 44 ordinary photos | 0 blocked |

Image recognition is weak. Do not rely on it. The dependable signals are text inside images (OCR) and the text around a post.

**Not tested**

- Real social sites in a browser.
- Firefox for Android.
- Any real phone. Android only ran in an x86_64 emulator, including an arm64 build under translation.
- X and Instagram feeds. They were only launched to their login screens. No account was used.
- Video frames on Android. Only thumbnails and posters are scanned there.

**Behaviour to know about**

- In `spoiler` mode a bare title mention is shown, so a trailer title is not hidden. `any` mode hides it.
- Posts that name nothing ("that ending destroyed me") are not caught.
- The browser extension scans the top frame only. Content in iframes, shadow DOM, CSS background images and `document.title` is not scanned.
- Chinese, Japanese and Thai text has no word spaces, so titles inside such text do not match.
- Android patch sizes: the bundle is about 112 MB. Each patched app grows by roughly 100 to 115 MB over the original. X additionally needs `extractNativeLibs` set to true, which the patch does.
- Patching and using modified X, Instagram or YouTube apps is against those services' terms. APKs are not included in this repository. You must supply your own and must not redistribute the patched files.

## Privacy

- Everything runs locally: matching, classification, image recognition and OCR. The models ship inside the extension and the bundle.
- The seen list and settings stay in the browser's extension storage (`storage.local`), or on Android in the app's private preferences.
- The one network call is the catalog update, and only when you turn it on or press "Update now". It sends a SPARQL query to `https://query.wikidata.org/sparql`. The request carries no cookies and no referrer, and nothing about you or your browsing.
- The Firefox manifest declares `data_collection_permissions: required: none`.
- The extension asks for `storage`, `alarms` and access to all sites (`<all_urls>`). The Chrome build also asks for `offscreen`.
- The browser extension's background code refetches cross-origin images itself to score them. Those requests go to the sites that already served the images.

## Quick start: browser extension

Prerequisites:

- Node.js with npm. The scripts use ES modules and `node --test`.
- Network access for the first build. It downloads the CLIP model into `build/.cache` (Hugging Face).
- `tools/catalog/cache/` or network access. The build asks Wikidata for class lists when that cache is missing (see [docs/development.md](docs/development.md)).

Build:

```sh
npm install
npm run build
```

This writes `dist/firefox` and `dist/chrome`.

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

After loading, click the toolbar icon. You can search for works and add them to the seen list, switch modes, pause a site, and set the catalog update.

## Quick start: Android

See [docs/android.md](docs/android.md). In short: build the extension data (`npm run build`), set up the Morphe tooling once (`android/tools/bootstrap-morphe.sh`), build the bundle (`./gradlew :patches:buildAndroid` in `android/`), then patch an APK you supply with `android/apply.sh`.

## Repository layout

| Path | Contents |
|---|---|
| `manifest.json` | Extension manifest (Firefox form; the build derives the Chrome one). |
| `src/content/` | Content script, text matcher, overlay CSS. |
| `src/background/` | Background script, inference engine, offscreen page (Chrome), catalog update. |
| `src/popup/` | Popup and options page. |
| `src/shared/` | Catalog rules and the index builder, shared by the browser and Node. |
| `data/catalog.json` | The work catalog (25,467 works). |
| `models/spoiler/` | The fine-tuned spoiler classifier (int8 ONNX, tokenizer, threshold). |
| `tools/` | Build, catalog, calibration, evaluation and training scripts. |
| `test/` | Unit tests, fixtures, end-to-end runner. |
| `android/` | Morphe patch bundle, Java extension, demo app, scripts. |
| `research/` | On-device model research: `REPORT.md` and the scripts behind it. Downloaded data, models and result files are not in git. |
| `docs/` | Documentation. |

Generated and local-only: `dist/`, `build/`, `node_modules/`, `tools/catalog/cache/`, and under `android/`: `apks/`, `out/`, `keystore/`, build outputs.

## Documentation

- [docs/how-it-works.md](docs/how-it-works.md): architecture, storage, matcher rules, modes, image pipeline, catalog.
- [docs/android.md](docs/android.md): the patch bundle, building it, patching apps, settings, tests.
- [docs/development.md](docs/development.md): npm scripts, tests, rebuilding data, retraining, memory guidance.

## Attribution

| What | Source | Licence or terms |
|---|---|---|
| Work catalog | Wikidata (titles, aliases, characters, dates) | CC0 |
| Image model | `Xenova/clip-vit-base-patch32` (ONNX build of OpenAI CLIP ViT-B/32), int8 | See the model card |
| Text model base | `sentence-transformers/all-MiniLM-L6-v2`, fine-tuned here | See the model card |
| OCR data | Tesseract English data, package `@tesseract.js-data/eng` (`4.0.0_best_int`) | See the package |
| Spoiler training data | Reddit episode-discussion comments from the `bobotran/spoiler-matching` dataset (hand-labelled split) | CC BY-SA 3.0 |

The classifier in `models/spoiler` was trained on that Reddit data plus hand-written sentences and patterns. The held-out evaluation set is hand-written and was not used for training or threshold choice.

Runtime libraries: onnxruntime-web, tesseract.js, `@huggingface/transformers` (browser); ONNX Runtime for Android and Tesseract4Android (Android); Morphe patcher and CLI (patching).

## Licence

No licence has been chosen yet.

The Android patch bundle's own metadata (`android/patches/build.gradle.kts`) declares GPLv3, because the bundle links against morphe-patcher, which is GPLv3. That is not a licence for the rest of the repository.
