# How it works

This page describes the browser extension (version 0.1.0). The Android port is in [android.md](android.md). It follows the same rules.

## Overview

```
page  <->  content script  --messages-->  background  -->  engine (CLIP, OCR, classifier)
              |  matcher (text)              |  catalog search, catalog update
              |  overlay, media scan         |  Firefox: event page runs the engine itself
              v                              |  Chrome: service worker + offscreen document
        storage.local  <------  popup (seen list, settings)
```

| Piece | File | Job |
|---|---|---|
| Content script | `src/content/content.js` | Finds posts, runs the matcher, draws overlays, sends images to the background. |
| Matcher | `src/content/matcher.js` | Hash-index text matcher. Loaded before the content script. |
| Overlay styles | `src/content/content.css` | Hides the page until ready, dims unscanned media, hides blocked content. |
| Background | `src/background/background.js` | Routes messages, catalog search, catalog update scheduling, starts the engine. |
| Engine | `src/background/engine.js` | CLIP image check, OCR, spoiler classifier, priority queue. |
| Offscreen page | `src/background/offscreen.html`, `offscreen.js` | Chrome only. Hosts the engine. |
| Catalog update | `src/background/catalog-update.js` | Opt-in Wikidata refresh. |
| Popup / options | `src/popup/` | Seen list, search, settings. The same page is the options page. |
| Shared rules | `src/shared/build-index.js`, `catalog-rules.js` | Index builder and catalog rules. Used by Node and by the extension. |

### Background: Firefox and Chrome

- **Firefox.** `manifest.json` declares a module background script (an event page). It imports `engine.js` in place, so the models run in that page. Firefox extension pages cannot be cross-origin isolated, so the models run on one thread.
- **Chrome.** `tools/build.mjs` rewrites the manifest: the background becomes a module service worker, `offscreen` is added to the permissions, and COEP/COOP are set. Service workers cannot host the WASM runtime, so the worker creates an offscreen document (reason `WORKERS`) from `src/background/offscreen.html`. It forwards inference messages to that document with `target: 'offscreen'`. Cross-origin isolation (`cross_origin_embedder_policy: require-corp`, `cross_origin_opener_policy: same-origin`) gives that document `SharedArrayBuffer`. The engine then uses `min(4, hardwareConcurrency)` WASM threads.
- The Chrome build also writes `src/popup/browser-shim.js` (`globalThis.browser ??= chrome`) and adds it to the popup.
- The build removes `offscreen.html` and `offscreen.js` from the Firefox output.

Message listeners and the alarm listener are registered synchronously, so an alarm can wake a suspended page.

## Content script

It runs at `document_start` in the top frame of every page.

1. **Gate.** `content.css` keeps `body` invisible until the matcher is loaded and the first scan ran (`data-sb-ready` on `<html>`). A 2.5 second timer sets the attribute anyway, so a failure never leaves a page blank.
2. **Observe.** A `MutationObserver` collects changed text nodes, `alt` and `aria-label` attributes, and images and videos. It runs before paint.
3. **Find the block.** For each changed text it walks up to a "post-like" container. X, YouTube and Reddit have their own selectors. Everywhere else it uses a generic list (`article`, `li`, `figure`, class names containing `card`, `post`, `comment` and similar). A container with more than 3,000 characters of text is treated as a page section, not a post.
4. **Read the block.** Text nodes joined by newlines, plus `alt`, `aria-label` and `title` attributes, plus any OCR text found in the block's images.
5. **Match.** `matcher.evaluate(text, isSeen)` returns the groups the text is about. Groups whose works are all seen are dropped.
6. **Cover.** A `<sb-overlay>` element with a shadow root is added inside the block. It carries the text and the two buttons. The block's own children get `visibility: hidden`.
   - Text: `Contains spoiler about {title}`, with ` (+N more)` for several matches.
   - Buttons: "Show once" (this page view only) and "I've seen {title}".
   - "I've seen" writes every work of the matched name group to `storage.local.seen` in one call. Every tab then re-evaluates through `storage.onChanged`.
7. **Pause and disable.** `settings.enabled` and `settings.pausedSites` (a host and its subdomains) switch scanning off live.

Known limits, left as comments in `content.js`: iframes, shadow-DOM content, CSS background images and `document.title` are not scanned. Loose text directly inside a very large container is not blocked.

## Storage contract

All data is in `browser.storage.local`. The popup, the content script and the background share it.

| Key | Shape | Written by | Notes |
|---|---|---|---|
| `seen` | `{ [wikidataId]: { title, type, year, ts } }` | popup, content script | `year` may be `null`. `ts` is `Date.now()`. |
| `settings` | `{ enabled, scanImages, mode, pausedSites, catalogUpdate }` | popup | Defaults: `true`, `true`, `"any"`, `[]`, `"off"`. |
| `catalogIndex` | `{ builtAt, bin, meta, bundle }` | background | The rebuilt index after a catalog update. `bin` is base64. `bundle` is the `builtAt` of the bundled catalog it was built against. |
| `catalogAdded` | array of works (catalog schema) | background | Works added by updates. Used to rebuild offline after an extension upgrade. |
| `catalogMeta` | `{ lastCheck, lastSuccess, lastError, added, found, stats: { queries, bytes } }` | background | Shown in the popup. |

Values:

- `settings.mode`: `"any"` or `"spoiler"`.
- `settings.catalogUpdate`: `"off"`, `"daily"`, `"weekly"` or `"monthly"`.
- `catalogIndex` is used only when `catalogIndex.bundle` equals the current bundle's `builtAt`. Otherwise the bundled index is used.

### Messages

Sent with `runtime.sendMessage`.

| `type` | From | Fields | Reply |
|---|---|---|---|
| `catalog.search` | popup | `q`, `limit` | `{ results: [{ id, title, type, year }] }`. Prefix and word-start matches first, in popularity order. |
| `tab.stats` | popup | none | `{ blocked }`. The background asks the content script of the active page (or the most recent web page). |
| `sb.stats` | background | none | To a tab. `{ blocked }`. |
| `catalog.update` | popup | none | Runs one update, replies with the catalog status. |
| `catalog.status` | popup | none | `{ bundled, total, meta, updating }`. |
| `img.check` | content script | `key`, `url`, `prio` | `{ hits: [[groupIdx, score], ...] }`. Group `-1` means a media image with no certain title. |
| `img.ocr` | content script | `key`, `url`, `prio` | `{ text }`. |
| `text.classify` | content script | `text` | `{ spoiler, p }`. |

Any failure replies `{ error }`. `prio` is `0` for an image in the viewport, otherwise it is queued behind.

## The matcher

`src/content/matcher.js` is plain JavaScript, loaded as a content script and also by Node. The Android build ports it to Java.

### Index

- A catalog key is a sequence of normalised tokens, up to 8 tokens. Longer keys are dropped.
- Each key is hashed to two 32-bit values. The table is one flat `Uint32Array` with open addressing, loaded as is. The file layout is `[magic, slotBits, 0, ...slots]` and each slot is `hashA, hashB, value + 1`.
- A value packs `group << 7 | cap << 6 | common << 5 | ambiguous << 4 | kind`.
- Lookup costs about tokens x 8 hash probes. Memory per tab is about the file size (`index.bin` is about 1.6 MB for the shipped catalog).
- `index.json` holds per-work columns (`ids`, `titles`, `types`, `years`), sorted by popularity, and `groups`: `[label, workIdx, workIdx, ...]`.

A name maps to one group: every work carrying that name. "Dune" is the book, both films and a game. "Star Wars" (derived from "Star Wars: Episode IV - A New Hope" and others) is all the films. A group is seen only when all its works are seen.

### Tokens

- A token is a run of letters and digits, with inner apostrophes allowed. `&` becomes `and`. Apostrophes are dropped. Text is lowercased. Non-ASCII text is decomposed and its diacritics removed.

### Kinds of name

| Kind | Example | Notes |
|---|---|---|
| title | "Breaking Bad" | |
| alias | "TLOU2", "gta6" | Up to 8 per work. |
| series | "Star Wars" | Prefix before `:`, an en dash or a hyphen. Only when at least two works share it. Not derived from a single common word or fewer than 4 characters. |
| character | "Walter White" | Full multi-word names (up to 8 per work). |
| char1 | single-token character name | Weak. Must start with a capital letter. |
| part | "Snape" from a full name | Weakest. Must start with a capital letter. Parts that are everyday words are not indexed. |
| tag | `#BreakingBad` | Matches only when written with `#`. |

When one name plays several roles, the most title-like kind wins.

### Decision rules

These are in `Matcher.evaluate`.

1. A tag needs the `#`. A char1 or part needs a capital first letter.
2. A "cap" name must be written in Title Case ("The Walk", "Siberia"), unless it is quoted or hashtagged. The index marks a name "cap" when it is a single word, belongs to a work below a popularity limit, or is made only of common words.
3. The longest match wins. "Us" and "Last" inside "The Last of Us" are dropped. So is "Potter" inside "Harry Potter".
4. A match is "weak" when the name is common, a char1 or part, or a short or ambiguous title (ambiguous and at most 2 tokens, or one token of 3 characters or fewer). A strong match is accepted at once. A weak match needs corroboration:
   - a hashtag or quotes around it,
   - another, different name of the same group in the text,
   - for a capitalised name, a release year of one of its works as a token in the text,
   - a context word near it (within 3 tokens), such as `season`, `episode`, `trailer`, `ending`, `netflix`, `s01e02`. For a name that is not common, a context word anywhere in the text also counts, provided the name is not at the start of a sentence.
5. A common (everyday-word) name only takes a context word next to it, and never at the start of a sentence. A line break counts as a sentence start.
6. A part name is accepted only through a hashtag, quotes, or another name of its group in the text.
7. A group whose works are all inside another matched group adds nothing.

### Sequel numbers

At build time, names with Roman or Arabic sequel numbers from 2 to 20 are written both ways ("Grand Theft Auto VI" and "grand theft auto 6"). For two-token names the joined forms are also indexed ("gta6", "gtavi"). "I" is never a numeral, and a numeral only counts after another word. A numbered name of a popular work, or a non-everyday short word plus a number, may match in any case. "Chapter 6" and "Windows 11" still need corroboration.

## Modes

| Mode | Text-only match | Image-only match |
|---|---|---|
| `any` (default) | Blocked. | Blocked. |
| `spoiler` | Blocked until the classifier says "not a spoiler". Blocked if the classifier fails. | Blocked. A still from an unseen work counts as a potential spoiler. |

In `spoiler` mode, a bare title mention is shown once the classifier clears it, so a trailer title is not hidden.

### The classifier

- Model: `sentence-transformers/all-MiniLM-L6-v2`, fine-tuned end to end with mean pooling and one linear output. Int8 ONNX, about 23 MB (`models/spoiler/model_int8.onnx`).
- The text is split into sentences (`.`, `!`, `?`, newlines). At most 16 sentences are scored. `@handles` are removed. Sentences of 3 characters or fewer are skipped.
- Each sentence is scored alone (64 tokens max), because the int8 model quantises activations per tensor and batching would shift the scores. The post's score is the highest sentence score. A single spoiler sentence is not diluted by the rest.
- The post is a spoiler when `sigmoid(max logit) >= threshold`. The threshold is in `models/spoiler/meta.json` (0.45). It was chosen on a validation split, not on the evaluation set.
- Latency from `research/REPORT.md` (i5-10500H, median per sentence): Chrome 1 thread 17 ms, Chrome 4 threads 7 ms, Zen (1 thread) 22 ms. The report notes that figures vary by about 30 percent under load.
- Classification has the highest queue priority, ahead of images.

Results on the held-out set are in the [README](../README.md#status-and-known-limits). The report's AUC of 0.960 for this model should be read with its own caveat: the training patterns resemble the "implied" posts of the evaluation set, so it is likely optimistic.

## Images and video

Media scanning is controlled by `settings.scanImages`. Until an image has a verdict it is drawn as a dark placeholder (`filter` in `content.css`).

### Content script side

- Images and videos are queued for scanning when they come within one viewport height of the screen (`IntersectionObserver`, `rootMargin: 100% 0px`).
- An image is skipped when either side is under 96 px (natural size or displayed size). Only `http(s)`, `data` and `blob` sources are scanned.
- Readable images (same-origin, CORS, blob) are redrawn to a canvas of at most 768 px on the long side and sent as a JPEG data URL. Cross-origin images are sent as a URL, and the background fetches them with the extension's host permission and without credentials.
- Both verdicts are required before the image is revealed: CLIP and OCR. An OCR failure or timeout reveals the image and is counted in `data-sb-stats`.
- Video: the `poster` is scanned. During playback a frame (at most 448 px) is scanned at most every 5 seconds. If a frame turns out blocked, the video is paused. A video stays a placeholder until its first frame has a verdict. Videos from other origins without CORS cannot be sampled, so only the poster and the surrounding text count.
- OCR text is added to the block's text and the matcher runs again. A CLIP result of a title or "unknown" is kept per block.

### Engine side

Requests go through one priority queue, lowest number first. Order: classifier (-1), in-viewport CLIP (0), its OCR (1), off-screen CLIP (2), its OCR (3). Downloaded images are kept in a small cache (24 entries) so OCR reuses CLIP's download.

**CLIP verdict** (`clipCheck`):

1. Centre-square crop, resize to 224 x 224, normalise with CLIP's mean and standard deviation.
2. Run the vision tower (`Xenova/clip-vit-base-patch32`, int8, about 89 MB). Normalise the 512-value embedding.
3. Compute `neg`: the best cosine to the 33 generic prompts ("a photo", "a selfie", "a meal on a plate" and so on).
4. Compute `media`: the best cosine to 20 media prompts ("a movie poster", "a scene from a TV series" and so on). If `media - neg < mediaGate`, stop: not a media image.
5. Score the image against the title matrix (2,000 rows, int8, 512 values each). A row passes if `score >= minScore` and `score - neg >= margin`.
6. Title confidence: the best passing row must beat the best row of an unrelated title family by `titleGap`. If it does, the image names that title (up to the top 3 groups). Otherwise the result is group `-1`: blocked with the generic label, never offered as "I've seen".

Cut-offs, set in `tools/build.mjs` and stored in `data/clip-meta.json`:

| Name | Value |
|---|---|
| `minScore` | 0.22 |
| `margin` | 0.02 |
| `mediaGate` | 0.015 |
| `titleGap` | 0.02 |
| rows (`--clip-n`) | 2000 |

They were calibrated with `tools/calibrate-clip.mjs` on `test/fixtures/images`. The build comment records that the title gap cut wrong titles from 12 to 0 and right titles from 4 to 1 on the 31 media fixtures. These cut-offs are tuned on the same images they are reported on, so they are not an independent measurement.

Works added by a catalog update have no title rows (the CLIP text tower is not shipped), so their images only get the generic verdict.

**OCR**: Tesseract (tesseract.js, `eng` data `4.0.0_best_int`, one worker). A result counts only at mean confidence 60 or higher. A recognition is abandoned after 10 seconds and a new worker is started. The fetched bytes go to Tesseract unchanged. If it cannot decode them (for example WebP), the image is re-encoded as PNG and tried again.

The verdict cache holds up to 2,000 entries.

### Image model choice

SigLIP 2 was tried and reverted: it blocked fewer media images. The shipped model is CLIP ViT-B/32. `research/REPORT.md` predates that decision and still recommends SigLIP 2 for titles; read its image section with this in mind.

## Catalog

### Format

`data/catalog.json` is `{ "version": 1, "works": [...] }`, sorted by popularity (Wikidata sitelink count), highest first. Each work:

| Field | Meaning |
|---|---|
| `id` | Wikidata QID. |
| `title` | English label (or the `mul` label). |
| `type` | `movie`, `tv`, `game`, `book`, `anime`, `manga` or `comic`. |
| `year` | Earliest date of the work, or `null`. |
| `aliases` | Up to 8 alternative labels, at least 3 characters. English first. |
| `characters` | Up to 8 character names of two or more words. Only for works with at least 40 sitelinks. |
| `pop` | Sitelink count. |
| `ambiguous` | True for a title under 4 characters, one common word, or two top-1,000 words. |

The shipped catalog has 25,467 works. When a work fits several types, the first of anime, tv, movie, game, manga, comic, book wins. Works need at least 15 sitelinks. The film series class is excluded. `tools/catalog/20k.txt` is the common-word list behind `ambiguous` and the index rules.

`npm run build` compiles it into `index.bin` and `index.json`, the CLIP matrix, and copies the pieces the update needs (`catalog.json`, `common-words.txt`, `catalog-classes.json`, `catalog-info.json`).

### Self-update

Opt-in, off by default. Choose daily, weekly or monthly in the popup, or press "Update now". An explicit press counts as consent for that one download.

- Schedule: an `alarms` alarm named `catalogUpdate` with period 1,440, 10,080 or 43,200 minutes. After the setting is turned on the first run is about a minute later. The alarm handler checks the setting again before it fetches. Turning the setting off clears the alarm.
- Query: works with at least 15 sitelinks and a date (`P577`, `P580` or `P571`) from January 1 of the year before the bundled catalog's build year onward, including future dates. The type is decided locally from the bundled class list. Then labels, years, aliases and characters are fetched in batches of 200. Works with no date are not fetched.
- Client: POST to `https://query.wikidata.org/sparql`, one query at a time, no cookies, no referrer, 90 second timeout. On HTTP 429 or a 5xx response it waits (honouring `Retry-After`, capped at 120 seconds) and tries up to 3 times, then gives up until the next interval.
- Result: the bundled catalog plus all added works are rebuilt with the same code as the Node build (`src/shared/build-index.js`). The index is written to `storage.local` as one key (`catalogIndex`) in a single `set` call, so a tab sees either the old or the new index. Open tabs swap indexes on `storage.onChanged`.
- Failure: only `catalogMeta.lastError` is written. The working index is not touched.
- When the extension itself is updated with a newer bundled catalog, the index is rebuilt offline from `catalogAdded`.
- The popup shows a line such as "25,467 titles + N new, updated 3 days ago", or the last error.

This is the only network use of the extension. A test build may ship `data/update-config.json` to redirect the update to a local mock. Release builds have no such file.

## Memory and latency

Figures from `research/REPORT.md` (i5-10500H, Chrome for Testing 157 and Zen 1.24.2b, measured with other jobs running). They apply to the models that ship: CLIP ViT-B/32 int8 and the fine-tuned MiniLM.

| Model | Chrome, 1 thread | Chrome, 4 threads | Zen, 1 thread |
|---|---|---|---|
| CLIP ViT-B/32 int8, median per image | 201 ms | 74 ms | 240 to 260 ms |
| Fine-tuned MiniLM int8, median per sentence | 17 ms | 7 ms | 22 ms |

- The report found 4 threads fastest. 6 was no better.
- The report gives a total of 380 to 520 MB for the process hosting the models and about 115 MB on disk, from earlier runs. Those figures were taken before the fine-tuned classifier replaced the frozen one. `dist/firefox` is about 134 MB today.
- The report lists "do the Tesseract workers still start under COEP" as untested when it was written.
