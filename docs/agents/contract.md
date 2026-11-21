# Cross-platform contract (0.2)

The browser extension and the Android code must agree on everything on this page. Change it here first, then in both.

## Config

One config, four parts. The extension keeps each part as a `storage.local` key of the same name. Android keeps the
same JSON (local preferences, or the companion app's provider when it is installed).

```jsonc
{
  "works": {                       // only works the user has touched; every other work is "unlisted"
    "Q1079": { "state": "seen", "style": null, "title": "Breaking Bad", "type": "tv", "year": 2008, "ts": 1790000000000 }
  },
  "custom": [                      // works entered by hand; indexed like catalog works
    { "id": "custom:1", "title": "My Indie Game", "aliases": ["MIG"], "type": "game" }
  ],
  "settings": {
    "enabled": true,
    "scanImages": true,
    "blockUnlisted": true,         // false = only works with state "blocked" are ever covered
    "style": "all",                // default style: "all" | "spoilers"
    "unknownImages": false,        // cover film/show/game-looking images that no title could be put on
    "pausedSites": [],             // extension only
    "catalogUpdate": "off"         // "off" | "daily" | "weekly" | "monthly"
  },
  "learned": {                     // what the user's reports taught it (rule 11); everything stays on the device
    "names": { "Q1079": ["BrBa"] },                     // extra names for a work, indexed like its aliases
    "not": { "Q42759035": ["youtube.com/dokuzsekiz müzik", "x.com/@somebody", "reddit.com"] }   // where a name is not this work
  }
}
```

- `state`: `"seen"` (never cover) or `"blocked"` (always cover). No entry = unlisted.
- `style`: `"all"` (cover anything about the work), `"spoilers"` (cover only what the classifier calls a spoiler) or
  `null` (use `settings.style`).
- `type`: `movie`, `tv`, `game`, `book`, `anime`, `manga`, `comic`.
- Custom ids are `custom:<n>`. A custom work may also carry a `works` entry. Custom works are indexed as catalog works with a popularity of 1000 (`CUSTOM_POP` in `src/background/catalog-update.js`, `SpoilerBlock.CUSTOM_POP` on Android; `CustomWorkTest` checks that they agree) and the aliases as given.

Migration from 0.1: `seen[id]` becomes `works[id]` with `state: "seen"`; `settings.mode` `"any"`/`"spoiler"` becomes
`settings.style` `"all"`/`"spoilers"`.

## Export file

`spolierblock-config.json`, the same on both platforms:

```json
{ "format": "spolierblock", "version": 1, "exportedAt": "2026-11-18T12:00:00Z", "works": {}, "custom": [], "settings": {} }
```

Import offers "Merge" (imported entries win per id; settings are replaced only when the user ticks it) and "Replace".
Unknown keys are ignored. A file with another `format` or a higher `version` is refused with a message.

## Decision rule

A text match names a group: the works the matched name refers to. A bare name refers to the closest works only:

- works whose title is exactly the name ("Half-Life" is the 1998 game; "Minecraft" is the game; "Assassin's Creed" is the
  2007 game and the 2016 film);
- if no title is exactly the name, works that list it as an alternative name;
- if there are none of those either, the works of the series the name was derived from ("Resident Evil Revelations" has
  no work titled "Revelations", so a derived series name falls back to its members).

Sequels, spin-offs and adaptations that merely contain the name ("Half-Life: Alyx", "A Minecraft Movie", "Assassin's
Creed Valhalla") are named only by their own titles and alternative names, with one exception: a franchise name also
takes the works of its series when the closest works are themselves entries of that series, or when the series' best work
is at least 1.5 times as popular as the closest one ("Halo", "Star Wars"). A type word next to the name narrows the
group to works of that type ("the Minecraft movie", "Assassin's Creed film").

1. Group state: `blocked` if any work is blocked; else `seen` if any work is seen; otherwise `unlisted`. A bare name
   cannot say which of its works a post is about, so one seen work is enough to show it: nobody has to finish a whole
   franchise to read about the entry they know. A post that names an unseen entry by its own title or with a type word
   ("Resident Evil Requiem", "the Resident Evil film") is still covered, and blocking one work keeps the bare name
   covered.
2. `seen` never covers. `blocked` covers. `unlisted` covers only when `settings.blockUnlisted`.
3. Group style: `all` if any non-seen work in it has effective style `all` (`work.style ?? settings.style`), else `spoilers`.
4. Style `all`: cover at once. Style `spoilers`: cover while the classifier runs (fail closed), keep the cover only if
   it says spoiler.
5. An image identified as a covered group's work covers regardless of style.
6. An image that looks like film/show/game media but has no title covers only when `settings.unknownImages`, and never
   when the post's text names a seen work and no covered one.
   "Looks like" is either of two checks on the picture model's embedding of an image or a sampled video frame, the
   same on both platforms: the media prompts beat the generic prompts by `mediaGate` (posters, stills), or the footage
   head scores at or above its cut-off. The footage head is one linear layer, `score = w · e + b` on the L2-normalised
   embedding `e`, shipped as `foot: { w, b, cut }` in `clip-meta.json` (source: `data/footage-head.json`). It answers
   "is this footage of a game, an anime, an animation or a film" and never which one, so it needs no knowledge of the
   work and covers footage of works that did not exist when it was trained. A build without `foot` uses the first
   check alone.
7. Text outranks pictures, and typed text outranks text read from pictures.
   - When the post's own text names a seen work and no covered one, a title put on its picture (rule 5) and names found
     only in text read from its pictures (OCR) do not cover.
   - The image model's title for a picture is dropped whenever the post's own text or that picture's own text (OCR)
     names any work, seen or not: the model only speaks for pictures that no text identifies.
   - The cover's label names the best-supported group: one named by the post's own text first, then one named only by
     OCR text, then an image title. Within a tier, a longer matched name comes before a shorter one.
8. Text read from pictures is weaker evidence than text the author typed: it is often all capitals, so capital letters
   prove nothing in it, and it is full of stray words. The caller passes it to the matcher after the post's own text,
   separated by one U+0001 character (`own text` + `\u0001` + `OCR text`). The matcher's rules for the part after the
   marker are in docs/how-it-works.md.
9. The uploader's name is not a work (0.2.4). The caller may pass the name of whoever posted the item (a YouTube
   channel) right after the post's own text, behind one U+0002 character and before any OCR part:
   `own text` + `\u0002` + `uploader` [+ `\u0001` + `OCR text`]. Offsets into the own text are unchanged. The uploader
   part names no work and is no evidence for any name. Its key is its tokens (the matcher's tokenizer and
   normalisation) with trailing `official`, `vevo`, `music`, `muzik` (Müzik) and `topic` removed, also when glued to the
   last word ("JokerVEVO"), but never the only word. A name of the own text whose tokens equal that key counts only
   with media evidence in its sentence: a media word of its works' types within 3 words, the "is a ... game" pattern or a
   consumption verb right before it, a type word of its works within the next 3 words, or a release year of one of its
   works. Quotes, a hashtag, another name of the same work, a longer name holding it and Title Case do not count, and it
   is never an unsure name. "Joker - Mikrofon Şov" from the channel "Joker" names nothing; "Joker (2019) ending
   explained" and "Minecraft - Official Trailer" from the channel "Minecraft" still do. What is lost: a clean title with
   no media word from a channel named like the work ("Minecraft" from the channel "Minecraft"). Both platforms strip
   U+0002 from page and app text. No uploader known means no U+0002 part and the rules as before.

10. Removed. Until 0.2.5 a post that held a video and no caption could be covered on sites the user listed
    (`settings.captionlessVideos`, label `Video with no caption`). It judged a post by what it did not say, so it
    covered unrelated videos and missed footage posted under an unrelated caption. The key is no longer read or
    written; an older config or export file that has it is accepted and the key is dropped. The number stays so that
    rule 11 keeps its name.

11. Reports (0.2.4). Two things the user can teach it. All of them are stored in `learned`, exported and imported
    with the config (`Merge` unions them), listed in the settings with a way to remove each, and never leave the device.
    - **Wrong cover.** `Not this` is offered only for a post the user has looked at: on the pill of a post shown once
      from a cover that names works (see "Cover wording"), never on the cover itself, where the post cannot be judged.
      It records, for every work of the cover's groups, where the name does not mean that
      work: the post's source when the platform knows it, otherwise the whole site. The key is `{site}/{source}` or
      `{site}`, lower-case; the site is the host name as in `pausedSites` (on Android the app's site: `x.com`,
      `instagram.com`, `youtube.com`); the source is the YouTube channel name (the uploader of rule 9) or, on x.com,
      the author's handle with its `@`. A matched group, from text or from a picture, is dropped before rule 1 when
      every work in it has the post's `{site}/{source}` key or its `{site}` key in `learned.not`. The cover goes at
      once, and every other post of that source is re-judged.
    - **A missing name.** `learned.names[id]` holds extra names for a work, of the catalog or custom. They are indexed
      exactly like the aliases of a custom work (as given) on both platforms, so the matcher's rules apply to them
      unchanged. A name is 2 to 60 characters after trimming; at most 20 per work. The extension's popup offers the
      text selected on the page as a new name for a work the user picks; the settings of both platforms let the user
      edit a work's extra names.
    - Not built: remembering a clip from its picture embeddings. Measured on 60 videos (2026-11-21): at a threshold
      with no match between different videos, a re-sampled frame of the same video matched 0.4 % of the time.

## Names the matcher is unsure about (0.2.4)

The matcher's rules accept a name or drop it. A third answer exists for a name that could be a title but that no
rule confirms: an everyday-word title with no media word near it ("Heat still has the best shootout"), or a title
typed in lowercase ("lost was peak tv"). Those are *unsure* names, and a second on-device model decides them, the
title-in-context model (`models/context`; same family, tokenizer and size class as the spoiler classifier).

- The matcher returns the unsure names next to the accepted groups: for each, its group, the character offsets of
  the name in the post's own text, and whether the name mostly means something else. Never unsure: a name in text read from pictures, a name inside a handle, a
  determiner, quantifier or pronoun typed in lowercase ("it", "her", "up", "no", "us"), one of the most frequent
  everyday words, a bare number, a quoted name in music talk, a lowercase single word in a post that has letters
  outside ASCII (the model is English-only), a name typed all in lowercase in a post whose own text has no English
  function word outside the name (a fixed list of 66 words such as "the", "is", "was", "you", "with", identical on both
  platforms; "Gezinmeyi atla" is Turkish written in ASCII), the uploader's name (rule 9), and a name whose group the rules already accepted or whose group is seen.
  The exact tests are the matcher's ("Unsure names" in docs/how-it-works.md).
- At most 4 unsure names per post are asked, the most popular group first. One question per name: segment A is the
  post's own text cut to the window around the name that `models/context/meta.json` defines, segment B is
  `{group label} [{types}]` with the group's work types in the order movie, tv, game, book, anime, manga, comic
  (`Lost [tv]`, `Dune [movie, book]`). The model's probability at or above `threshold` in `meta.json` is a yes; a name
  the index flags as mostly meaning something else (a person, a place, a brand) needs `thresholdOther`.
- A yes makes the group a matched group of the post's own text, after the groups the rules accepted, and the decision
  rule above applies to it unchanged (seen, blocked, style, wording `Mentions {t}`).
- While the model is asked the post is **not** covered, and a model error is a no: these posts were never covered
  before, and a cover that appears and vanishes on ordinary posts is worse than one that arrives a moment late. (The
  spoiler classifier stays fail-closed: there the post is known to be about the work.)
- Answers are remembered per (text window, group) for the page or app process. Both platforms must give the same
  unsure names for the same text (vector tests), and the same model input for the same name (window and segment B).

## Cover wording

Identical strings on both platforms. `{t}` is the group label; with several groups it is `{t} and N more`.

| Why it is covered | Text |
|---|---|
| style `all`, text names the work | `Mentions {t}` |
| style `spoilers`, classifier still running | `Checking {t} for spoilers…` |
| style `spoilers`, classifier said spoiler | `Spoiler about {t}` |
| image identified as the work | `Image from {t}` |
| unidentified media image | `Possible film, show or game image` |

Pictures still being judged: both platforms shade the picture itself (the extension dims it, Android paints an opaque
shade over it, with no text and no buttons) and leave the post's text readable; only a verdict covers the post. A picture
whose check fails stays shaded on Android; the extension reveals it after its retries.

Buttons: `Show once`, `I've seen it` (absent for the unidentified image) and a settings button (`⋮`, accessible name
`SpolierBlock settings`). A cover has no `Not this`: that button is on the pill below, after `Show once`.

`I've seen it` on a group with one work marks it seen at once when its series has no other work that is not yet seen. When
the series has more unseen works (a post about "Resident Evil Village"), the picker opens instead, so the user can tick
the rest of the franchise in the same place: its first section is that one work, already ticked, the note is
`This post is about "{title}". It is shown once you mark that one.` (`{title}` is the work's title), and the second
section is `More from this series` as below. `Mark seen` writes the ticked works; `Cancel` writes nothing. The cover's
label stays the work's own (`Mentions Resident Evil Village`). On a group with several works (a franchise name such as
"Resident Evil", or an original and its remake) it opens a picker instead: title `Which have you seen?`, one row per work
not yet seen (`{title}` and `{type} · {year}`) with a checkbox, nothing ticked, the buttons `All`, `Cancel` and `Mark seen`, and the
note `Posts that only say "{t}" are shown once you have seen one of these.` When the cover names several groups, the picker
lists the unseen works of all of them and the note is `This post names several works. It is shown once you have seen one for each name.` Only the ticked works are written.

Below those rows the picker offers the rest of the franchise, so the user can mark everything they have seen in one
place: a second section titled `More from this series`, listing the other works of the same series that are not yet seen
(same row format, oldest first, nothing ticked), collapsed behind a `Show N more` row when there are more than six.
Ticking them is optional: only the first section decides whether the post stays covered (rule 1). `All` ticks the first section
only; the second section has its own `All N`. Series membership comes from the catalog's `series` field, not from the
matched name.

After `Show once` on a cover that names works, the shown post keeps a small pill in its top corner at the end of the
line (right in left-to-right layouts), so the user can judge the post after seeing it (0.2.5): the buttons `Not this`
(rule 11) and `Cover again` (forgets the `Show once` for this post, the cover returns). The pill
is drawn over the post like the cover is (it never changes a measured size), takes taps only on itself, and stays as long
as the post is shown once. A post shown from the unidentified-image cover has no pill.

`Show once` is remembered for the post, not for the view that happens to draw it: it is keyed by the post's own text, it
survives the host recycling or rebinding the view and late picture verdicts, and it lasts until the page or app process
ends.

The cover and the pending-picture shade take their colours from the surface they sit on (the page or the host app's
actual background), not from the system setting: dark on a dark surface, light on a light one, never a white flash on a
dark app.
