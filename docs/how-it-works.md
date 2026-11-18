# How it works

This page describes the browser extension (version 0.2.0). The Android port is in [android.md](android.md). It follows the same rules. The config, the decision rule and the cover wording are defined in [agents/contract.md](agents/contract.md) and are not repeated here.

## Overview

```
page  <->  content script  --messages-->  background  -->  engine (title model, OCR, classifier)
(every     |  matcher (text)               |  catalog search, catalog update, index rebuild
 frame)    |  covers, media scan           |  Firefox: event page runs the engine itself
           v                               |  Chrome: service worker + offscreen document
     storage.local  <------  settings page (own tab), popup (quick panel)
```

| Piece | File | Job |
|---|---|---|
| Content script | `src/content/content.js` | Finds posts, runs the matcher, applies the decision rule, draws covers, sends images to the background. |
| Matcher | `src/content/matcher.js` | Hash-index text matcher. Loaded before the content script. |
| Page styles | `src/content/content.css` | Hides the page until ready, dims unscanned media, hides covered content. |
| Background | `src/background/background.js` | Routes messages, catalog search, catalog update scheduling, index rebuild, 0.1 migration, shortcut and badge, starts the engine. |
| Engine | `src/background/engine.js` | Title check, OCR, spoiler classifier, priority queue. |
| OCR module | `src/background/ocr.js` | PP-OCR detection and recognition on onnxruntime. Pure functions, also run by Node tools and tests. |
| Offscreen page | `src/background/offscreen.html`, `offscreen.js` | Chrome only. Hosts the engine. |
| Catalog update | `src/background/catalog-update.js` | Opt-in Wikidata refresh, and the index rebuild that also indexes hand-added works. |
| Settings page | `src/options/` | Library, Add by hand, Blocking, Data, About. Opens in its own tab (`options_ui` with `open_in_tab`). `config.js` holds the pure config functions (migration, import, export). |
| Popup | `src/popup/` | Quick panel: cover count of the page, pause on this site, search and mark as seen, link to the settings page. |
| Shared rules | `src/shared/build-index.js`, `catalog-rules.js` | Index builder and catalog rules. Used by Node and by the extension. |

### Background: Firefox and Chrome

- **Firefox.** `manifest.json` declares a module background script (an event page). It imports `engine.js` in place, so the models run in that page. Firefox extension pages cannot be cross-origin isolated, so the models run on one thread. The event page may be asleep when a content script sends a request, so the content script retries engine requests a few times when it gets "Receiving end does not exist".
- **Chrome.** `tools/build.mjs` rewrites the manifest: the background becomes a module service worker, `offscreen` is added to the permissions, and COEP/COOP are set. Service workers cannot host the WASM runtime, so the worker creates an offscreen document (reason `WORKERS`) from `src/background/offscreen.html`. It forwards inference messages to that document with `target: 'offscreen'`. Cross-origin isolation (`cross_origin_embedder_policy: require-corp`, `cross_origin_opener_policy: same-origin`) gives that document `SharedArrayBuffer`. The engine then uses `min(4, hardwareConcurrency)` WASM threads.
- The build removes `offscreen.html` and `offscreen.js` from the Firefox output. There is no `browser` shim any more: pages use `globalThis.browser ?? globalThis.chrome`.

Message listeners, the alarm listener and the command listener are registered synchronously, so an alarm can wake a suspended page.

## Content script

It runs at `document_start` in every frame (`all_frames`, `match_about_blank`). An `about:blank` or `srcdoc` frame takes its host name from its parent.

1. **Gate.** `content.css` keeps `body` invisible until the matcher is loaded and the first scan ran (`data-sb-ready` on `<html>`). A 2.5 second timer sets the attribute anyway, so a failure never leaves a page blank.
2. **Observe.** A `MutationObserver` collects changed text nodes, `alt` and `aria-label` attributes, images, videos and elements with an inline `url(...)` style. It runs before paint. It also watches open and closed shadow roots, including roots attached after the element was first seen (a custom element that is not yet defined is retried for 30 seconds).
3. **Find the block.** For each changed text it walks up (through shadow boundaries) to a "post-like" container. Site selectors exist for X (posts, user cells, trends, DM rows and conversations, search suggestions, hover cards), YouTube (video and comment renderers, notifications, live chat messages) and Reddit. Everywhere else a generic list is used: `article`, `li`, `figure`, `blockquote`, role `article`, `row`, `listitem` or `option`, and class names containing `card`, `post`, `tweet`, `comment`, `message`, `item` or `entry`. That list is what covers direct messages, notification lists and search suggestions on other sites. A container with more than 3,000 characters of text is treated as a page section, not a post.
4. **Read the block.** Text nodes joined by newlines, plus `alt`, `aria-label` and `title` attributes, plus text inside shadow roots, plus any OCR text of the pictures the block shows now.
5. **Match.** `matcher.evaluate(text, isSeen)` returns the groups the text is about. Groups whose works are all seen are dropped.
6. **Decide.** The decision rule of the contract turns groups and picture verdicts into a cover label or nothing. A block is re-decided from what it shows now, not from what it showed before.
7. **Cover.** A `<sb-overlay>` element with a shadow root is added inside the block. It carries the label and the three buttons. The block's own children get `visibility: hidden`. The cover is a small light or dark panel (dark when the block's background is dark) with a compact one-row layout for short blocks.
   - "Show once" lasts until the text of the block changes or the page is reloaded.
   - "I've seen it" writes every work of the matched name group to `storage.local.works` in one call. Every tab then re-evaluates through `storage.onChanged`. It is absent for an unidentified image.
   - ⋮ sends `ui.openSettings`, which opens the settings page in a tab.
8. **Tab title.** `document.title` is replaced by the cover's label while the title names a covered work. This is done in the top frame only.
9. **Pause and disable.** `settings.enabled` and `settings.pausedSites` (a host and its subdomains) switch scanning off live.

### The layout rule

A cover never changes the measured size of anything. Virtualised feeds position posts by measured height, and a box that changes size shifts every post below it. So the cover is absolutely positioned inside its block with `!important` rules and size containment, content is hidden with `visibility`, not `display`, and pending media is darkened with a `filter`. The block gets `position: relative` only when it is static. There is no forced minimum height.

Verdicts are stored per picture: for each `img`, `video` or background element, the source it showed when it was judged. A cover is recomputed from the text and the verdicts of the pictures the block shows now. A recycled node therefore never keeps the cover of its previous post. A change of the `src`, `srcset` or `poster` attribute always resets the element: Firefox updates `currentSrc` only once the new picture loads, so the attribute is the earlier signal.

The toolbar badge shows the cover count of the top frame. The top frame sends `tab.count` when the count changes. The popup's count asks the top frame only.

### Known limits

Left as comments in `content.js`:

- CSS backgrounds are scanned only when set inline on an element with no element children (X and React Native Web photos). Backgrounds from a stylesheet, and hero sections with content, are not.
- Loose text directly inside a very large container is not covered. It would black out the page.
- Pending media inside shadow roots is not darkened before its verdict. It is covered after the verdict.
- Works added by a catalog update or by hand have no title rows for images, so their images only get the generic verdict.

## Storage contract

All data is in `browser.storage.local`. The settings page, popup, content script and background share it. The shapes of `works`, `custom` and `settings` are in the [contract](agents/contract.md).

| Key | Shape | Written by | Notes |
|---|---|---|---|
| `works` | `{ [id]: { state, style, title, type, year, ts } }` | settings page, popup, content script, import | Only works the user has touched. |
| `custom` | `[{ id, title, aliases, type }]` | settings page, import | Hand-added works. Ids are `custom:<n>`. |
| `settings` | see contract | settings page, popup, shortcut | |
| `catalogIndex` | `{ builtAt, bin, meta, bundle }` | background | The rebuilt index: bundled catalog, works added by updates and hand-added works. `bin` is base64. `bundle` is the `builtAt` of the bundled catalog it was built against. Removed when there is nothing to add. |
| `catalogAdded` | array of works (catalog schema) | background | Works added by updates. Used to rebuild offline after an extension upgrade. |
| `catalogMeta` | `{ lastCheck, lastSuccess, lastError, added, found, stats: { queries, bytes } }` | background | Shown on the settings page. |

- `catalogIndex` is used only when `catalogIndex.bundle` equals the current bundle's `builtAt`. Otherwise the bundled index is used. `builtAt` is the modification time of `data/catalog.json` at build time (see [agents/pitfalls.md](agents/pitfalls.md)).
- Hand-added works are indexed with a popularity of 1,000 (`CUSTOM_POP`), so they are not treated as obscure works (an obscure multi-word name must be written in Title Case). The background rebuilds `catalogIndex` whenever `custom` changes.
- **Migration from 0.1.** `seen` becomes `works` entries with `state: "seen"`, `settings.mode` becomes `settings.style`, and the old keys are removed. It runs when the background starts, when the extension is installed or updated, and again when a late 0.1-style write appears. Until then the content script reads the 0.1 keys as if they were 0.2.

### Messages

Sent with `runtime.sendMessage`.

| `type` | From | Fields | Reply |
|---|---|---|---|
| `catalog.search` | popup, settings page | `q`, `limit` | `{ results: [{ id, title, type, year }] }`. Prefix and word-start matches first, in popularity order. |
| `ui.openSettings` | content script (the ⋮ button) | none | `{ ok }`. Opens the settings page. |
| `tab.count` | content script, top frame | `blocked` | `{ ok }`. Sets the badge text of that tab. Ignored from other frames and while blocking is off. |
| `tab.stats` | popup | none | `{ blocked }`. The background asks the top frame (`frameId: 0`) of the active page, or of the most recent web page. |
| `sb.stats` | background | none | To a tab, top frame only. `{ blocked }`. |
| `catalog.update` | settings page | none | Runs one update, replies with the catalog status. |
| `catalog.status` | settings page | none | `{ bundled, total, meta, updating }`. |
| `img.check` | content script | `key`, `url`, `prio` | `{ hits: [[groupIdx, score], ...] }`. Group `-1` means a media image with no certain title. |
| `img.ocr` | content script | `key`, `url`, `prio` | `{ text }`. |
| `text.classify` | content script | `text` | `{ spoiler, p }`. |

Any failure replies `{ error }`. `prio` is `0` for an image in the viewport, otherwise it is queued behind. The toggle shortcut (`toggle-blocking`, suggested Alt+Shift+B) is a browser command, not a message: it flips `settings.enabled`.

## The matcher

`src/content/matcher.js` is plain JavaScript, loaded as a content script and also by Node. The Android build ports it to Java.

### Index

- A catalog key is a sequence of normalised tokens, up to 8 tokens. Longer keys are dropped.
- Each key is hashed to two 32-bit values. The table is one flat `Uint32Array` with open addressing, loaded as is. The file layout is `[magic, slotBits, format, ...slots]` and each slot is `hashA, hashB, value + 1`.
- Index format 1 packs a value as `group << 8 | rare << 7 | cap << 6 | common << 5 | ambiguous << 4 | other << 3 | kind`. Format 0 (`group << 7`, no `rare` or `other`) still loads.
- Lookup costs about tokens x 8 hash probes. Memory per tab is about the file size. The shipped index is 1.6 MB (`index.bin`) plus 1.7 MB (`index.json`). Every frame of a page loads its own copy, so about 3.3 MB per frame.
- `index.json` holds per-work columns (`ids`, `titles`, `types`, `years`), sorted by popularity, and `groups`: `[label, workIdx, workIdx, ...]`.

A name maps to one group: every work carrying that name. "Dune" is the book, both films and a game. "Star Wars" (derived from "Star Wars: Episode IV - A New Hope" and others) is all the films. A group is seen only when all its works are seen.

### Tokens

- A token is a run of letters and digits. `&` becomes `and`. Text is lowercased. Non-ASCII text is decomposed and its diacritics removed.
- An apostrophe splits words. A short suffix after it (`'s`, `'t`, Turkish `'i` or `'nin`) is dropped when the word before it is longer than 2 letters, so "Interstellar's" and "Breaking Bad'i" keep their tokens. French `d'` and `l'` keep the word after them. The index also holds the apostrophe-less form ("Schindlers List").

### Kinds of name

| Kind | Example | Notes |
|---|---|---|
| title | "Breaking Bad" | |
| alias | "TLOU2", "gta6" | Up to 8 per work. A single everyday word is never indexed as an alias. |
| series | "Star Wars" | Prefix before `:`, an en dash or a hyphen. Only when at least two works share it. Not derived from a single common word or fewer than 4 characters. |
| character | "Walter White" | Full multi-word names (up to 8 per work). Real people are not fetched. |
| char1 | single-token character name | Weak. Must start with a capital letter. |
| part | "Snape" from a full name | Weakest. Must start with a capital letter. Parts that are everyday words are not indexed. |
| tag | `#BreakingBad` | Matches only when written with `#`. |

When one name plays several roles, the most title-like kind wins.

Flags on a name, set by the index builder:

| Flag | Meaning |
|---|---|
| `cap` | Must be written in Title Case. Set for single-word names, names of works below 60 sitelinks and names made only of common words. |
| `common` | Made of everyday words and naming a less popular work (or a single everyday word at any popularity). |
| `rare` | A single uncommon word naming a less popular work ("Bloodborne"). Weak: it needs a media word in its sentence. |
| `ambiguous` | The catalog's own flag: a title under 4 characters, one common word, or two top-1,000 words. |
| `other` | The name's dominant meaning in Wikidata is not a work (a place, a person, a brand, scripture). Set only when that holds for every work carrying the name. |

### Decision rules

These are in `Matcher.evaluate`.

1. A tag needs the `#`. A char1 or part needs a capital first letter.
2. A "cap" name must be written in Title Case ("The Walk", "Siberia"): its first token and every token longer than 3 characters must start with a capital letter or a digit. A hashtag lifts this. Quotes do not.
3. The longest match wins. "Us" and "Last" inside "The Last of Us" are dropped. So is "Potter" inside "Harry Potter".
4. A match is weak when the name is `common`, `other` or `rare`, a char1 or part, or a short or ambiguous title (ambiguous and at most 2 tokens, or one token of 3 characters or fewer). A strong match is accepted at once.
5. A weak match is accepted without further tests when another, different name of the same group is in the text. It is also accepted when it is in a hashtag or in quotes, unless it is an `other` name: a hashtag or quotes are no evidence for "#Palestine" or a song title.
6. Anything else needs a capitalised first letter, and a part name stops here. What follows looks only inside the name's own sentence (a sentence ends at `.`, `!`, `?` or a line break, except after an ordinal like "2."). A media word must fit the work's type: "game" corroborates a game, not a film, and "Nintendo Switch" says nothing about a film called "Switch". The words are in the `CONTEXT` table of `matcher.js`: English, plus Turkish (with suffix stems), Spanish, Portuguese, German, French and Italian.
   - An `other` name takes only a fitting media word within 3 tokens. If it is also an everyday word at the start of a sentence, only a media word right next to it.
   - Otherwise a release year of one of its works in the same sentence is enough.
   - An everyday-word name at the start of a sentence needs a second capitalised word of 3 or more letters ("The Bear", not "Marley and Me"), or else a media word right next to it.
   - A single everyday word takes a fitting media word within 3 tokens.
   - Other weak names take a fitting media word anywhere in their sentence.
7. A group whose works are all inside another matched group adds nothing.

### Sequel numbers

At build time, names with Roman or Arabic sequel numbers from 2 to 20 are written both ways ("Grand Theft Auto VI" and "grand theft auto 6"). For two-token names the joined forms are also indexed ("gta6", "gtavi"). "I" is never a numeral, and a numeral only counts after another word. A numbered name of a popular work, or a non-everyday short word plus a number, may match in any case. "Chapter 6" and "Windows 11" still need corroboration.

### Known limit

A single-word title at the start of a sentence, with no media word in that sentence, goes unmatched.

## Styles

A work's effective style is its own `style`, or `settings.style` when it has none. The contract has the full rule. In short:

| Style | Text-only match | Image-only match |
|---|---|---|
| `all` (default) | Covered at once: "Mentions {t}". | Covered. |
| `spoilers` | Covered while the classifier runs ("Checking {t} for spoilers…"), then kept only if it says spoiler. Covered if the classifier fails. | Covered ("Image from {t}"), whatever the style. |

In `spoilers` style a bare title mention is shown once the classifier clears it, so a trailer title is not hidden.

### The classifier

- Model: `sentence-transformers/all-MiniLM-L6-v2`, fine-tuned end to end with mean pooling and one linear output. Int8 ONNX, about 23 MB (`models/spoiler/model_int8.onnx`).
- The text is split into sentences (`.`, `!`, `?`, newlines). At most 16 sentences are scored. `@handles` are removed. Sentences of 3 characters or fewer are skipped.
- Each sentence is scored alone (64 tokens max), because the int8 model quantises activations per tensor and batching would shift the scores. The post's score is the highest sentence score. A single spoiler sentence is not diluted by the rest.
- The post is a spoiler when `sigmoid(max logit) >= threshold`. The threshold is in `models/spoiler/meta.json` (0.75). It was chosen by balanced accuracy on a validation split, not on an evaluation set.
- Training data (`tools/train-spoiler.mjs`): hand-written sentences, hand-written patterns filled with catalog titles, hand-written look-alike non-spoilers (death and betrayal words about real life, players and viewers, premises, production talk), Reddit comments (CC BY-SA 3.0) and English Wikipedia sentences of 300 popular works (CC BY-SA 4.0): late plot sentences as spoilers, premise, production and reception sentences as non-spoilers.
- Cost: about 12 ms per sentence in Node with one thread (the image work's figure). `tools/eval-spoiler.mjs` printed 14 ms per post on one run and 39 ms on another with the machine busy.
- Classification has the highest queue priority, ahead of images.

Results are in the [README](../README.md#status-and-known-limits). `all-MiniLM-L12-v2` was tried as the base and was no better on validation, slower and larger. The AUC on `spoiler-eval.jsonl` was likely optimistic in 0.1 because the training patterns resembled its "implied" posts; `spoiler-eval2.jsonl` was added as a second check, with the caveat given in the README.

## Images and video

Media scanning is controlled by `settings.scanImages`. Until an image has a verdict it is drawn as a dark placeholder (`filter` in `content.css`).

### Content script side

- Images, videos and inline-style background photos are queued for scanning when they come within one viewport height of the screen (`IntersectionObserver`, `rootMargin: 100% 0px`).
- An image is skipped when either side is under 96 px (natural size or displayed size). Only `http(s)`, `data` and `blob` sources are scanned.
- Readable images (same-origin, CORS, blob) are redrawn to a canvas of at most 768 px on the long side and sent as a JPEG data URL. Cross-origin images and CSS backgrounds are sent as a URL, and the background fetches them with the extension's host permission and without credentials.
- Both verdicts are required before the image is revealed: title check and OCR. An engine error or a 60 second silence (a safety net for a lost message) reveals the image and is counted in `data-sb-stats`.
- Video: the `poster` is scanned. During playback a frame (at most 448 px) is scanned at most every 5 seconds. If a frame turns out covered, the video is paused. A video stays a placeholder until its first frame has a verdict. Videos from other origins without CORS cannot be sampled, so only the poster and the surrounding text count.
- OCR text is added to the block's text and the matcher runs again. A title verdict of a group or "unknown" is kept per picture.

### Engine side

Requests go through one priority queue, lowest number first. Order: classifier (-1), in-viewport title check (0), its OCR (1), off-screen title check (2), its OCR (3). Title checks waiting at the same priority run as one batch of up to 4, which shares the cost of restoring the weights on every run. Downloaded images are kept in a small cache (24 entries) so OCR reuses the title check's download. Title verdicts are cached (2,000 entries).

**Title verdict** (`verdict` in `engine.js`):

1. The whole image is squashed to 256 x 256 (no crop) and normalised with mean 0.5 and standard deviation 0.5.
2. Run the SigLIP 2 base/32 vision tower and take `pooler_output`, normalised.
3. Compute `neg`: the best cosine to the 33 generic prompts ("a photo", "a selfie", "a meal on a plate" and so on).
4. Score the image against the title matrix (2,000 rows, int8). Each row is the normalised mean of 3 prompts for the work's type ("the poster of the movie {t}" and so on) and, for works that have them, 2 character prompts ("{c} from {t}").
5. A row names a title when its score is at least `minScore`, beats `neg` by `margin`, and beats the best row of an unrelated title family by `titleGap`. A family is the rows whose groups share a work, so the "Star Wars" row and the "Episode IV" row count as one. The result is up to 3 groups of that family that also clear the margin.
6. Otherwise, if the best of the 20 media prompts ("a movie poster", "a scene from a TV series" and so on) beats `neg` by `mediaGate`, the result is group `-1`: media with no certain title. It covers only when `settings.unknownImages` is on, and it is never offered as "I've seen it".

Cut-offs, set in `tools/build.mjs` (`CUT`) and stored in `data/clip-meta.json` with the preprocessing constants:

| Name | Value |
|---|---|
| `minScore` | 0.1161 |
| `margin` | 0.061 |
| `titleGap` | 0.0275 |
| `mediaGate` | 0.0514 |
| rows (`--clip-n`) | 2000 |

They come from `tools/calibrate-clip.mjs`, which fits them on all calibration images and reports a two-fold split (media images split by work, ordinary photos by file name) so that the reported result is held out. The held-out total is in the README. The shipped values are fitted on all images including the fixtures, so the fixture figures are not held out.

The title tower's weights are quantised to int8 and the activations stay fp32. Ordinary int8 quantisation of activations breaks this model (see [agents/pitfalls.md](agents/pitfalls.md)). `tools/quantize-vision.mjs` does it at build time, without Python, from a pinned fp32 download. Restoring the weights costs time on every run. Folding them to fp32 at load is one setting in `engine.js` (`disable_quant_qdq`): the image work measured it faster (Chrome 142 ms and Zen 431 ms per image) but about 980 and 910 MB of process memory. It is not enabled.

Works added by a catalog update or by hand have no title rows, so their images only get the generic verdict.

**OCR** (`src/background/ocr.js`): PaddleOCR v5 mobile, a detector and an English recogniser, as ONNX files from RapidOCR, on onnxruntime-web. Steps:

1. The image is scaled to at most 1280 px on the long side, then to a detector input with the long side at most 960 and the short side at least 384 (small thumbnails are upscaled), in multiples of 32.
2. The detector's probability map is thresholded at 0.3. Each connected component with at least 4 px on its short side and a mean probability of at least 0.6 becomes an axis-aligned box, grown by the DB "unclip" ratio of 1.6.
3. Each box is cut out, scaled to 48 px high (at most 960 wide) and recognised. A line counts when the mean character probability is at least 0.6.
4. Lines are sorted into rows and read top to bottom, left to right.

There is no worker and no time limit in the engine. Rotated text reads worse because the boxes are not rotated (a `shortcut` comment in `ocr.js`). The output goes to the same text matcher as any other text.

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
| `characters` | Up to 8 character names of two or more words, not real people. Only for works with at least 40 sitelinks. |
| `pop` | Sitelink count. |
| `ambiguous` | True for a title under 4 characters, one common word, or two top-1,000 words. |
| `other` | Optional. The title, aliases, characters or series prefix of this work whose dominant sense in Wikidata is not a work. |

The shipped catalog has 24,670 works (14,994 films, 2,928 games, 2,876 books, 2,837 series, 465 manga, 424 anime, 146 comics). 2,866 of them have an `other` list. When a work fits several types, the first of anime, tv, movie, game, manga, comic, book wins. Works need at least 15 sitelinks. The film series class is excluded.

The catalog keeps works that are told as a story. A work is dropped when its instance-of, genre or form (P31, P136, P7937) is on an explicit list of scripture, reference works, non-fiction, documentaries, news and talk shows (`NOT_NARRATIVE` in `src/shared/catalog-rules.js`), unless it is also a novel, short story, play, fiction or a fiction film genre. This dropped 797 works from the 0.1 catalog.

`other` is computed by looking up each name (title, aliases, characters, series prefix) on Wikidata: an item with the same English or `mul` label or alias, more sitelinks than the work, and a class that is not a work, a franchise, a character or a disambiguation page. `tools/catalog/20k.txt` is the common-word list behind `ambiguous` and the index rules.

`npm run build` compiles the catalog into `index.bin` and `index.json`, the title matrix, and copies the pieces the update needs (`catalog.json`, `common-words.txt`, `catalog-classes.json`, `catalog-info.json`). `catalog-classes.json` also has a `sameSense` list: the classes that count as "a work or a fictional thing" for the `other` lookup.

### Self-update

Opt-in, off by default. Choose daily, weekly or monthly on the settings page (Data), or press "Update now". An explicit press counts as consent for that one download.

- Schedule: an `alarms` alarm named `catalogUpdate` with period 1,440, 10,080 or 43,200 minutes. After the setting is turned on the first run is about a minute later. The alarm handler checks the setting again before it fetches. Turning the setting off clears the alarm.
- Query: works with at least 15 sitelinks and a date (`P577`, `P580` or `P571`) from January 1 of the year before the bundled catalog's build year onward, including future dates. The type is decided locally from the bundled class list. Then labels are fetched in batches of 200. Works with no date are not fetched. Works that are not told as a story are dropped, by one more query per 200 works. Then years, aliases and characters are fetched.
- The `other` lookup: names go to Wikidata in batches of 150, a label query and, for names of one or two words, an alias query. At most 20 queries per update. When the budget runs out or Wikidata fails, a name that was not looked up is treated as `other` if it has one or two words. That is the fail-safe: a wrongly weak title costs less than a wrongly covered news post.
- Client: POST to `https://query.wikidata.org/sparql`, one query at a time, no cookies, no referrer, 90 second timeout. On HTTP 429 or a 5xx response it waits (honouring `Retry-After`, capped at 120 seconds) and tries up to 3 times, then gives up until the next interval.
- Result: the bundled catalog, all added works and the hand-added works are rebuilt with the same code as the Node build (`src/shared/build-index.js`). The index is written to `storage.local` as one key (`catalogIndex`) in a single `set` call, so a tab sees either the old or the new index. Open tabs swap indexes on `storage.onChanged`.
- Failure: only `catalogMeta.lastError` is written. The working index is not touched.
- When the extension itself is updated with a newer bundled catalog, the index is rebuilt offline from `catalogAdded` and `custom`.
- The settings page shows a line such as "24,670 titles + N new · updated 3 days ago", or the last error.

This is the only network use of the extension. A test build may ship `data/update-config.json` to redirect the update to a local mock. Release builds have no such file.

A first catalog build (`tools/catalog/build.mjs`) sends up to about 800 more queries than before for the `other` lookup: the names go into 400 fixed buckets, each with one or two queries. Results are cached by query text.

## Memory and latency

Figures are from the image work (Chrome for Testing and Zen on an i5-10500H, measured with other jobs running, good to about 30 percent). They apply to the models that ship now: SigLIP 2 base/32 with int8 weights, PP-OCR and the fine-tuned MiniLM. They were not re-run for this page.

| | Chrome, 4 threads | Zen, 1 thread |
|---|---|---|
| Title check, per screenful of images | 197 ms | 482 ms |
| OCR, per screenful of images | 175 ms | 341 ms |
| Process memory | 467 MB | 351 MB |

- `dist/firefox` is about 160 MB (162 MB measured by the image work).
- `research/REPORT.md` predates these models. Read its image sections as research notes, not as a description of the shipped build.
- `tools/bench-engine.mjs` measures the real engine inside the built extension.
