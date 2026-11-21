# SpolierBlock

Version 0.2.6.

SpolierBlock hides spoilers about films, shows, games, books, manga, anime and comics. It runs entirely on the device.

Every work has one of three states: seen, blocked, or not listed. A work that is not listed is covered by default (a setting turns that off). A cover says why it is there ("Mentions {title}", "Spoiler about {title}", "Image from {title}") and has the buttons "Show once", "I've seen it" and ⋮ (settings). After "Show once" the post keeps a small pill with "Not this" and "Cover again". Marking a work as seen is stored locally, and from then on posts about it are left alone. The exact rules and wording are in [docs/agents/contract.md](docs/agents/contract.md).

The product is spelled "SpolierBlock" (repository `RamazanBerk20/SpolierBlock`, export file `spolierblock-config.json`). Android identifiers use the usual spelling: package `dev.spoilerblock`, class `SpoilerBlock`, patch `SpoilerBlock`.

There are three parts:

| Part | What it is | Where |
|---|---|---|
| Browser extension | Manifest V3 extension for Firefox-family browsers (tested on Zen) and Chromium. One codebase. | `src/`, `manifest.json`, `tools/build.mjs` |
| Android patch bundle | A Morphe patch bundle that adds the blocker to YouTube 21.30.216, X 12.19.1-release.0 and Instagram 452.1.0.53.64. | `android/patches/`, `android/extensions/blocker/` |
| Android companion app | A small app (`dev.spoilerblock`) that owns the settings shared by all patched apps. Optional. | `android/companion/` |

The extension is a development build that you load by hand. The patch bundle needs APKs that you supply yourself. See [Status and known limits](#status-and-known-limits) before relying on any of them.

## What it does

- **Text matching.** A hash-index matcher over a catalog of 26,968 works built from Wikidata. It knows titles, aliases, character names and series names. A bare name refers to its closest works: the works titled exactly that, else the works that list it as an alternative name, else the members of the series it was derived from, and characters only after those ("Half-Life" is the 1998 game, not "Half-Life: Alyx"). A franchise name also takes its series when its closest works are entries of that series, or when the series' best work is at least 1.5 times as popular ("Halo"). A type word next to the name narrows the group ("the Minecraft movie"). See "Behaviour to know about" for the odd results. Ambiguous names (such as "Lost" or "It") need corroboration before they match, and a name whose usual meaning is not a work ("Palestine", "Napoleon") matches only next to a media word that fits the work's type. Sequel numbers match in both forms ("GTA 6", "GTA VI"). In ALL-CAPS runs and Headline Case lines (video titles) capital letters prove nothing, so a name that relies on case needs a media word next to it there; a distinctive single word ("Minecraft", "Arcane") counts however it is written. Text read from pictures is judged more strictly than the post's own text (see "Behaviour to know about"). The catalog holds narrative works only: scripture, reference works, most non-fiction, documentaries, news and talk shows, music competitions, award ceremonies, game and quiz shows, variety and sketch shows, albums and music videos are left out. Reality competitions and talent shows stay, because their results are spoilers.
- **Series.** Each work carries the series or franchise it belongs to, from Wikidata's "part of the series" and "media franchise" statements and, for works with none, from its title (6,035 of the 26,968 works; 913 series with two or more works). The picker's "More from this series" section reads it. It is separate from the name groups the matcher uses.
- **Three states and two styles.** Each work you touch is "seen" or "blocked". Each work, or all works by default, uses a style: `all` (cover anything about the work) or `spoilers` (cover only what a classifier calls a spoiler). The classifier is all-MiniLM-L6-v2, fine-tuned and quantised to int8 (`models/spoiler`). It scores each sentence and takes the highest score. If it fails, the post stays covered.
- **Names the rules are unsure about (browser extension).** An everyday-word title with no media word near it ("Heat still has the best shootout") or a title typed in lowercase ("lost was peak tv") is neither accepted nor dropped by the rules: a second model, the title-in-context model (`models/context`, the same MiniLM family, int8, about 23 MB), reads about 100 characters around the name and the work's name and types, and decides whether the post means the work. At most 4 names per post are asked. The post is not covered while the model is asked, and a failed answer counts as no, so a cover for such a name arrives a moment late rather than appearing and vanishing. Seen works are never asked.
- **Settings.** The extension has a settings page in its own tab (Library, Add by hand, Corrections, Blocking, Data, About) and a small popup. You can add works the catalog does not know by hand, and export or import everything as one file that works on both platforms.
- **Teaching it (browser extension).** "Not this" on the pill of a wrongly covered post (after "Show once") stops that work being covered for posts from that YouTube channel or X account (else the whole site). Text selected on a page can be added from the popup as another name for a work, and every work's row in the settings has an "Other names" editor. Both are listed under Corrections and travel in the export file. Remembering a video clip was measured and not shipped: frames of the same video a few seconds apart were too rarely closer to each other than frames of different videos (see docs/how-it-works.md).
- **Images and video thumbnails.** A SigLIP 2 vision model (weights quantised to int8) compares an image with precomputed title rows. The result is either a confident title or "looks like film, show or game media, no title". The second comes from media prompts (posters, stills) or from a small footage head, one linear layer on the same image embedding that tells footage of a game, an anime, an animation or a film from real-life video (`data/footage-head.json`); it never says which work. The engine resizes the picture itself (`src/background/pixels.js`), so every browser feeds the model the same numbers. OCR (PaddleOCR v5) reads text in the image and passes it to the same text matcher. Media stays dimmed until both verdicts are in. Naming a work from a picture that has no text is weak. OCR is the dependable image signal, and the image model's title is used only for a picture that no text identifies. An unidentified media image or video frame is covered only when "Cover unrecognised film, show and game footage" is on; it is off by default.
- **Opt-in catalog update.** Off by default. You can choose daily, weekly or monthly, or press "Update now". It downloads new titles directly from Wikidata's public query service. This is the only network use. Nothing about you is sent.
- **Threads.** The Chrome build is cross-origin isolated, so the models run on up to 4 WASM threads. The Firefox build runs on one thread.
- **Android.** The same catalog and matcher rules, ported to Java and tested against the JavaScript version. The same classifier through ONNX Runtime. A full-screen settings screen opens from the ⋮ button on a cover, from an app shortcut, or from the host app's own settings; its library can select several works at once. Push notification text is checked too. Images use the same models as the browser (SigLIP 2 and PaddleOCR on ONNX Runtime 1.22), with the same resize and cut-offs. The models load when the app opens, each picture's verdict is applied as soon as it is ready, and verdicts are kept across restarts. A picture still being judged is shaded on its own and the post's text stays readable. On-screen video players are sampled for a frame every 5 seconds. Covers take their colours from the host app's actual background, and a cover counts only where its item is visible on screen (so a pinned YouTube player is not shaded by a row scrolling under it). A YouTube row's description is cut to "title - channel" before matching, and small icon buttons' descriptions are skipped. Optional NNAPI acceleration of the title model is there, but its speed has never been measured on a real phone. See [docs/android.md](docs/android.md).

## Status and known limits

Measured results, from the maintainer's runs on this repository's fixtures. Where a figure was not re-run for this page, it says so.

**Text matcher**, `node tools/fp-posts.mjs` on `test/fixtures/fp-posts.jsonl` (the table's counts are as recorded; the file now holds 651 everyday posts and 312 posts about media; the 0.2.2 and 0.2.3 columns were re-run for this page):

| | 0.1 | 0.2.0 | 0.2.2 | 0.2.3 |
|---|---|---|---|---|
| Everyday posts wrongly covered | 51 of 630 | 9 of 630 | 9 of 636 | 9 of 636 |
| Media posts matched | 156 of 290 | 224 of 290 | 241 of 297 | 245 of 297 |
| of which non-English posts | 33 of 70 | 63 of 70 | 63 of 71 | 63 of 71 |
| Wrongly covered sentences of everyday prose (`tools/fp-text.mjs`) | 15.8 per 1,000 | 3.8 per 1,000 | 4.5 per 1,000 | about 4.3 per 1,000 (107 hits) |

The 0.1 and 0.2.0 columns and the `fp-text` row are the maintainers' figures and were not re-run here (the 0.2.3 `fp-text` figure is the text agent's, from the 0.2.3 work; the earlier columns carry the post counts they were recorded with; the file holds 651 and 312 now, and `node tools/fp-posts.mjs` on 2026-11-20 gave 2 of 651 covered and 282 of 312 matched, rules alone). `fp-text` rose from 3.8 to 4.5 in 0.2.2 and is about 4.3 now, while media recall rose. The rules were tuned while looking at this benchmark, so it is not held out.

**Video-style titles and text read from pictures** (new in 0.2.2; the 0.2.3 figures were run for this page; all three sets were looked at while the rules were chosen, so none is held out):

| Set and command | Result |
|---|---|
| Headline Case and ALL-CAPS titles, `node tools/fp-posts.mjs --file=test/fixtures/headlines.jsonl` | 5 of 250 titles that name no work wrongly covered; 174 of 250 titles of works matched (0.2.2: 5 and 168) |
| Picture text on its own, `node tools/fp-ocr.mjs` (`test/fixtures/ocr-noise.jsonl`) | 1 of 320 picture texts with no work covered; 70 of 80 titles in pictures matched (same as 0.2.2) |

**Plain sentences about famous multi-word titles** (new in 0.2.3). The sets above had none, so 0.2.2 missed "Resident Evil is scary", "Dark Souls is hard", "God of War is great" and "Silent Hill is terrifying" (the names were "common" and wanted a media word). `test/fixtures/top-names.json` lists the 300 most popular titles of two or more words (counting the works of the catalog series of that name). Each is put into four plain sentences ("{X} is great", "I finally finished {X}", and so on), 1,200 in all, and the test in `test/catalog.test.js` requires a work of that title to be found. the test allows at most 46 of the 1,200 to miss, and `npm test` passes; 367 missed before names took their franchise's popularity. The test lists 29 names it expects to miss: "The" plus one word (The Ring, The Thing, The Office); everyday-word names with no popular work of that name (Metal Gear, Knives Out, Gone with the Wind, Friday the 13th); and catalog entries named like lists ("Foundation series", "Platonic dialogue"). The list was in view while the popularity rule was set, so it is a guard, not a held-out measure. The fixtures `franchises.json` (what 28 bare names refer to), `series.json` and `yt-rows.jsonl` (91 YouTube rows) check the groups, the series and the YouTube text.

Known misses and leaks: an everyday-word title with no media word near it ("Dune Was Incredible", "Why Lost Failed") is no longer left alone by the rules: it is an unsure name and the title-in-context model decides (see below), which still gets some wrong; a single word in picture text (a thumbnail that only says MINECRAFT); everyday words missing from the word lists (Vertigo, Scrubs); and a few non-fiction leaks.

**Fresh posts, held out** (`test/fixtures/posts-heldout.jsonl`: 200 posts about media and 200 everyday posts, written for this decision; nobody looked at the rows or tuned on them; measured once by the maintainer, not re-run for this page). The released 0.2.3 matcher found 96 of 200 media posts (48.0%) and covered 0 of 200 everyday posts. The current rules alone find 113 of 200 (56.5%), 0 of 200 covered; rules or the title-in-context model find 156 of 200 (78.0%), 1 of 200 covered (0.5%). By type with the model, from a count that normalises titles and so gives 160 of 200: movie 27 of 33, tv 27 of 33, game 29 of 33, book 20 of 27, anime 21 of 27, manga 21 of 24, comic 15 of 23. The 95 % goal is not reached on fresh posts. The misses are works that are not in the catalog, name forms the index lacks, one-word titles among the 1,000 most frequent words, and non-English posts (the context model was trained mostly on English text). The 90 to 95 % figures in the tables above are on tuned-on files and say little about posts nobody has seen. A second development set, `test/fixtures/posts-dev.jsonl` (200 and 200 posts), informed one training round of the model, so it is tuned-on too: `node tools/eval-context.mjs test/fixtures/posts-dev.jsonl` gives rules alone 107 of 200 (53.5%), rules or model 162 of 200 (81.0%), 0 of 200 everyday posts covered in both.

**Spoiler classifier**, wrongly blocked or caught, out of the number of posts (`node tools/eval-spoiler.mjs`). "0.2.3" is the model before the retraining described below, "now" the current one; each file was run once before and once after, nothing in between:

| Kind of post | `spoiler-eval.jsonl`, 0.1 | `spoiler-eval.jsonl`, 0.2.3 | `spoiler-eval.jsonl`, now | `spoiler-eval2.jsonl`, 0.1 | `spoiler-eval2.jsonl`, 0.2.3 | `spoiler-eval2.jsonl`, now |
|---|---|---|---|---|---|---|
| Explicit spoilers caught | 60 of 60 | 59 of 60 | 58 of 60 | 60 of 60 | 57 of 60 | 59 of 60 |
| Implied spoilers caught | 84 of 90 | 77 of 90 | 74 of 90 | 74 of 80 | 76 of 80 | 76 of 80 |
| Neutral posts wrongly blocked | 15 of 90 | 6 of 90 | 3 of 90 | 28 of 100 | 12 of 100 | 10 of 100 |
| Tricky non-spoilers wrongly blocked | 17 of 60 | 6 of 60 | 4 of 60 | 42 of 80 | 17 of 80 | 13 of 80 |
| ROC AUC | 0.960 | 0.969 | 0.972 | 0.901 | 0.956 | 0.963 |

Neither file was used for training, for choosing the threshold or for choosing between training runs. `spoiler-eval2.jsonl` was written without looking at the training data, but by the same model family that wrote part of the training examples, so its look-alike cases resemble them. The retraining added hand-written implied spoilers without the obvious words, spoilers and look-alikes in Turkish, Spanish, Portuguese, German and French, and more English look-alikes (`tools/spoiler-train/gaps.mjs`), and a validation set, `test/fixtures/spoiler-val.jsonl` (673 hand-written posts, 19 % not in English). The validation set chose the threshold (now 0.8) and the run; its figures are tuned-on: 0.2.3 caught 123 of 150 explicit and 134 of 192 implied spoilers and blocked 2 of 151 neutral and 14 of 180 tricky posts, the current model 141, 167, 2 and 7. On the held-out files the current model blocks fewer non-spoilers, but on `spoiler-eval.jsonl` it misses 3 more implied spoilers than 0.2.3. No category is at 95 % on both files: implied recall (82 % and 95 %) and tricky posts (7 % and 16 % wrongly blocked) fall short.

**Image titles and OCR** (the maintainer's figures from the image work; not re-run for this page; other jobs were running, so timings are good to about 30 percent). The title figure was re-measured after the catalog merge and the new resize; the other rows are from before them:

| Measure | Result |
|---|---|
| Title check on a held-out split (397 media, 466 ordinary photos) | 22 right, 8 wrong, 2 ordinary photos named, with the merged catalog (before the catalog merge: 28 right, 4 wrong, 0 named). The calibration is noisy: the two halves of the split pick very different cut-offs, so a few images move the result. The 0.1 model with its own cut-offs on an earlier split: 14 right, 6 wrong, 1 named, plus 17 with the generic label. |
| Title check on `test/fixtures/images` | 5 of 31 media images titled right, 0 wrong, 0 of 44 ordinary photos named (measured before the recalibration, not re-run). The cut-offs were fitted on a set that includes these images, so this is not held out. |
| OCR captions read, synthetic but realistic set (thumbnails, subtitles, HUDs, memes, post screenshots) | 171 of 185, against 34 of 185 with Tesseract. The OCR settings were tuned on the same set. |
| Cross-browser score spread, Chrome against Firefox, fixture images (`tools/bench-stats-diff.mjs`) | Up to 0.010 with canvas scaling, at most 0.0013 now that the engine resizes in JavaScript. |
| Time per screenful, Chrome 4 threads | title check 65 to 171 ms (175 ms for one image alone), OCR 358 to 193 ms |
| Time per screenful, Zen 1 thread | title check 205 to 426 ms (448 ms for one image alone), OCR 383 to 350 ms |
| Process memory, Chrome | 491 MB before, 991 MB now: since 0.2.1 the title model's weights are held in full precision, which is faster and costs memory. Zen was not re-measured (about 910 MB in the earlier image work). |

Title checks are slower than in 0.1 and OCR is faster. Image recognition is still weak: it names few titles, and a wrong title is possible (8 wrong titles and 2 ordinary photos named on the held-out split). The dependable signals are text inside images (OCR) and the text around a post.

**Real-device status**

The owner has run the 0.2.0 and 0.2.2 bundles on one real phone (a Galaxy S25+) in patched YouTube, X and Instagram. This is the owner's report; no agent saw it. With 0.2.0, covers and their buttons worked in the YouTube and X feeds, a covered reel was muted, and the earlier feed jump was not reported again. With 0.2.2 he confirmed that the picker, the covers and the colours work. He reported these problems, which the 0.2.3 changes address: "Show once" re-covering a post in X, the YouTube watch-page player blacked out, franchise entries missing from the picker, wrong works offered for bare names, and a rapper matched as the film "Joker". The 0.2.3 changes themselves have run only on the emulator and in the demo app. Nothing was measured on a phone (speed, memory, acceleration). Agents here still use the emulator only.

**Not tested**

- Real social sites in a browser. The end-to-end tests use fixture pages.
- Firefox for Android.
- The 0.2.3 Android changes on a phone: "Show once" per post, covers counted only where their item is visible, the YouTube row text cleanup, the picker's "More from this series". They ran only on the emulator and in the demo app (the YouTube row cleanup was verified in English and Turkish). The 0.2.2 video-frame sampling and early model loading have still not run on a phone either; the owner confirmed the picker, covers and colours from 0.2.2.
- The on-device catalog update's series step (a series lookup of at most 5 queries): tested with a fake endpoint, never against live Wikidata with the new code.
- A YouTube watch page where the pinned player is drawn inside the list's own area: the visibility check clips to the list and its parents but has no "moves with the item" test, so such a player could still be shaded (see [docs/android.md](docs/android.md)).
- The Reels touch fix. It comes from reading Instagram's APK and from a reproduction in the demo app; it never ran in Instagram.
- The X quoted-post hook. It comes from reading X 12.19.1 statically and never ran in X. Its field name is obfuscated, so another X version may lose it (the patch then logs a warning).
- NNAPI acceleration, arm64 speed and every Android speed and memory figure on a phone. The figures here are from an x86_64 emulator.
- The Android fix for a feed that jumped (image capture drawing host views): the owner has not reported the jump again, but no frame counter or log from the phone exists here.
- TalkBack with real content, and push notifications from a real app. Both were tried only in the demo.
- Comment sections in X and Instagram on Android (no account). In the browser, comments were tested on fixture pages only.
- The settings row added to X's own settings screen: the owner has not reported on it.

**Behaviour to know about**

- In `spoilers` style a bare title mention is shown, so a trailer title is not hidden. `all` style hides it.
- Posts that name nothing ("that ending destroyed me") are not caught. A work is named from footage only when some text identifies it. A gameplay clip with no title, caption or picture text is never named; with "Cover unrecognised film, show and game footage" on (off by default) it is covered as unidentified footage, like footage of works you have finished unless the post names one you marked seen. Measured on YouTube frames only (docs/how-it-works.md, "What the footage head was measured to do"): 104 of 111 game videos flagged within 30 seconds by a head that never saw the game, and 3 of 101 real-life videos wrongly flagged in that time; an earlier head, scored on 122 clips fetched after it was trained, flagged 36 of 37 game videos and 2 of 36 real-life ones. Anime and animation are caught in most videos, live-action in about two of three, sports and simulation games hardly at all, and film-like music videos and adverts are covered too.
- A bare name refers to its closest works, which gives odd results for some franchises (checked in `test/fixtures/franchises.json`). "Call of Duty" means only the 2003 game, "Final Fantasy" only the 1987 game, "Pokémon" only the 1997 anime, "Super Mario" only the 1993 film, "Harry Potter" the books and the 2026 series but not the films, and "Star Trek" the 2009 film and a 1971 game. "Terminator" alone matched nothing in a probe of the current catalog. "I've seen it" on a cover whose name stands for one work marks that work at once and opens no picker, so "More from this series" is not offered there (a cover for "Call of Duty" marks only the 2003 game). A type word next to the name narrows the group ("the Minecraft movie", "Assassin's Creed game").
- A work whose title equals a series name joins that series whatever its type: the Dostoevsky novel "The House of the Dead" is in the game series (about three such cases are known). "Silent Hill: Townfall" is not in the catalog: it has 13 Wikipedia sitelinks and the catalog needs 15.
- "Show once" is remembered per post, by the post's own text, on both platforms. Two posts with identical text share the choice: showing one shows the other (the extension compares text with whitespace collapsed; Android also blanks numbers). It lasts until the page is closed or the app process ends, and covers the last 500 posts shown. A post with no words is told apart by its pictures.
- A single-word title at the start of a sentence, with no media word in that sentence, is not matched.
- "I've seen it" on a name that stands for several works (a franchise such as "Resident Evil", or an original and its remake) opens a picker, "Which have you seen?", listing only works not yet seen. A second section, "More from this series", offers the rest of the franchise so you can mark everything at once; it is optional. A cover that names several works lists all of them. Only the works you tick are marked, and a post that only says the franchise name is shown once you have seen one of its works (block a work to keep the bare name covered). A name of one work marks it at once and shows no picker.
- Text read from pictures (OCR) counts only for clear multi-word titles: a single word, a sequel-number swap or a name that mostly means something else is ignored there, media words in picture text do not help, and picture text never confirms a weak name in the post's own text. When the post's own text names only works you have seen, picture text does not cover it.
- The image model's title for a picture is used only when no text identifies the picture: it is dropped when the post's own text, or the picture's own text, names any work.
- Android checks "Image from" before "Spoiler about": a post with both a spoilers-style text match and a titled picture is labelled "Image from {t}" and the classifier is not asked. The extension asks it first and says "Spoiler about" when it answers spoiler.
- Not scanned in the browser: backgrounds set by a stylesheet, loose text directly inside a very large container, and media inside shadow roots is not dimmed until its verdict arrives.
- YouTube comments on Android are not covered: the comment rows draw their own text (Litho) and expose it to nothing the blocker reads. Search results and the watch-page title are covered.
- A covered post's video and audio are silenced. In the browser a player embedded from another site (a YouTube embed) that is already playing is hidden but not silenced. On Android every player in the app is muted while a covered video is on screen, the video keeps playing silently, YouTube's VR/360 audio is not reached, and a covered video can sound for a few seconds after the app starts, before the index has loaded. A covered reel was muted on the owner's phone (0.2.0).
- Android video frames: on-screen players inside a feed item are sampled (at most 448 px, one frame every 5 seconds), and a player stays shaded until its first frame is judged. A protected video gets no shade and no verdict. YouTube's inline feed player floats over the list instead of sitting in the item, so it is not sampled.
- Chinese, Japanese and Thai text has no word spaces, so titles inside such text do not match.
- Each frame of a page loads its own copy of the index (about 3.5 MB: `index.bin` 1.57 MB and `index.json` 1.96 MB in `dist/firefox/data`).
- Android patch sizes: the 0.2.0 bundle is 138 MB and the companion APK 1.5 MB; the 0.2.2 and 0.2.3 sizes were not measured. How much a patched app grows was measured for 0.1 only (roughly 100 to 115 MB over the original); not re-measured. X additionally needs `extractNativeLibs` set to true, which the patch does.
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
| `spolierblock-0.2.6-firefox.zip` | The Firefox build. Unpack it and load it as in the [load steps](#quick-start-browser-extension) below, choosing the unpacked `manifest.json`. |
| `spolierblock-0.2.6-chrome.zip` | The Chrome build. Unpack it and use "Load unpacked" on the folder. |
| `patches-0.2.6.mpp` | The Morphe patch bundle. Use it with `android/apply.sh` (see [docs/android.md](docs/android.md)), or add it as a local patch source in Morphe Manager (not verified). |
| `spolierblock-companion-0.2.6.apk` | Optional companion app. It keeps one list shared by all patched apps. |
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

This writes `dist/firefox` and `dist/chrome` (about 180 MB each; 178 MB measured for 0.2.4 with the title-in-context model).

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
| `src/shared/` | Catalog rules, the index builder and the title-in-context model's input, shared by the browser and Node. |
| `data/catalog.json` | The work catalog (26,968 works, each with its series, and a top-level `series` table). |
| `models/spoiler/` | The fine-tuned spoiler classifier (int8 ONNX, tokenizer, threshold). |
| `models/context/` | The title-in-context model for unsure names (int8 ONNX, tokenizer, threshold). |
| `models/ocr/` | The OCR character list. The OCR models themselves are downloaded by the build. |
| `tools/` | Build, catalog (including `tools/catalog/common-words.txt`, built by `tools/catalog/words.mjs`), calibration, evaluation and training scripts. |
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
| Common-word list | `tools/catalog/common-words.txt`: a 20,000-word English list plus the 5,000 most frequent subtitle words of each of English, Turkish, Spanish, Portuguese, German, French and Italian, from `hermitdave/FrequencyWords` (OpenSubtitles 2018). It decides which names count as everyday words. | CC BY-SA 4.0 |

The classifier in `models/spoiler` was trained on that Reddit data, that Wikipedia text, and hand-written sentences and patterns. The held-out evaluation sets are hand-written and were not used for training, threshold choice or run choice; the validation set `test/fixtures/spoiler-val.jsonl` was used for the threshold and the run choice, never for training.

Runtime libraries: onnxruntime-web and `@huggingface/transformers` (browser; transformers.js is used for the tokenizer at run time and for the text model at build time); ONNX Runtime for Android 1.22.0 (Android); Morphe patcher and CLI (patching). `tesseract.js` and `@tesseract.js-data/eng` are still listed in `package.json`, but nothing in the build, the extension or the Android code uses them; only two comparison scripts under `research/scripts/` do. Tesseract is no longer part of any shipped build.

## Licence

GNU General Public License, version 3. See [LICENSE](LICENSE).

This covers the code in this repository. Third-party data and models keep their own terms, listed under [Attribution](#attribution): in particular the spoiler classifier in `models/spoiler` was trained partly on CC BY-SA 3.0 and CC BY-SA 4.0 data, and the test images in `test/fixtures/images` are third-party pictures used for testing only.
