# AGENTS.md

Entry point for coding agents working on SpolierBlock 0.2.0. Humans: start with [README.md](README.md).

## The project in five lines

- SpolierBlock covers spoilers about films, shows, games, books, manga, anime and comics. Everything runs on the device.
- Browser extension (Manifest V3, Firefox-family and Chromium, one codebase): `src/`, `manifest.json`, `tools/build.mjs`.
- Android: a Morphe patch bundle (`android/patches`, Java extension `android/extensions/blocker`) for YouTube, X and Instagram, plus a companion app (`android/companion`, package `dev.spoilerblock`) that owns the shared settings.
- Text matching is a hash-index matcher over a Wikidata catalog (24,670 works); a fine-tuned MiniLM classifier tells spoilers from mentions; a SigLIP 2 model and PaddleOCR read images (the same models on Android).
- JavaScript is the source of truth. The Java code is a port, held in parity by vector tests.

## Repo map

| Path | What lives there |
|---|---|
| `src/content/` | Content script (`content.js`), text matcher (`matcher.js`), page CSS. |
| `src/background/` | Background, engine (title model, classifier), `ocr.js`, catalog update, Chrome offscreen page. |
| `src/options/` | Settings page, `config.js` (pure config functions), `ui.js` helpers. `src/popup/` is the quick panel. |
| `src/shared/` | Catalog rules and index builder, run by Node and by the extension. |
| `data/catalog.json`, `models/` | The catalog; the spoiler classifier (`models/spoiler`) and the OCR character list. |
| `tools/` | Build, catalog build, calibration, evaluation, training. `tools/catalog/` and `tools/spoiler-train/` hold sub-tools. |
| `test/` | Unit tests (`*.test.js`), fixtures, the end-to-end runner `test/e2e/`. |
| `android/` | `patches/` (Kotlin patch), `extensions/blocker/` (Java, tests), `companion/`, `demo/`, `tools/` (scripts, vector generators), `apply.sh`. |
| `research/` | 0.1-era model research (`REPORT.md`, scripts). Mostly not in git. Not a source of truth. |
| `docs/` | `how-it-works.md`, `android.md`, `development.md`; `docs/agents/` holds the agent docs. |

## Verify your change

Hold the lock when two agents might be running. `H` = `flock ~/.cache/sb-heavy.lock`, `B` = `flock ~/.cache/sb-browser.lock`. Details: [docs/development.md](docs/development.md).

| Area | Command | Cost | Lock |
|---|---|---|---|
| Matcher, config, catalog update, OCR module | `npm test` | seconds | none |
| Extension build | `npm run build` (first run downloads about 1 GB) | minutes | B |
| Fixture build for e2e | `npm run build:fixture` (overwrites `dist/`) | minutes | B |
| Content script, background, settings page | `npm run e2e -- firefox`, then `-- chrome` (needs the fixture build) | minutes, starts a browser | B |
| Text matching false positives and recall | `node tools/fp-posts.mjs` (and `tools/fp-text.mjs`, which downloads a corpus) | seconds | H |
| Spoiler classifier | `node tools/eval-spoiler.mjs` and the same with `models/spoiler test/fixtures/spoiler-eval2.jsonl` | under a minute | H |
| Image cut-offs | `SB_RESEARCH=research node tools/calibrate-clip.mjs` (needs the research image sets) | minutes | H |
| Image input across browsers | `node tools/bench-engine.mjs chrome --stats > chrome.json`, the same for `firefox`, then `node tools/bench-stats-diff.mjs chrome.json firefox.json` | minutes | B, and nobody on H |
| Engine latency | `node tools/bench-engine.mjs chrome` or `firefox` (after a build) | minutes | B, and nobody on H |
| Classifier training | `PYTHON=... node tools/train-spoiler.mjs` | about 9 minutes, 6 cores | H |
| Java parity | `node android/tools/vectors.mjs`, `catalog-vectors.mjs`, `spoiler-vectors.mjs`, `clip-vectors.mjs`, then `cd android && ./gradlew :extensions:blocker:testDebugUnitTest` (it also runs `ocrTestDebugUnitTest`) | minutes, 2 GB heap | H |
| Android end to end | `android/tools/demo-build.sh`, install, `android/tools/demo-fling.sh` | heavy; needs an emulator | H |

`npm run build:fixture` and `npm run build` write the same `dist/`. Run the real build again after an e2e session if you need the real catalog.

## Hard rules

1. **Everything runs on the device.** No new network use and no new permissions. The only network call is the opt-in catalog update to Wikidata. No remote scripts, fonts or images.
2. **Never commit or redistribute third-party APKs or patched outputs.** `android/apks/`, `android/out/`, `android/keystore/` stay ignored. Never symlink `android/keystore` or `android/apks` into a worktree, and stage files by name ([delegation.md](docs/agents/delegation.md#worktrees)). Do not add APKs, screenshots of third-party apps or `android/evidence/` to git.
3. **The extension source is plain ES modules with no build step.** `tools/build.mjs` only assembles and generates data. Do not add a bundler, a transpiler or a framework.
4. **The Android library has no resources and no AndroidX.** It is merged into other apps' APKs. UI is plain framework views built in code (`Ui.java`).
5. **JavaScript is the source of truth.** A change to matching, the catalog builder, the catalog update, the config or the classifier's pre- and post-processing needs the same change in Java, and the vector tests must pass.
6. **Change [docs/agents/contract.md](docs/agents/contract.md) first** when you touch the config, the decision rule or the cover wording. Then change both platforms. The strings must stay identical.
7. **Never train on, tune on or choose a threshold with the held-out files** (`test/fixtures/spoiler-eval.jsonl`, `spoiler-eval2.jsonl`, the held-out image split). Report what you measured, with its caveat, and do not tune a rule against a benchmark and then quote that benchmark as evidence.
8. **A cover never changes the measured size of a page element.** See [docs/agents/pitfalls.md](docs/agents/pitfalls.md).
9. **The machine is a 16 GB desktop.** One heavy job at a time. Use the emulator only, never a real phone, unless the owner says otherwise. The owner's budget for the models is about 1 GB on a 16 GB iGPU desktop and an 8 GB phone.
10. **Report plainly what you did not verify.** "Not run" and "emulator only" are acceptable answers. Do not write a statement into the docs that you did not check against the code.
11. Do not edit generated or ignored output (`dist/`, `build/`). Do not push, and commit only when asked.

## Documentation

- [docs/how-it-works.md](docs/how-it-works.md): architecture, storage, matcher rules, image pipeline, catalog.
- [docs/android.md](docs/android.md): patch bundle, companion app, shared config, scanning, tests, demo.
- [docs/development.md](docs/development.md): commands, locks, rebuilding data, retraining.
- [docs/agents/contract.md](docs/agents/contract.md): config, decision rule, cover wording, export file.
- [docs/agents/delegation.md](docs/agents/delegation.md): how to split work between agents here. The policy behind it is the `fable-orchestration` skill and the CLAUDE.md one folder up.
- [docs/agents/ui.md](docs/agents/ui.md): the existing look, and the `design-taste-frontend` skill for UI work.
- [docs/agents/pitfalls.md](docs/agents/pitfalls.md): traps specific to this repository. Read it before touching images, covers, the build or Android capture.
