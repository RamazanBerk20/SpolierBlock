# UI rules

For anyone changing what the user sees: the extension's settings page (`src/options/`), the popup (`src/popup/`), the in-page cover (`src/content/content.js` and `content.css`), and the Android screens (`SettingsActivity.java`, `Ui.java`, `Cover.java`). The values below were read from those files at version 0.2.0. If a file and this page disagree, the file is right; fix this page.

## The `design-taste-frontend` skill

The owner uses the `design-taste-frontend` skill (tasteskill v2, `~/.claude/skills/design-taste-frontend/SKILL.md`) for UI work. Use it for the settings page, the popup and the cover. Its own description says it is for public pages and "not for dashboards or app screens", and these surfaces are small utility screens, so take the discipline and leave the art direction.

**Use:**

- The house style: no ornaments (no decorative rules, gradients, glows or stock icon cards), colour and type as named tokens in CSS custom properties, everything downstream referencing the tokens, one accent.
- Visible focus, real buttons and links, labels on every control, a phone layout that is its own composition.
- The look-and-fix loop: take screenshots at three widths, look at them, fix, look again. Judge the pictures, not the code. The settings page has breakpoints at 900 px and 640 px.
- The linter, when you want to check source for banned patterns. `base.css` carries one `taste-skill-ignore` comment (on the toast's shadow), which is the skill's marker for a finding that was looked at and accepted. Do the same, with a reason, if you must.

**Ignore, because this is a utility surface and not a public page:**

- Dealing a direction (`draw.mjs`), the subject inventory, "find the idea" and the competitor test.
- The copy deck rules (headline length, one primary action per screen) and the first-screen question.
- The imagery floor (real pictures on the page), image search, the "live thing", scroll motion and hero or section blueprints.
- "Fullness": a settings page may be mostly quiet. If the inspector reports pictures, fullness or hero findings, record each as not applicable in your report instead of changing the page to satisfy it.

The existing look below was decided and should not be re-dealt. Extend it; do not restyle it.

## Constraints that always apply

- **System light and dark.** Follow `prefers-color-scheme`. Every colour is a token with a light and a dark value. On the page the cover decides dark or light from the background of the block it covers (`isDark` in `content.js`), not from the system setting.
- **No web fonts and no remote assets.** System fonts only. The extension pages are offline. A new image, icon or font ships inside the package, or is drawn in code or CSS. This is also a hard rule in [AGENTS.md](../../AGENTS.md).
- **Keyboard and screen readers.** Every control is a real `button`, `input`, `select` or link. Switches are checkboxes with `role="switch"` and a label. Radio groups are real radios. Live status text uses `aria-live`. Focus returns to the same control after a re-render (`keepFocus` in `options.js`). A skip link leads to the library. The cover's group has an accessible name from its label, and the ⋮ button is named "SpolierBlock settings".
- **Reduced motion.** Transitions are off under `prefers-reduced-motion: reduce`.
- **A cover never changes layout.** It is absolutely positioned inside its block, its rules are `!important` on `:host`, it uses size containment, and the block's content is hidden with `visibility`. It must work in a feed that measures its posts, and in a block of 20 px height. See [pitfalls.md](pitfalls.md).
- **Strings.** The cover wording and the three button names are in the [contract](contract.md) and are identical on both platforms: change the contract first, then both. Other labels (settings rows, help text, error messages) are not shared and differ a little, for example "This is not a SpolierBlock export file." in the extension and "This is not a SpolierBlock settings file." on Android. Keep the five section names (Library, Add by hand, Blocking, Data, About) the same on both.

## The look of the extension pages

Defined in `src/options/base.css` (shared with the popup), `options.css` and `popup.css`.

**Colour tokens** (light, then dark):

| Token | Light | Dark | Use |
|---|---|---|---|
| `--ground` | `#f3f3f1` | `#121212` | Page background. |
| `--panel` | `#ffffff` | `#1b1b1b` | Cards, rows, the search field. |
| `--raise` | `#e8e8e5` | `#262626` | Buttons, inputs, tracks. |
| `--hover` | `#dededa` | `#303030` | Hover on `--raise`. |
| `--ink` | `#171716` | `#ececea` | Text. |
| `--soft` | `#5d5d59` | `#a3a39e` | Secondary text. |
| `--accent` / `--on-accent` | `#116149` / `#ffffff` | `#5cc49b` / `#08261b` | What is on, and the one main action. |
| `--accent-tint` | `#dcebe4` | `#173328` | "Seen" marks and chosen options. |
| `--cover` / `--on-cover` | `#161616` / `#f2f2f2` | `#000000` / `#ececea` | "Blocked" marks and the preview of a cover. |
| `--danger` | `#a3271b` | `#ff8a7a` | Destructive actions and errors. |
| `--focus` | `#116149` | `#5cc49b` | Focus ring. |

Surfaces are told apart by tone steps, not by lines or shadows. The only shadow is the toast, which floats.

**Type.** `system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", sans-serif`. Body 15 px on 1.5, weight 400 with 500 for labels and 600 to 650 for emphasis. Section headings 34 px on 1.05, weight 650, tracking -0.03em (28 px under 900 px). Subheadings 17 px, weight 600. The wordmark is 22 px (18 px in the popup). Meta text is 13 px. Counts in the popup are 40 px with tabular figures.

**Shape.** Buttons, inputs, chips and switches are fully round (`999px`), decided once. Panels and grouped rows have an 18 px radius, with rows split by a 2 px gap of the ground tone; the first and last row round the group's corners. The `--r: 10px` token exists but is not used by the current rules.

**Size and spacing.** Controls are at least 40 px high, the main search 52 px, and the cover's buttons 28 px. The settings page is a two-column grid: a 248 px rail (sticky, with the on and off switch, a state line and the section links) and a main column of at most 860 px, in a frame of at most 1160 px with a 56 px gap and 32 px side padding. Sections are 112 px apart (80 px on narrow screens). Panels pad 24 px, rows 8 px by 18 px, and inline gaps are 6, 8, 12 or 16 px. Under 900 px the rail becomes a sticky top bar with a scrolling row of links. The popup is 360 px wide with 16 px padding and a 12 px gap.

**Focus.** `:focus-visible` draws a 2 px outline in `--focus` with a 2 px offset. Inputs that take text get the outline inside.

**Toast.** One at a time, a pill at the bottom, with an optional Undo. Library changes and imports offer Undo through it. "Reset everything" and an import in Replace mode also ask with a confirm first, then offer Undo.

## The look of the in-page cover

Defined in the `OVERLAY_CSS` string in `content.js`. It lives in a shadow root, so page CSS cannot reach it.

- 13 px on 1.35, the same system font stack.
- Light: background `#eef1f4`, text `#1f2328`, border `#b9c0c8`, focus ring `#0b57d0`. Dark (when the covered block is dark): `#22272e`, `#e6e8eb`, `#59616b`, `#8ab4f8`.
- A flex row: the label on its own line, then the pill buttons (1 px border, 28 px minimum height, 12 px side padding, hover tint of the current colour). The ⋮ button has no border and a 16 px glyph.
- Two compact layouts by container query: at 76 px of height or less everything sits on one row with the label truncated; at 34 px or less the buttons shrink to 22 px.

Known inconsistency: `base.css` says its `--cover` colour is "the near-black of the in-page cover", and the Blocking section's preview draws a near-black cover. The real cover is the light or dark grey panel above. If you touch either, make the preview match the cover, or the cover match the preview, in one change.

## Android screens

Read `Ui.java` first. The library has no resources and no AndroidX (it is merged into other apps), so everything is built in code from plain framework views: `LinearLayout`, `TextView`, `GradientDrawable`, `RippleDrawable`, and icons drawn on a canvas (`Ui.Icon`: back and close, 24 dp, 2 dp stroke). Do not add an XML layout, a drawable resource, a font file or a library. The companion app, which has resources, uses them only for its launcher icon.

- **Palette** (`Ui.Palette`, one per system night mode): light background `#FBF8F2`, surface `#F4F0E8`, text `#1D1B20`, accent `#7A5200` (amber) on `#FFFFFF`; dark background `#141317`, surface `#1D1C21`, text `#ECE9E3`, accent `#F0B856` on `#2A1C00`. Containers, outline, muted text and error have a value in each. The covers use the palette's `cover` colour (`#E9E4DA` light, `#1C1B20` dark).
- **Type** in sp (so it follows the user's font size): title large 22, title medium 16, body large 16, body medium 14, label large 14, body small 12. Medium weight uses `sans-serif-medium`. Line spacing 1.15.
- **Touch targets** at least 48 dp (the cover's own buttons are 44 dp, and shrink to 24 dp on a short item). Buttons are `Ui.button` in four kinds (filled, tonal, outlined, text) plus danger, with a 24 dp radius. Single-choice groups are `Ui.Segmented`, an outlined pill with the chosen segment filled with the accent container, and each segment has a content description that includes the group's name.
- **Navigation.** Five tabs, as on the extension. Back is a 48 dp icon button. The screen is full-screen and applies the insets of the system bars, the keyboard and the display cutout itself (`SettingsActivity.java`), and sets the bar colours and icon appearance from the palette.
- **Accessibility.** Every icon button has a content description. A covered item is exposed to TalkBack through `CoverA11y`. Do not reach into a view's accessibility from anywhere else.
- **Cover.** `Cover.java` builds the panel in the item's `ViewGroupOverlay`. Keep the buttons reachable on a short item (they go beside the message), and do not call `View.draw` on host views (see [pitfalls.md](pitfalls.md)).

There is no emulator-free way to see these screens. Look at them on the emulator (hold the heavy lock), in light and dark, at the largest font size, and say in your report that this is all you did.
