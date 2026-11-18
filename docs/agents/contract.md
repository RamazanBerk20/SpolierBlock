# Cross-platform contract (0.2)

The browser extension and the Android code must agree on everything on this page. Change it here first, then in both.

## Config

One config, three parts. The extension keeps each part as a `storage.local` key of the same name. Android keeps the
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

A text match names a group: every work that carries the matched name.

1. Group state: `seen` if every work is seen; `blocked` if any work is blocked; otherwise `unlisted`.
2. `seen` never covers. `blocked` covers. `unlisted` covers only when `settings.blockUnlisted`.
3. Group style: `all` if any non-seen work in it has effective style `all` (`work.style ?? settings.style`), else `spoilers`.
4. Style `all`: cover at once. Style `spoilers`: cover while the classifier runs (fail closed), keep the cover only if
   it says spoiler.
5. An image identified as a covered group's work covers regardless of style.
6. An image that looks like film/show/game media but has no title covers only when `settings.unknownImages`, and never
   when the post's text names a seen work and no covered one.

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
whose check fails stays shaded.

Buttons: `Show once`, `I've seen it` (absent for the unidentified image) and a settings button (`⋮`, accessible name
`SpolierBlock settings`).
