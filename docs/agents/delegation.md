# Delegation in this repository

How to split work here when a strong main-loop model orchestrates and cheaper models do the labour. The general policy is the `fable-orchestration` skill (`~/.claude/skills/fable-orchestration/SKILL.md`) and the `CLAUDE.md` in the folder above this repository on the owner's machine. This page applies it to SpolierBlock. Where they differ, the policy wins and this page is wrong; fix this page.

The policy in one paragraph: the main loop decides what and why, writes briefs, reviews and synthesises. It does not do the typing. Opus takes medium-high difficulty with a fairly loose brief. Sonnet takes simple-medium work with a tight brief. Haiku takes very large data cleanup with the tightest brief. Every sub-agent call passes an explicit `model`. The main-loop model is never a sub-agent for labour.

## Ownership areas

Two writers never touch the same files. These areas can be worked in parallel because their files do not overlap. Within an area, one writer at a time.

| # | Area | Files it owns | Verification | Lock |
|---|---|---|---|---|
| 1 | Text matching, catalog, classifier, and their Java ports | `src/content/matcher.js`, `src/shared/`, `src/background/catalog-update.js`, `data/catalog.json`, `tools/catalog/`, `tools/build-index.mjs`, `tools/fp-*.mjs`, `tools/eval-spoiler.mjs`, `tools/train-spoiler.mjs`, `tools/spoiler-train/`, `models/spoiler/`, `test/matcher.test.js`, `test/catalog*.test.js`, `test/fixtures/{catalog.small.json,fp-posts.jsonl,spoiler-*,franchises.json,series.json,top-names.json,yt-rows.jsonl}`; Java: `Matcher.java`, `Catalog.java`, `CatalogUpdate.java`, `Classifier.java`, `WordPiece.java`, `Json.java`, the matching tests, `android/tools/{vectors,catalog-vectors,spoiler-vectors,mock-sparql}.mjs` | `npm test`, `fp-posts`, `eval-spoiler` on both files, then the vectors and `testDebugUnitTest` | H |
| 2 | Image engine, OCR, build | `src/background/{engine.js,ocr.js,pixels.js,offscreen.*}`, `tools/build.mjs`, `tools/build-clip-text.mjs`, `tools/quantize-vision.mjs`, `tools/calibrate-clip.mjs`, `tools/clip-prompts.mjs`, `tools/bench-*.mjs`, `test/ocr.test.js`, `test/fixtures/images/`, `research/scripts/` | `npm test`, a build, `calibrate-clip`, `bench-engine`, then e2e | B (H for calibration) |
| 3 | Content script and e2e | `src/content/{content.js,content.css}`, `test/e2e/` | e2e on both browsers | B |
| 4 | Settings page, popup, background, manifest | `src/options/`, `src/popup/`, `src/background/background.js`, `manifest.json`, `test/config.test.js` | `npm test`, e2e | B |
| 5 | Android app, patch, scanner, UI | everything else under `android/`: `patches/`, `companion/`, `demo/`, `apply.sh`, the scanner, cover, TalkBack, capture, notification, settings and store classes in `extensions/blocker/`, and the other scripts in `android/tools/` | demo build, emulator run, `testDebugUnitTest` | H |
| 6 | Docs | `README.md`, `docs/`, `AGENTS.md`, `CLAUDE.md` | every link and every statement checked against the code | none |

Notes on the seams:

- **The contract.** `docs/agents/contract.md` belongs to whoever changes the config, the decision rule or the cover wording, and that change comes first, before any area edits code. Make it the first commit of the task. Then areas 3, 4 and 5 implement it in parallel, and area 1 if the rule touches matching. One agent edits the contract.
- **Catalog update.** `catalog-update.js` (area 1) is called by `background.js` (area 4) and ported by `CatalogUpdate.java` (area 1). A change to its exports or to the shape of `catalogIndex` is a contract change between areas 1 and 4: the brief names the signature, and area 4 is not started until area 1's signature is committed.
- **Image engine and Android.** `Clip.java`, `Ocr.java`, `Images.java` and `Accel.java` are area 5's files and port area 2's `engine.js`, `ocr.js` and `pixels.js`. The artefacts they read (`clip-meta.json`, `clip-text.bin`, the model and OCR files, the preprocessing constants and the resize) are area 2's output. Area 2 commits first and states the constants; area 5 ports and regenerates the vectors (`android/tools/clip-vectors.mjs`). `src/background/pixels.js` belongs to area 2.
- **`tools/build.mjs`** is area 2's, even though it also builds the catalog class lists (area 1 asks area 2 for such a change).
- **Shared files** with no single owner (`package.json`, `package-lock.json`): the main loop edits them, or one agent does while the others wait.

## Which tier

| Kind of task here | Tier | Why |
|---|---|---|
| Change a matcher rule and port it to `Matcher.java`; change catalog rules, the narrative filter or the `other` lookup; touch the catalog update | Opus | The rule interacts with many others, the benchmark is not held out, and the port must stay byte-identical. |
| Classifier retraining, data changes, threshold, interpreting `eval-spoiler` | Opus | Judgement about leakage and what the numbers mean. |
| Engine, OCR, quantisation, calibration, the cut-offs | Opus | Subtle: SigLIP breaks under ordinary int8; held-out versus fitted figures. |
| Content script bugs (virtualised feeds, recycled nodes, layout), shadow DOM, frames | Opus | Easy to break the layout rule. |
| Android scanner, cover, capture, notifications, the Kotlin patch, the shared config and `Store` | Opus | Public-API-only constraints, obfuscated hosts, emulator-only verification. |
| A contract change | Main loop writes it, Opus implements the sides | The contract is the design. |
| A new e2e case for an existing rule; a new site selector; a settings page tweak from a written spec; a new row in the Android settings screen; a string change that is already in the contract | Sonnet | Well scoped, with a check to run. |
| Adding media words for one more language to `CONTEXT` and the Java copy, with the `fp-posts` check | Sonnet | Mechanical, with a measurable check. |
| Adding vectors, unit tests, script flags, docs updates, packaging | Sonnet | |
| Bulk data: hundreds of fixture rows, relabelling, translating look-alike sentences, cleaning logs or fixtures | Haiku | One rule, input and output examples, spot-check before merging. |

Two cautions for data work. Haiku never decides what the rules should be. The agent that writes training data must not also write held-out evaluation data: that is how the leak the held-out sets exist to prevent would happen.

Escalate one tier when a sub-agent fails or returns something wrong twice. Do not retry the same brief on the same model a third time.

## What a brief must contain

Every brief is self-contained: the sub-agent knows nothing else. Long briefs go in a file, and the prompt points at it.

All areas:

1. **Goal and why**, in two or three sentences.
2. **Files it owns, and files it must not touch.** Name the area from the table.
3. **Links**: [AGENTS.md](../../AGENTS.md) (hard rules), [contract.md](contract.md) when config, wording or the decision rule is involved, [pitfalls.md](pitfalls.md), and the section of [how-it-works.md](../how-it-works.md) or [android.md](../android.md) that describes the code.
4. **The verification command, the lock and the baseline.** Give the numbers to compare against (for the matcher: 9 of 630 everyday posts covered and 224 of 290 media posts matched on `fp-posts`; for the classifier, the figures in the README). Say what counts as done.
5. **Report format.** What it ran and the output, what it did not run, anything it could not verify, and any statement in the docs or notes that the code contradicts.
6. **Boundaries.** No push, no commit unless told, no new network use or permissions, no edits outside its files, no use of held-out files for tuning, no APKs in git.

Per area, add:

| Area | Also say |
|---|---|
| 1 | Which Java files must follow, and that `vectors.mjs` must pass after the port. The held-out and tuned-on status of each benchmark. Which catalog query strings must not change (they are cache keys). |
| 2 | Which pinned files and shas apply, that the title model must not get int8 activations, the cut-offs' calibration status, and the memory budget. Ask for `bench-engine` figures in Chrome and Zen. |
| 3 | The layout rule (a cover never changes a measured size), the e2e groups to run (`ONLY=...`), both browsers. |
| 4 | The storage keys and messages that must not change, and that the 0.1 migration keeps working. |
| 5 | Public Android APIs only, no resources or AndroidX in the library, the emulator rules (one at a time), and that agents never use a real phone: the owner ran 0.2.0 and 0.2.2 on one phone and the 0.2.3 changes have run only on the emulator and in the demo, nothing in X or Instagram. |
| 6 | Check every link and every statement against the code. Do not edit code. |

## Worktrees

Give each writing agent its own git worktree and branch (`git worktree add`; this repository already uses `.claude/worktrees/`, which is ignored). Do not share `build/` or `dist/` between trees: `build/data`, `build/clip-text-*.json` and `dist/` are outputs, and two builds writing one tree corrupt each other. `npm run build:fixture` overwrites `dist/` too.

Share the heavy, read-mostly inputs by symlink instead of copying or re-downloading them. These symlinks are for the working tree only and must never be staged (see the end of this section):

```sh
ln -s <main checkout>/node_modules node_modules
mkdir -p build && ln -s <main checkout>/build/.cache build/.cache
ln -s <main checkout>/tools/catalog/cache tools/catalog/cache
```

`build/.cache` holds about 1.3 GB of pinned downloads. `tools/catalog/cache` makes the build and the catalog build run without Wikidata. Do not run `npm install` in a worktree that has the `node_modules` symlink. For Android work also copy `android/local.properties`, copy the Morphe jar in `android/tools/` (or link it; it is ignored and replaceable), and run `npm run build` in that worktree, because the patch and the companion read `dist/firefox`. `research/` is not in git, so link it too when a task needs `SB_RESEARCH`.

**Never symlink an ignored folder that holds irreplaceable files**: `android/keystore` (the signing key) and `android/apks` (the supplied APKs). Copy the small files a task needs instead (for a build that must sign with the owner's key, copy `android/keystore/` into the worktree and delete the copy afterwards), or give the agent a path through the `KEYSTORE` variable. Symlinking `node_modules` and `build/.cache` is fine, because they can be recreated, but a symlink must never be staged: the ignore rules do not cover a symlink in every case, and a committed symlink, once merged, replaces the real folder (see [pitfalls.md](pitfalls.md#symlinks-to-ignored-folders-get-committed-and-merging-them-deletes-the-real-folder)). Stage files by name (`git add path/one path/two`), never `git add -A` or `git add .`, and check `git status` before every commit. Before the main loop merges a branch, it runs `git ls-tree -r <branch> | grep ^120000` and refuses the branch if anything prints.

The main loop merges the branches, one at a time, into an integration branch, in the order the seams above require (contract first).

## A report is a claim

A sub-agent's report is not proof. Before telling the owner something is done:

- read the diff (`git diff --stat`, then the files that matter) and check that only the area's files changed;
- run the verification command yourself, or the narrowest part of it, and compare with the baseline;
- for benchmark claims, check that the agent did not tune on the held-out set, and that the figure it quotes is the one the README would quote;
- for Android claims, check what actually ran: unit tests, the demo, an emulator, and say "emulator only";
- for docs, spot-check statements against the code.

If the report and the check disagree, the check wins. Say so in the final report.
