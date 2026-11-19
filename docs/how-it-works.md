# How it works

This page describes the browser extension (version 0.2.3). The Android port is in [android.md](android.md). It follows the same rules. The config, the decision rule and the cover wording are defined in [agents/contract.md](agents/contract.md) and are not repeated here.

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
4. **Read the block.** Text nodes joined by newlines, plus `alt`, `aria-label` and `title` attributes, plus text inside shadow roots. The post's own text is read first. Any OCR text of the pictures the block shows now follows it behind one U+0001 character (`own text` + `\u0001` + `OCR text`, contract rule 8). `domText` strips U+0001 from the page's own text, so a page cannot pose as OCR text.
5. **Match.** `matcher.evaluate(text, isSeen)` returns the groups the text is about, own-text groups first, then groups named only by OCR text (see [The matcher](#the-matcher)). Groups whose works are all seen are dropped. When the block has pictures, the post's own text is also evaluated alone (`own`), so the decision knows what the typed text names.
6. **Decide.** The decision rule of the contract turns groups and picture verdicts into a cover label or nothing (`decide` in `content.js`). Rule 7 is applied here: the image model's title (`img`) is dropped when `own` names any work, seen or not, and per picture when that picture's OCR text names a work; a block whose own text names a seen work and no covered one is not covered by its pictures, and `Possible film, show or game image` is not shown for it. A block is re-decided from what it shows now, not from what it showed before. The text sent to the classifier has the marker replaced by a line break.
7. **Cover.** A `<sb-overlay>` element with a shadow root is added inside the block. It carries the label and the three buttons. The block's own children get `visibility: hidden`. The cover is a small light or dark panel with a compact one-row layout for short blocks. It is dark when the nearest opaque background above the block is dark. When there is none (`isDark` in `content.js`), the canvas colour decides: the page's `color-scheme`, read from the computed property or, when that is `normal`, from `<meta name="color-scheme">` (a meta tag leaves the property at `normal`). A page that allows both schemes follows the system setting; a page that allows only dark is dark under a light system, and the other way round.
   - "Show once" is remembered for the post, not for the element that draws it. It is keyed by the post's own text with whitespace collapsed (never the OCR text), or, for a post with no text, by the sources of its pictures. The keys live in one set (`shown` in `content.js`) for the life of the page, the oldest dropped after 500. It survives a recycled or rebound node and late picture verdicts. Two posts with identical text share the choice.
   - "I've seen it" on a name group with one work writes it to `storage.local.works` at once. With several works (a franchise, an original and its remake) it opens the picker (`seenClicked`): a modal `<dialog>` inside the cover's shadow root, so it sits in the top layer and changes no layout. It is titled "Which have you seen?", lists the works not yet seen of every group the cover names with `{type} · {year}`, has nothing ticked at first, and offers All (the first section only), Cancel and Mark seen. A second section, "More from this series" (`moreFromSeries` in `content.js`, which asks `Matcher.moreFromSeries`), lists the other works of the same catalog series that are not yet seen, oldest first, six shown and the rest behind "Show N more", with its own "All N"; ticking them is optional and does not decide whether the post stays covered. The note names the group, or says "This post names several works..." when the cover names several. A group of one work never opens the picker, so it never shows the second section. Escape closes it and focus returns to the button. Only the ticked works are written, in one call (`markWorks`). Every tab then re-evaluates through `storage.onChanged`. The button is absent for an unidentified image.
   - ⋮ sends `ui.openSettings`, which opens the settings page in a tab.
8. **Tab title.** `document.title` is replaced by the cover's label while the title names a covered work. This is done in the top frame only.
9. **Pause and disable.** `settings.enabled` and `settings.pausedSites` (a host and its subdomains) switch scanning off live.
10. **Settings changes.** `rescanAll` re-checks covered blocks in place (`scanBlock(b, true)`), so a cover that stays keeps its element and the keyboard focus inside it; only a block that is gone is released. Then it collects the page again.

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
- Index format 3 is format 2 plus the type-narrowed names above (the key carries `\u0002` and the type; the value is the same). Index format 2 packs a value as `group << 9 | ocr << 8 | rare << 7 | cap << 6 | common << 5 | ambiguous << 4 | other << 3 | kind`. Format 1 (`group << 8`, no `ocr`) and format 0 (`group << 7`, no `rare`, `other` or `ocr`) still load, with the missing bits read as 0.
- Lookup costs about tokens x 8 hash probes. Memory per tab is about the file size. The shipped index is 1.6 MB (`index.bin`, 1,572,876 bytes) plus 1.8 MB (`index.json`, about 1.78 MB: it grew by about 30 KB with the series lists). Every frame of a page loads its own copy, so about 3.4 MB per frame.
- `index.json` holds per-work columns (`ids`, `titles`, `types`, `years`), sorted by popularity, `groups`: `[label, workIdx, workIdx, ...]`, and `series`: one list of work indices per catalog series with two or more works, oldest first (works with no year last), in order of each series' most popular work. `Matcher.moreFromSeries(groups)` returns the other works of the series that contain any work of the given groups, oldest first; the caller drops seen works.

A name maps to one group: the works it refers to (`closest` in `build-index.js`). The index builder records for each name which works carry it at which tier: 0 a title, 1 an alternative name (alias), 2 the series the name was derived from, 3 a character, 4 a part of a character's name. A bare name refers to its closest tier only. "Half-Life" is the 1998 game, not "Half-Life: Alyx". "Star Wars" is an alternative name of Episode IV and a derived series name, so it takes the works titled "Star Wars: ..." (films, games and shows). Franchise exception: the name also takes its series (tier 2) when the closest works are themselves entries of that series, or when the series' best work is at least 1.5 times as popular as the closest one ("Halo": a TV series titled "Halo" and the games "Halo 2", "Halo 3" and others). A type word right next to the name (before or after it, no sentence break between) narrows the group to the works of that type among the name's works: "the Minecraft movie", "Assassin's Creed game", "Assassin's Creed oyunu" (the type words are `TYPE_WORDS` in `matcher.js`, with English, Spanish, Portuguese, German, French, Italian and Turkish forms; "series" is not a type word). The narrowed group is stored in the index under the name plus `\u0002` and the type (index format 3), so a name next to a type word costs one more probe. A group is seen only when all its works are seen. The odd results this produces are listed in the [README](../README.md#status-and-known-limits) ("Call of Duty" is only the 2003 game, "Pokémon" only the 1997 anime, "Harry Potter" the books and the 2026 series but not the films). `test/fixtures/franchises.json` holds the reviewed answers for 28 names.

### Tokens

- A token is a run of letters and digits. `&` becomes `and`. Text is lowercased. Non-ASCII text is decomposed and its diacritics removed.
- An apostrophe splits words. A short suffix after it (`'s`, `'t`, Turkish `'i` or `'nin`) is dropped when the word before it is longer than 2 letters, so "Interstellar's" and "Breaking Bad'i" keep their tokens. French `d'` and `l'` keep the word after them. The index also holds the apostrophe-less form ("Schindlers List").

### Kinds of name

| Kind | Example | Notes |
|---|---|---|
| title | "Breaking Bad" | |
| alias | "TLOU2", "gta6" | Up to 8 per work. A single everyday word is never indexed as an alias. |
| series | "Star Wars", "Battlefield" | Prefix before `:`, an en dash or a hyphen, when at least two works share it. Also a name that is numbered in three or more titles ("Battlefield 3", "Battlefield 4", "Battlefield V"). Not derived from a single common word or fewer than 4 characters. The part after the colon (a subtitle) is not indexed on its own; only the full title is. Since 0.2.3 a subtitled title joins a series that is numbered elsewhere even when the prefix is one everyday word ("Halo: Reach" joins the series "Halo" of "Halo 2" and "Halo 3"). |
| character | "Walter White" | Full multi-word names (up to 8 per work). Real people are not fetched. |
| char1 | single-token character name | Weak. Must start with a capital letter. |
| part | "Snape" from a full name | Weakest. Must start with a capital letter. Parts that are everyday words are not indexed. |
| tag | `#BreakingBad` | Matches only when written with `#`. |

When one name plays several roles, the most title-like kind wins.

Flags on a name, set by the index builder:

| Flag | Meaning |
|---|---|
| `cap` | Must be written in Title Case. Set for single-word names, names of works below 60 sitelinks and names made only of common words. |
| `common` | Made of everyday words and naming a less popular work (or a single everyday word at any popularity). Since 0.2.3 a name of two or more words is not `common` (and not `ambiguous`) when its combined popularity is 60 or more (`COMMON_POP`): the sitelinks of the works it titles, its alternative names, its derived series and its numbered or subtitled sequels ("Dark Souls II", "Dark Souls: Remastered") added up (`fame` in `build-index.js`). No single "Resident Evil", "God of War", "Dark Souls" or "Silent Hill" work reaches 60, so "Resident Evil is scary" used to match nothing. Two exceptions stay: "The" plus one word ("THE FALL OF CONSTANTINOPLE"), and a name with no later word of 3 or more letters. A bare number ("10.5", "1917") is `common` too: it needs a media word, quotes or a hashtag. "Everyday" means the first 1,000, 3,000 or 10,000 lines of `tools/catalog/common-words.txt` (the English 20k list, most frequent first) for the finer rules, and any line of it for the rest. Since 0.2.2 the file also holds subtitle words of six more languages (see [Catalog](#catalog)). |
| `rare` | A single uncommon word naming a work with fewer than 45 sitelinks (`DISTINCT_POP`; "Bloodborne"). Weak: it needs a media word in its sentence. From 45 sitelinks up such a word ("Minecraft", "Arcane") is not `rare`: it is a title however it is written. |
| `ambiguous` | The catalog's own flag: a title under 4 characters, one common word, or two top-1,000 words. |
| `other` | The name's dominant meaning in Wikidata is not a work (a place, a person, a brand, scripture). Set only when that holds for every work carrying the name. |
| `ocr` | Strong enough to count in text read from pictures. See [Text read from pictures](#text-read-from-pictures). |

### Decision rules

These are in `Matcher.evaluate`.

1. A tag needs the `#`. A char1 or part needs a capital first letter.
2. A "cap" name must be written in Title Case ("The Walk", "Siberia"): its first token and every token longer than 3 characters must start with a capital letter or a digit. A hashtag lifts this. Quotes do not. All-lowercase text therefore still needs a capital, even for a distinctive single word.
3. The longest match wins, whether or not its group is seen. "Us" and "Last" inside "The Last of Us" are dropped. So is "Potter" inside "Harry Potter". A seen longer name still consumes the shorter name inside it.
4. A match is weak when the name is `common`, `other` or `rare`, a char1 or part, or a short or ambiguous title (ambiguous and at most 2 tokens, or one token of 3 characters or fewer), or when it is case-only (see "Case evidence" below). A strong match is accepted at once.
5. A weak match is accepted without further tests when another, different name of the same group is in the text. It is also accepted when it is in a hashtag or in quotes, unless it is an `other` name: a hashtag or quotes are no evidence for "#Palestine" or a song title. Since 0.2.3 a hashtag alone does not make a single word that is everyday, ambiguous or obscure a title ("#verity"); a distinctive tag still counts, and so do quotes. A name also counts when it lies inside the title of another matched name's work and shares no word with that name ("Fallout" and "New Vegas"; not "Castle" and "Castle Rock").
6. Anything else needs a capitalised first letter, and a part name stops here. What follows looks only inside the name's own sentence (a sentence ends at `.`, `!`, `?` or a line break, except after an ordinal like "2."). A media word must fit the work's type: "game" corroborates a game, not a film, and "Nintendo Switch" says nothing about a film called "Switch". The words are in the `CONTEXT` table of `matcher.js`: English, plus Turkish (with suffix stems), Spanish, Portuguese, German, French and Italian.
   - An `other` name takes only a fitting media word within 3 tokens. If it is also an everyday word at the start of a sentence, only a media word right next to it.
   - Otherwise a release year of one of its works in the same sentence is enough.
   - An everyday-word name at the start of a sentence needs a second capitalised word of 3 or more letters ("The Bear", not "Marley and Me"), or else a media word right next to it.
   - A single everyday word takes a fitting media word within 3 tokens.
   - Other weak names take a fitting media word anywhere in their sentence.
   - A case-only match (below) takes only a media word right next to it, or a type word of its works within the next 3 words of its sentence ("Until Dawn | FULL HORROR GAME": 0.2.3; a name whose capitals prove nothing and that is not already accepted otherwise).
   - A bare number never matches a numeric title on its own: it needs quotes or another name of its work (".45" against YouTube's spoken "45 minutes"; 0.2.3). A hashtag does not lift it.
   - In a line that already names a work, a single everyday word takes only a media word joined to it by a space (before or after it) or a type word. The matcher judges the names that are not everyday words first, and a line is "named" by an accepted one. "DmC: Devil May Cry - All Boss Fights & Ending (No Damage" no longer adds the films "No" and "Damage" (0.2.3; a line is ended by a line break or the OCR marker; `test/catalog.test.js` has the DmC case).
   - Music titles: when the post's own text has "ft.", "feat.", "prod.", "official (music) video" or "audio", "music video", "lyric video", "(lyrics)" or Turkish "klip" (`MUSIC` in `matcher.js`), a single-word name matches only with quotes, a distinctive hashtag or another name of the same work. "Joker ft. Defkhan, Kurşun - Son Kale | official video" is a song, not the film "Joker" (0.2.3).
7. A group whose works are all inside another matched group adds nothing.
8. The result is ordered by label tier: groups the post's own text names first, then groups named only by OCR text; within a tier the group matched by the longer name first, then the more popular work (the index sorts groups by popularity). Groups whose works are all seen are dropped, and when the own text names only seen works the OCR-only groups are dropped too.

Media words: `series`, `serie`, `serien` and the Turkish `serisi`, `serinin` and `seriye` count for every work type. Video-title words are weak media words (a `YT` bit in `CONTEXT`): `review`, `reaction`, `soundtrack`, `ost`, `lore`, `recap`, `breakdown`, `masterpiece`, `remastered`, Turkish `inceleme`, and for games `walkthrough` and `mods`. A name flagged `common` never takes them ("Switch 2 Review" does not cover a film called "Switch"). `actor`, `actress` and `acting` are not media words any more.

### Case evidence

In an ALL-CAPS run of two or more words, or on a Headline Case line (at least 4 words of 4 or more letters, 70 percent of them capitalised: "Grace Ashcroft's Voice Actress Reacts to Thirst Comments"), capital letters prove nothing (`caseless` in `matcher.js`; the post's own text only). There a name that relies on case needs a media word right next to it. That is a Title-Case name that is a single word or two everyday words and that is `common`, ambiguous, `rare` or `other`: "KES", "Thirst", "The Master". A distinctive single word does not rely on case: a word that is not an everyday word in any shipped list, not `other`, naming a work with at least 45 sitelinks ("Minecraft", "Arcane") is a title however it is written, in a headline or in capitals.

### Text read from pictures

The caller passes OCR text after the post's own text behind one U+0001 character (contract, rule 8). The matcher treats the part after the marker like this:

- A name counts only if the index marks it `ocr` (strong). The builder sets that bit for a title, alias or multi-word character name written as it is in the catalog (not a sequel-number swap or a joined form such as "gta6"), with at least two tokens, that is not `other`, and one of: at least two real words (3 or more letters, not `the`, `and` and the like; for a less popular work the name must also not be ambiguous); one real word that is not an everyday word in a name of a work with at least 60 sitelinks (`COMMON_POP`; "The Mandalorian" has 55, so "THE MANDALORIAN" does not match from picture text); or a sequel-numbered title with a word of 4 or more letters outside the 3,000 most frequent ("BATTLEFIELD 4"; "GEN 5" exists only as the swapped form of "Gen V" and does not count).
- Never a single word: a thumbnail that only says MINECRAFT matches nothing. Case, quotes and hashtags are not looked at.
- A name never crosses the marker, and a sentence ends at it, so a media word in OCR text does not corroborate a name in the post's own text, and a media word in the own text does not confirm an OCR name. OCR text never corroborates a weak own-text name through another name of the same group either.
- When the own text names only seen works, OCR-only groups do not cover (contract, rule 7).

Why so strict: thumbnail text is all capitals, full of logos, timers and shouty phrases, so a single OCR word is nearly always noise. The figures are in the README (`tools/fp-ocr.mjs`).

### Sequel numbers

At build time, names with Roman or Arabic sequel numbers from 2 to 20 are written both ways ("Grand Theft Auto VI" and "grand theft auto 6"). For two-token names the joined forms are also indexed ("gta6", "gtavi"). "I" is never a numeral, and a numeral only counts after another word. A numbered name of a popular work, or a non-everyday short word plus a number, may match in any case. "Chapter 6" and "Windows 11" still need corroboration.

### Known limits

- Some bare franchise names refer to a single work or to no work ("Call of Duty", "Terminator"); see the README.
- A single-word title at the start of a sentence, with no media word in that sentence, goes unmatched.
- An everyday-word title with no media word near it ("Dune Was Incredible", "Why Lost Failed") goes unmatched.
- A single word in picture text goes unmatched.
- Everyday words that are in none of the word lists (Vertigo, Scrubs) count as distinctive: "I bought new Scrubs for work" is matched to the series.
- A few non-fiction names still match.

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
- OCR text is added to the block's text after the post's own text, behind one U+0001 character, and the matcher runs again (see [Text read from pictures](#text-read-from-pictures)). A title verdict of a group or "unknown" is kept per picture. `mediaInfo` drops a picture's model title when that picture's own OCR text names a work (rule 7); `decide` drops all model titles when the post's own text names one.

### Engine side

Requests go through one priority queue, lowest number first. Order: classifier (-1), in-viewport title check (0), its OCR (1), off-screen title check (2), its OCR (3). Title checks waiting at the same priority run as one batch of up to 4, which shares the cost of restoring the weights on every run. Downloaded images are kept in a small cache (24 entries) so OCR reuses the title check's download. Title verdicts are cached (2,000 entries).

**Title verdict** (`verdict` in `engine.js`):

1. The whole image is squashed to 256 x 256 (no crop) and normalised with mean 0.5 and standard deviation 0.5. The resize is done in plain JavaScript (`squashCHW` in `src/background/pixels.js`, a triangle filter like PIL's antialiased bilinear, which SigLIP's own processor uses) on the decoded pixels, not by the canvas: the canvas scaling filters of Chrome and Firefox differ. With the canvas the score of an image differed between browsers by up to 0.010; with `pixels.js` by at most 0.0013 (median 0). A run on one browser is bit-identical, and a batch of 4 gives the same scores as single images. `tools/calibrate-clip.mjs`, Android (`Images.visionPixels`) and the tests use the same computation. (Images over 2048 px are first scaled down by the canvas.)
2. Run the SigLIP 2 base/32 vision tower and take `pooler_output`, normalised.
3. Compute `neg`: the best cosine to the 33 generic prompts ("a photo", "a selfie", "a meal on a plate" and so on).
4. Score the image against the title matrix (2,000 rows, int8). Each row is the normalised mean of 3 prompts for the work's type ("the poster of the movie {t}" and so on) and, for works that have them, 2 character prompts ("{c} from {t}").
5. A row names a title when its score is at least `minScore`, beats `neg` by `margin`, and beats the best row of an unrelated title family by `titleGap`. A family is the rows whose groups share a work, so the "Star Wars" row and the "Episode IV" row count as one. The result is up to 3 groups of that family that also clear the margin.
6. Otherwise, if the best of the 20 media prompts ("a movie poster", "a scene from a TV series" and so on) beats `neg` by `mediaGate`, the result is group `-1`: media with no certain title. It covers only when `settings.unknownImages` is on, and it is never offered as "I've seen it".

Cut-offs, set in `tools/build.mjs` (`CUT`) and stored in `data/clip-meta.json` with the preprocessing constants:

| Name | Value |
|---|---|
| `minScore` | 0.1355 |
| `margin` | 0.077 |
| `titleGap` | 0.015 |
| `mediaGate` | 0.0516 |
| rows (`--clip-n`) | 2000 |

They come from `tools/calibrate-clip.mjs`, which fits them on all calibration images and reports a two-fold split (media images split by work, ordinary photos by file name) so that the reported result is held out. The held-out total is in the README. The shipped values are fitted on all images including the fixtures, so the fixture figures are not held out. They were recalibrated after the merged catalog and the `pixels.js` resize landed. The calibration is noisy: the two folds pick very different cut-offs (for example `titleGap` 0 on one and 0.0325 on the other), so a small change in the data moves the held-out result by a few images.

The title tower's weights are quantised to int8 and the activations stay fp32. Ordinary int8 quantisation of activations breaks this model (see [agents/pitfalls.md](agents/pitfalls.md)). `tools/quantize-vision.mjs` does it at build time, without Python, from a pinned fp32 download. Restoring the weights on every run costs time, so since 0.2.1 the engine folds them to fp32 once at load (`disable_quant_qdq` in `engine.js`). The scores are identical (same weights; `tools/bench-stats-diff.mjs` shows a spread of 0 on the 87 fixture images in both browsers). One image alone went from 403 to 175 ms in Chrome and from 629 to 448 ms in Zen; the Chrome extension process went from 481 to 991 MB. Remove the setting to trade the speed back for memory.

Works added by a catalog update or by hand have no title rows, so their images only get the generic verdict.

**OCR** (`src/background/ocr.js`): PaddleOCR v5 mobile, a detector and an English recogniser, as ONNX files from RapidOCR, on onnxruntime-web. Steps:

1. The image is scaled to at most 1280 px on the long side, then to a detector input with the long side at most 960 and the short side at least 384 (small thumbnails are upscaled), in multiples of 32.
2. The detector's probability map is thresholded at 0.3. Each connected component with at least 4 px on its short side and a mean probability of at least 0.6 becomes an axis-aligned box, grown by the DB "unclip" ratio of 1.6.
3. Each box is cut out, scaled to 48 px high (at most 960 wide) and recognised. A line counts when the mean character probability is at least 0.6.
4. Lines are sorted into rows and read top to bottom, left to right.

There is no worker and no time limit in the engine. Rotated text reads worse because the boxes are not rotated (a `shortcut` comment in `ocr.js`). The output goes to the same text matcher as any other text.

## Catalog

### Format

`data/catalog.json` is `{ "version": 1, "series": {...}, "works": [...] }`, sorted by popularity (Wikidata sitelink count), highest first. Each work:

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
| `series` | Optional (0.2.3). Ids of the series or franchises the work belongs to, keys of the top-level `series` table. |

The top-level `series` table maps a series id (a Wikidata QID) to `[label, ...the Wikidata series ids rolled up into it]`; it has 1,503 entries. The shipped catalog has 24,609 works (14,956 films, 2,928 games, 2,876 books, 2,814 series, 465 manga, 424 anime, 146 comics; counted in `data/catalog.json`). 2,862 of them have an `other` list. The 0.2.0 catalog had 24,670 (14,994 films, 2,837 series, 2,866 with an `other` list). When a work fits several types, the first of anime, tv, movie, game, manga, comic, book wins. Works need at least 15 sitelinks. The film series class is excluded.

The catalog keeps works that are told as a story. A work is dropped when its instance-of, genre or form (P31, P136, P7937) is on an explicit list of scripture, reference works, non-fiction, documentaries, news and talk shows (`NOT_NARRATIVE` in `src/shared/catalog-rules.js`), unless it is also a novel, short story, play, fiction or a fiction film genre. This dropped 797 works from the 0.1 catalog. Since 0.2.2 the list also holds contests (music competitions), award ceremonies, game and quiz shows, variety and sketch shows, albums and music videos, which removed 61 more works (38 films and 23 series, net: the count went from 24,670 to 24,609). Reality competitions and talent shows are kept on purpose, because their results are spoilers (`NARRATIVE` lets them through). A work of such a class that is left out is also a sense of its own in the `other` lookup, so a name shared with it can be `other`.

`other` is computed by looking up each name (title, aliases, characters, series prefix) on Wikidata: an item with the same English or `mul` label or alias, more sitelinks than the work, and a class that is not a work, a franchise, a character or a disambiguation page. `tools/catalog/common-words.txt` is the common-word list behind `ambiguous` and the index rules. `tools/catalog/words.mjs` builds it: the English list `20k.txt` (most frequent first; the index rules use its first 1,000, 3,000 and 10,000 lines), then the 5,000 most frequent subtitle words of each of English, Turkish, Spanish, Portuguese, German, French and Italian from `hermitdave/FrequencyWords` (OpenSubtitles 2018, CC BY-SA 4.0), so a title that is an everyday word in one of those languages ("Kes", "Thirst") counts as one in text of any language. The result has 42,041 lines. The script downloads the lists once into `tools/catalog/cache/`. It is a build input of the catalog (`ambiguous`), the index and the extension, which copies it to `data/common-words.txt`.

`npm run build` compiles the catalog into `index.bin` and `index.json`, the title matrix, and copies the pieces the update needs (`catalog.json`, `common-words.txt`, `catalog-classes.json`, `catalog-info.json`). `catalog-classes.json` also has a `sameSense` list: the classes that count as "a work or a fictional thing" for the `other` lookup.

### Series membership

Names and series are two things. The matcher's name groups come from titles (above). The catalog's `series` field says which works belong together, for the picker's "More from this series" section (contract). `tools/catalog/series.mjs` builds it as step 6 of `tools/catalog/build.mjs`, after the `other` lookup:

1. Each work's Wikidata "part of the series" (P179) and "media franchise" (P8345) statements are fetched. Only items whose class is a series or franchise count (`SERIES_CLASSES`; lists, rankings, broadcast slots and editorial collections are not). Three studios' whole film canons, typed as animated film series on Wikidata, are excluded by Wikidata id (`NOT_A_SERIES`: Walt Disney Animation, DreamWorks and Ghibli, as the code comment names them).
2. Each series is rolled up through its own P179 and P8345 to the topmost series (the film and the game series of "Resident Evil" become the franchise), but never into a series of more than 80 works (`CAP`; only "Mario" reached it, so its works keep "Super Mario", "Mario Kart" and so on). A series most of whose works are in another one is merged into it, again within the cap.
3. A work with no series gets one by title (`titleSeries` in `src/shared/catalog-rules.js`): a series name of two or more words (not counting a leading article) that the title starts with, followed by the end, a space, a digit, a colon or a dash, or that the title ends with and no colon or dash comes before it ("Return to Silent Hill"). A one-word series name is weaker: it must not be an everyday word, the series must hold a work of the same type, and the title must be the name alone or the name plus a number, colon or dash.

Result: 5,637 of the 24,609 works are in a series and 874 series have two or more works. Resident Evil has 43 works (42 titled with the name, plus Umbrella Corps), Silent Hill 14 (13, plus P.T.) and God of War 9. The largest are Star Wars (65), the Sherlock Holmes canon (64), Pokémon (59), Sonic the Hedgehog (59) and the Marvel Cinematic Universe (56). `data/catalog.json` grew from 3.69 to 3.86 MB. `test/fixtures/series.json` holds the lists for the three franchises named by the test. Known mistake: a work whose title equals a series name joins the series whatever its type (the novel "The House of the Dead" is in the game series; about three cases are known; a `shortcut` comment in `catalog-rules.js`). "Silent Hill: Townfall" is not in the catalog (13 sitelinks, the catalog needs 15). The series data is only as good as Wikidata's.

### Self-update

Opt-in, off by default. Choose daily, weekly or monthly on the settings page (Data), or press "Update now". An explicit press counts as consent for that one download.

- Schedule: an `alarms` alarm named `catalogUpdate` with period 1,440, 10,080 or 43,200 minutes. After the setting is turned on the first run is about a minute later. The alarm handler checks the setting again before it fetches. Turning the setting off clears the alarm.
- Query: works with at least 15 sitelinks and a date (`P577`, `P580` or `P571`) from January 1 of the year before the bundled catalog's build year onward, including future dates. The type is decided locally from the bundled class list. Then labels are fetched in batches of 200. Works with no date are not fetched. Works that are not told as a story are dropped, by one more query per 200 works. Then years, aliases and characters are fetched.
- Series: new works get a series like the build gives it, with at most 5 extra queries of 200 works (`MAX_SERIES_QUERIES`): their Wikidata series ids are mapped through the catalog's own `series` table, and works with none (or all of them when Wikidata fails or the budget runs out) get the title fallback. A series the catalog does not know is not added.
- The `other` lookup: names go to Wikidata in batches of 150, a label query and, for names of one or two words, an alias query. At most 20 queries per update. When the budget runs out or Wikidata fails, a name that was not looked up is treated as `other` if it has one or two words. That is the fail-safe: a wrongly weak title costs less than a wrongly covered news post.
- Client: POST to `https://query.wikidata.org/sparql`, one query at a time, no cookies, no referrer, 90 second timeout. On HTTP 429 or a 5xx response it waits (honouring `Retry-After`, capped at 120 seconds) and tries up to 3 times, then gives up until the next interval.
- Result: the bundled catalog, all added works and the hand-added works are rebuilt with the same code as the Node build (`src/shared/build-index.js`). The index is written to `storage.local` as one key (`catalogIndex`) in a single `set` call, so a tab sees either the old or the new index. Open tabs swap indexes on `storage.onChanged`.
- Failure: only `catalogMeta.lastError` is written. The working index is not touched.
- When the extension itself is updated with a newer bundled catalog, the index is rebuilt offline from `catalogAdded` and `custom`.
- The settings page shows a line such as "24,609 titles + N new · updated 3 days ago", or the last error.

This is the only network use of the extension. A test build may ship `data/update-config.json` to redirect the update to a local mock. Release builds have no such file.

A first catalog build (`tools/catalog/build.mjs`) sends up to about 800 more queries than before for the `other` lookup: the names go into 400 fixed buckets, each with one or two queries. Results are cached by query text.

## Memory and latency

Figures are from the image work (Chrome for Testing and Zen on an i5-10500H, measured with other jobs running, good to about 30 percent). They apply to the models that ship now: SigLIP 2 base/32 with its weights folded to fp32 at load, PP-OCR and the fine-tuned MiniLM, measured on the fixture build for 0.2.1.

| | Chrome, 4 threads | Zen, 1 thread |
|---|---|---|
| Title check, per image in a screenful | 171 ms | 426 ms |
| OCR, per image in a screenful | 193 ms | 350 ms |
| Process memory | 991 MB | not re-measured (about 910 MB in the earlier image work) |

- `dist/firefox` is about 160 MB (162 MB measured by the image work).
- `research/REPORT.md` predates these models. Read its image sections as research notes, not as a description of the shipped build.
- `tools/bench-engine.mjs` measures the real engine inside the built extension. With `--stats` it records the verdict inputs instead, and `tools/bench-stats-diff.mjs` compares such files between runs, batches and browsers (see [development.md](development.md#evaluation-scripts)).
