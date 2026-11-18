# Pitfalls

Traps specific to this repository, each checked against the code or the commit history at version 0.2.0. Read the section for the area you are about to change.

## Models

- **SigLIP 2 breaks under ordinary int8 quantisation.** Dynamic or static int8 of the activations gives a cosine of about 0.7 against fp32. Weight-only int8 gives 0.9998. So `tools/quantize-vision.mjs` quantises only the MatMul weights (int8 plus a scale per output column, restored by a `DequantizeLinear` node) and the activations stay fp32. Do not replace it with `onnxruntime.quantization` or with a ready-made `*_quantized.onnx` file. (`quantize-vision.mjs` header, commit 58060f2.)
- **Weight-only int8 costs time on every run.** The weights are restored on each inference, which is why title checks run in batches of up to 4. Folding them to fp32 at load is faster but about doubles the process memory (about 1 GB). The owner's budget is about 1 GB for the models, so it is not enabled. (`engine.js`.)
- **The int8 MiniLM classifier is scored one sentence at a time.** It quantises activations per tensor, so padding or batching sentences changes the scores. Do not batch in `classify`. The post's score is the maximum over sentences, so one spoiler sentence is not diluted. (`engine.js`.)
- **Held-out files are never used for training, tuning or choosing a threshold.** That is `test/fixtures/spoiler-eval.jsonl`, `spoiler-eval2.jsonl` and the held-out half of the image calibration. `finetune.py` chooses the threshold on validation items only. If you retrain, read both eval files once, at the end, and report what you found with its caveat. (`train-spoiler.mjs` header.)
- **`fp-posts.jsonl` is a tuning benchmark, not a held-out one.** The matcher rules were adjusted while looking at it. Do not quote a further improvement on it as evidence.
- **The shipped image cut-offs are fitted on all calibration images**, including `test/fixtures/images`. Only the two-fold line of `tools/calibrate-clip.mjs` is held out. The held-out line needs the research image sets (`SB_RESEARCH=research`), which are not in git.
- **PP-OCR boxes are axis-aligned.** Slanted text (more than about 10 degrees) reads worse. It is a known `shortcut` in `ocr.js`, not a bug to fix in passing.

## Browser runtime

- **Firefox has one WASM thread and a lazy event page.** Extension pages in Firefox cannot be cross-origin isolated, so there is no `SharedArrayBuffer` and the models run on one thread (title checks took 482 ms against Chrome's 197 ms with four threads, in the image work's figures). The event page may not be running when a content script sends a request, so `ask()` in `content.js` retries a few times on "Receiving end does not exist" instead of failing open. Do not make a request failure reveal a picture without that retry. (Commit 431ace9.)
- **A Chrome service worker cannot host the WASM runtime.** The engine runs in an offscreen document. `offscreen.js` registers its message listener before it loads the engine, because a message sent right after the document is created must find a receiver. `background.js` shares one promise for creating the document, because two early messages used to race. Keep `target: 'offscreen'` on forwarded messages.
- **`img.currentSrc` updates late in Firefox.** It changes only once the new picture starts loading, so a recycled `<img>` with a new `src` looked unchanged and kept its old verdict. The content script decides on the attribute change (`src`, `srcset`, `poster`, with the mutation's old value). Do not go back to comparing `currentSrc` alone. (Commit 431ace9.)
- **Every frame loads its own index.** The content script runs in all frames, so a page with several iframes pays the index size (about 3.3 MB) per frame. Counts and the toolbar badge come from the top frame only.
- **Closed shadow roots need an API.** `openOrClosedShadowRoot` is `element.openOrClosedShadowRoot` in Firefox and `chrome.dom.openOrClosedShadowRoot` in Chrome; both are used in `shadowOf`. A custom element that is not yet defined gets its root on upgrade, which no mutation reports, so it is retried for 30 seconds.

## Covers and layout

- **A cover must not change the measured size of anything.** Virtualised feeds (X, Reddit, YouTube) position posts by measured height. The cover is absolutely positioned with `!important` rules and size containment, content is hidden with `visibility` (never `display`), pending media is dimmed with `filter`, and `position: relative` is set only on a static block. The forced minimum height of 0.1 is gone: do not bring it back. The e2e recycled-feed case checks heights.
- **`all: initial` on the cover's `:host` resets `visibility`.** That is why the host sets `visibility: inherit !important`: without it a cover inside a container the page hides would show anyway, and a nested cover under an outer one too. (Commit 50c5d66.)
- **A cover is recomputed from what the block shows now.** Verdicts live per picture and per source URL, not per block. A recycled node must not keep the cover of its previous post. If you cache a decision on a block, key it by the text and the pictures it shows.
- **Do not decide from a wrapper.** A late verdict covers the post found by `findMediaBlock`, not the picture's immediate parent.

## Build and data

- **`npm run build:fixture` overwrites `dist/` and `build/data/`.** The e2e runner needs the fixture build; afterwards `dist/` holds the small test catalog until you run `npm run build` again. Do not hand `dist/` to anyone after an e2e session without rebuilding.
- **Catalog query strings are cache keys.** `tools/catalog/build.mjs` caches every Wikidata answer by the sha1 of the query text in `tools/catalog/cache/`. Changing a string in `src/shared/catalog-rules.js` (even a space) re-runs those queries, which are slow and polite. The name lookup uses 400 fixed buckets for the same reason. `tools/build.mjs` reads the same cache for the class lists and asks Wikidata when it is missing, so a worktree without the cache link needs the network.
- **`builtAt` is the catalog file's modification time.** `tools/build.mjs` writes it into `catalog-info.json`. The stored `catalogIndex` is valid only for the `builtAt` it was built against, and the catalog update's window starts at January 1 of the year before `builtAt`. A fresh checkout gives `data/catalog.json` a new modification time, so a build from a later checkout has a later `builtAt`. If you build releases from checkouts, set the file's time to the real catalog date first.
- **The index files go together.** `index.bin` (hashes) and `index.json` (groups, titles) are one artefact, built by the same call. The title rows in `clip-meta.json` refer to groups of the bundled `index.json`; a rebuilt index maps them back through `meta.fromBundled`. Do not mix files from two builds.
- **The Chrome manifest is derived.** Edit `manifest.json` (the Firefox form). The build deletes `browser_specific_settings` and rewrites `background` for Chrome, and pushes `offscreen` into `permissions`. Do not put Chrome-only keys in the source manifest.
- **The first build downloads about 1 GB** (vision model, text model, tokenizer, OCR files). Files are pinned by revision and sha256; if a download fails the check, do not loosen the check.
- **`research/` is mostly not in git.** `SB_RESEARCH=research` and some tools need files that exist only in the owner's checkout.
- **`package.json` still lists `tesseract.js`.** Nothing in the extension uses it; `@tesseract.js-data/eng` is read by the Android patch build.

## Android

- **Image capture must not draw host render nodes.** The capture draws only the `ImageView`'s drawable (`Images.drawContent`). `View.draw` on a hardware canvas puts the host's own `RenderNode`s (background, overlay children) into the capture renderer, and whichever renderer syncs a shared node first takes its damage. On devices with partial screen updates the app's next frame then leaves those regions unpainted: stale covers and posts, a feed that "jumps". The fix was checked only by frame counters in the demo on the emulator. Never on a phone, never in X.
- **Public Android APIs only, no resources, no AndroidX** in `extensions/blocker`. The library is merged into other apps' APKs. Tesseract4Android is added non-transitively so that its `androidx.annotation` is not merged in.
- **The provider's caller check is a package name.** `Store.CALLERS` is the allow-list; see [android.md](../android.md#the-companion-app-and-the-shared-config) for what that does not protect. Add a package to the list only for an app the patch supports.
- **A frozen app gets change notices late.** The shared config is refetched on every activity resume for that reason.
- **Obfuscated hosts.** Never fingerprint on obfuscated names. The patch finds the Application class from the manifest and hooks framework methods (`NotificationManager.notify`) and view classes named in layout XML (`TextContentView`, `IgTextLayoutView`). A hook that is not found only logs a warning.
- **The image files are out of step right now.** The bundle build and `android/tools/clip-vectors.mjs` still read `dist/firefox/models/clip/onnx/vision_model_quantized.onnx`, which the 0.2 browser build no longer writes, and `clip-meta.json` now describes SigLIP 2 rows while `Clip.java` is the ViT-B/32 port. Until the image port lands, do not "fix" this by copying old files into `dist/`.
- **The emulator is x86_64.** arm64 builds run under translation (Android 11 and newer images). Timings from it say little about a phone.
- **Only one emulator and one Gradle job at a time**, under the heavy lock.

## Stale comments you will meet

These comments in the code no longer match it. Do not trust them, and fix them when you are in the file anyway:

- `content.js`: "the engine itself gives up on a recognition after 10 s". The engine has no OCR time limit now; the 60 second safety net in the content script is what remains.
- `Scanner.java` (`activityWindow`): "no TouchGate: covers there have no buttons". Dialogs and popups do get buttons, through a transparent view on top of the window.
- `Ocr.java`, `Clip.java`, `Images.java`: they describe the extension's 0.1 pipeline (Tesseract, ViT-B/32), which is what Android still runs.
- `base.css`: "the near-black of the in-page cover". The real cover is a light or dark grey panel.
- `research/REPORT.md` describes 0.1-era models and figures.
