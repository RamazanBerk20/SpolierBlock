# Android

The Android part is a [Morphe](https://github.com/MorpheApp) patch bundle (version 0.2.3) and a companion app. The bundle adds one app-agnostic Java extension to a host app. Thin per-app patches inject it. The companion app, `dev.spoilerblock`, owns the settings that every patched app shares.

Read the [limits in the README](../README.md#status-and-known-limits) first. In short: the owner ran the 0.2.0 and 0.2.2 bundles on one real phone (a Galaxy S25+) in patched YouTube, X and Instagram and reported that covers and buttons work in the YouTube and X feeds, that a covered reel is muted, and (0.2.2) that the picker, the covers and the colours work; the 0.2.3 changes have run only in an x86_64 emulator and the demo app, nothing was measured on a phone, and patching these apps is against the services' terms. The config, the decision rule and the cover wording are in [agents/contract.md](agents/contract.md). The Java code follows them, and `ConfigTest` and `CustomWorkTest` check it.

## What the patch does

The bundle contains one patch, `SpoilerBlock` (enabled by default), registered once per target app. The demo app has two more registrations (see [Demo app](#demo-app)).

| App | Package | Tested version | APK type |
|---|---|---|---|
| YouTube | `com.google.android.youtube` | 21.30.216 | APK |
| X | `com.twitter.android` | 12.19.1-release.0 | APKM |
| Instagram | `com.instagram.android` | 452.1.0.53.64 | APKM |

Other versions are marked experimental in the patch. Nothing is fingerprinted, so a different version may work, but it has not been tried.

For each app the patch:

1. Merges the extension (`extensions/blocker.mpe`, package `dev.spoilerblock`) into the app.
2. Writes the matcher index and catalog files under `assets/spoilerblock/`: `index.bin`, `index.json`, `catalog.json`, `common-words.txt`, `catalog-classes.json`, `catalog-info.json`.
3. Writes the models under `assets/spoilerblock/`: the spoiler classifier (`spoiler/`), the SigLIP 2 vision model with its title rows and cut-offs (`vision/`: `model.onnx`, `clip-text.bin`, `clip-meta.json`), and the PP-OCR detector, recogniser and character list (`ocr/`: `det.onnx`, `rec.onnx`, `dict.txt`). They are loaded only when the matching feature is used. See [Images](#images-and-video).
4. Adds two native libraries, `libonnxruntime.so` and `libonnxruntime4j_jni.so` (ONNX Runtime 1.22.0), for `arm64-v8a` and `x86_64`.
5. Adds one call, `SpoilerBlock.init(Application)`, at the start of `Application.onCreate`. The Application class is read from the manifest, then the first class up its hierarchy that implements `onCreate()` is patched. Nothing depends on obfuscated names.
6. Adds the settings activity (`dev.spoilerblock.SettingsActivity`, not exported) to the manifest, and a `<queries>` entry for `dev.spoilerblock` so the app can see the companion (Android 11 and newer).
7. Adds a "SpolierBlock" row to the host's own settings where the patch knows the screen (see [Settings](#settings)).
8. Routes every `NotificationManager.notify` call in the app's own code through the blocker (see [Notifications](#notifications)).
9. For X and Instagram, adds text hooks (see below).

The patch adds no permissions. The three apps already hold the network permission the catalog update needs. If anything in the blocker throws, it disables itself for the session and removes every cover, so the host app stays usable.

## The companion app and the shared config

The companion app is `android/companion`, application id `dev.spoilerblock`, minimum API 28. It declares no permissions. Its launcher activity is the settings screen. It compiles the extension's own sources, so the two never disagree, and ships only the title index (for search), not the models.

It exports a content provider, `content://dev.spoilerblock.config/config`, that holds the one config of the [contract](agents/contract.md). The provider offers only `call()`:

| Method | Does |
|---|---|
| `get` | Returns the config JSON in the `json` key of the reply bundle. |
| `patch` | Applies a JSON merge patch (the `json` key of the extras), then returns the new config. A `null` value removes a key. |

Every change is announced on the provider's URI.

**Who may call.** The provider answers only callers on a fixed list, checked by package name with `getCallingPackage()` (`Store.CALLERS`): `com.google.android.youtube`, `app.morphe.android.youtube` (the name the YouTube GmsCore patch gives it), `com.twitter.android`, `com.instagram.android`, `dev.spoilerblock.demo`, `dev.spoilerblock.demo2` and `dev.spoilerblock`. Any other caller gets a `SecurityException`. A signature permission cannot be used, because the patched apps are signed with a different key than the companion.

The caveat: the check is the package name only. Android allows one installed app per package name, so another app can claim an allowed name only while the real app is not installed. The patched apps are re-signed copies under those names, so this is the normal case for them, and any other re-signed app under one of those names could read and change the config. The config is the user's library: the titles they marked as seen or blocked, which is a list of what they have watched, and the settings. Nothing in it is a credential.

**In the patched app** (`Store.java`):

- With the companion installed, the patched app reads and writes the config through the provider. Without it, the app keeps its own private copy, so each patched app has its own list until the companion is installed.
- Live observation: the app registers a content observer on the provider's URI and refetches when it is notified. It also refetches on every activity resume, because an app that sat frozen in the background gets change notices late, and it re-checks whether the companion has been installed or removed.
- One-time merge: when the companion appears, the app's own list is merged into the companion's once. After that the shared list is the truth.
- Fallback: if the companion is uninstalled, or a call fails, the app keeps working on the last shared list as its own copy.
- A 0.1 install's preferences (`seen`, `mode`, `enabled`, `scanImages`, `catalogMode`) are migrated into the new config on first start.

## Prerequisites

| Need | Detail |
|---|---|
| JDK 21 or newer | `apply.sh` and `demo-build.sh` look in `$JAVA_HOME`, then `$HOME/.local/jdks/jdk-21.0.13+9`. `apply.sh` falls back to `java` on `PATH` and checks the version. |
| Android SDK | Gradle reads `android/local.properties` (not in git): `sdk.dir=<path to the SDK>`. `apply.sh` reads an `.apk`'s package name with `aapt2` from `$ANDROID_HOME/build-tools/*` (default `$HOME/Android/Sdk`). `.apkm` and `.xapk` files do not need it. |
| `unzip`, `git`, `gh` | `bootstrap-morphe.sh` clones with `git` and downloads the CLI with `gh`. `apply.sh` reads bundles with `unzip`. |
| Node.js and npm | To run `npm run build` first. The bundle packs its data from `dist/firefox`, and the companion packs the index from there. |
| Your own APKs | Not in the repository. Put them in `android/apks/` (ignored by git) or anywhere else. |
| `adb` | Only for `--install` and for the device scripts. |

Gradle uses the wrapper (Gradle 9.9.1). `android/gradle.properties` limits it to a 2 GB heap, 2 workers and a 1 GB Kotlin daemon.

## Build the bundle

Run these from the repository root unless stated.

1. Build the extension data. The bundle packs files from `dist/firefox`.

   ```sh
   npm install
   npm run build
   ```

2. One-time Morphe setup. The Morphe Gradle plugin (2.1.1) and morphe-patcher (2.4.0) are published only to GitHub Packages, which needs a token. The script builds the same tagged sources into `~/.m2` instead. It also downloads the Morphe CLI (`morphe-desktop-2.2.0-all.jar`) into `android/tools/`.

   ```sh
   android/tools/bootstrap-morphe.sh
   ```

   This builds two Gradle projects, so it is heavy. Run it alone.

3. Build the bundle.

   ```sh
   cd android
   ./gradlew :patches:buildAndroid
   ```

   The bundle is written to `android/patches/build/libs/patches-0.2.3.mpp`. The version comes from `version` in `android/gradle.properties`. The 0.2.0 bundle is 138 MB (the 0.1 bundle was about 112 MB); the 0.2.2 and 0.2.3 bundles were not built for this page, so their sizes are not measured. If `dist/firefox/data` lacks one of the six catalog files, the build stops and tells you to run `npm run build`.

`apply.sh` uses the newest `patches-*.mpp` it finds in that folder.

The companion app is built from the same project: `./gradlew :companion:assembleDebug` (or `assembleRelease`). It needs `dist/firefox/data/index.bin` and `index.json`. The release build is signed with `android/keystore` when it exists, otherwise it is unsigned. `android/tools/demo-build.sh` builds the bundle, both demo apps and the companion in one go.

## Patch an APK: `android/apply.sh`

```sh
cd android
./apply.sh <app.apk|app.apkm|app.xapk|app.apks> [out.apk]
./apply.sh --install <app...> [out.apk]
```

- `--install` must be the first argument. It installs over `adb` on the first device, or on `$ANDROID_SERIAL` if that is set.
- The Morphe CLI merges split bundles into one APK.
- The package name is read from the input. `.apkm` uses `info.json` (`pname`), `.xapk` uses `manifest.json` (`package_name`), `.apk` and `.apks` use `aapt2`.
- Supported packages: `com.twitter.android`, `com.google.android.youtube`, `com.instagram.android`, `dev.spoilerblock.demo` and `dev.spoilerblock.demo2` (the demo apps). Others stop with exit code 2.
- Output defaults to `android/out/<package>-spoilerblock.apk`. A result file `<output>.result.json` is written next to it. Patching must report `"success": true` or the script exits with code 3.
- The patcher runs with `-Xmx3g`.

Environment variables:

| Variable | Default | Meaning |
|---|---|---|
| `JAVA_HOME` | `$HOME/.local/jdks/jdk-21.0.13+9`, then `java` on `PATH` | JDK 21 or newer. |
| `ANDROID_HOME` | `$HOME/Android/Sdk` | Where to find `aapt2` for `.apk` and `.apks` inputs. |
| `ANDROID_SERIAL` | first device | Device for `--install`. |
| `ABIS` | see below | Comma-separated list passed to the CLI as `--striplibs`. |
| `KEYSTORE` | `android/keystore/spoilerblock.keystore` | Keystore to sign with. If you set it, the file must exist. |
| `KEYSTORE_PASSWORD` | the generated password, or none when `KEYSTORE` is set | Keystore password. |
| `KEY_ALIAS` | `Morphe` | Key alias. |
| `KEY_PASSWORD` | the keystore password | Key password. |
| `MORPHE_ALL` | unset | When set, `--exclusive` is not passed, so every patch enabled by default in the given sources runs, not only `SpoilerBlock` and, for YouTube, `GmsCore support`. |
| `MORPHE_PATCHES` | `https://github.com/MorpheApp/morphe-patches` | Source of the official patches used for YouTube. |

Native libraries are reduced to `ABIS`. Defaults:

| App | Default `ABIS` |
|---|---|
| YouTube | `arm64-v8a,x86_64` |
| X | `arm64-v8a` |
| Instagram | `arm64-v8a` |
| Demo apps | `arm64-v8a,armeabi-v7a,x86,x86_64` |

The patch only adds its libraries to ABIs the app already ships. So a patched app runs on arm64 phones and on x86_64 emulators (Android 11 and newer images translate arm64). The patch ships libraries for `arm64-v8a` and `x86_64` only. On a device of another ABI, style `spoilers` fails closed (it covers every text match) and the image scan fails closed.

### Signing

- If no keystore is given and `android/keystore/spoilerblock.keystore` does not exist, the script creates it once: PKCS12, alias `Morphe`, RSA 4096, valid 10,000 days, subject `CN=SpoilerBlock local`. The password is random and stored in `android/keystore/password`. Keep both files to install later builds over earlier ones. They are ignored by git.
- The result is not signed with the original developer key. For X and Instagram, uninstall the store app before installing the patched one.
- To update an app that Morphe Manager already patched (same signature, data kept), sign with the Manager's key. Export it in Manager (Settings, Signing key, Export). The script's header says it is a BKS file whose alias and password are both `Morphe`. Then run:

  ```sh
  KEYSTORE=Morphe.keystore KEYSTORE_PASSWORD=Morphe KEY_ALIAS=Morphe KEY_PASSWORD=Morphe MORPHE_ALL=1 ./apply.sh <app>
  ```

### Per-app notes

**YouTube.** A re-signed YouTube cannot use Google Play services. For YouTube the script therefore also runs the official Morphe patch `GmsCore support` (with its dependencies), fetched from `MORPHE_PATCHES`. Install MicroG-RE before opening the patched app. The patched app installs as `app.morphe.android.youtube` next to the store app. Other official Morphe patches can be added with `MORPHE_ALL=1`. There is no app-specific text hook for YouTube. The generic capture does the work.

**X.** Tweet text and names are custom views that draw a `Layout`. X sets a tweet's content description only while an accessibility service runs. So the patch hooks the start of `setText(CharSequence)` in `com.twitter.ui.widget.TextContentView` and `TextLayoutView` and reports the text to the blocker. Both classes are named in layout XML, so the names survive obfuscation. If a hook is not found in another version, the patch logs a warning and carries on. Only that view's text is lost. X also needs `extractNativeLibs` (see below).

**Instagram.** Feed captions and comments are `IgTextLayoutView`, which draws a `Layout`. The patch hooks `setTextLayout(Layout)` on `com.instagram.ui.widget.textview.IgTextLayoutView`. The hook makes the text independent of the view's accessibility node provider, which may be absent.

**X quoted posts.** X draws the quoted post's text itself: `com.twitter.tweetview.core.QuoteView` builds a `StaticLayout` in `onMeasure` from a `CharSequence` field, and sets a content description only while an accessibility service runs. The patch (`TextHook` with a `field`, in `SpoilerBlockPatch.kt`) inserts, at the start of `QuoteView.onMeasure(II)`, a read of that field and a call to the blocker with it. The field is `O`, an obfuscated name read statically from X 12.19.1, so it can differ in another X version. The hook is fail-soft: if the class, the method, the field or two free registers are missing, the patch logs a warning (`text hook not found`) and only the quoted text is lost. The reply-context line inside a quote is a `TextLayoutView` and is hooked by the existing rule. This has never run in X: it comes from reading the APK. The demo reproduces it with `QuoteBox`.

**Instagram Reels.** Instagram's Reels viewer wraps the window's `Window.Callback` with its own gesture handler after the blocker installed its `TouchGate`, and that handler keeps a plain tap to itself (read statically in 452.1; the demo's wrapper does the same), so a tap on a cover's buttons could be swallowed. Since 0.2.2 the blocker puts its gate back in front when something wrapped it (see [Cover](#how-text-and-pixels-are-captured), under "Touch"). This is from reading Instagram 452.1 and from a reproduction in the demo app; it never ran in Instagram. The owner reported the Reels buttons as a problem in 0.2.0, which this change targets.

### Manifest and native libraries

- New library files are written compressed into the APK. That only installs with `extractNativeLibs=true`. X declares `false`, so the patch sets it to `true`. X's own libraries stay stored in the APK and are now also extracted at install. YouTube and Instagram already extract.
- The patch adds libraries only to ABI folders the app already has. A new ABI folder would make a device of that ABI pick it and lose the app's own libraries. If the app has no native code at all, it gets both.
- The libraries have unique names (`libonnxruntime*.so`) and a statically linked C++ runtime.
- If the host app already ships one of these files for an ABI, it is kept and a warning is logged. Then style `spoilers` fails closed if the host's version does not fit. (0.1 also shipped four Tesseract libraries with rewritten sonames, and `eng.traineddata`. They are gone.)
- Besides `extractNativeLibs`, the patch adds an activity and a `<queries>` entry to the manifest, assets, libraries, one `onCreate` call, the notification call rewrites and the settings rows. It does not edit shared classes or resources otherwise, which is why it can run next to other patches, such as the official ones.

## Using the bundle in Morphe Manager

Not verified on a real device. The bundle is an ordinary `.mpp` file, so the intent is to add `patches-0.2.3.mpp` as a local patch source in Morphe Manager and enable `SpoilerBlock` together with the other patches you want. The menu steps are not described here because they could not be checked in this repository. If you do this, also read the signing notes above.

## How text and pixels are captured

The blocker uses only public Android APIs on the host's views.

**Feed items.** A `Scanner` is attached to each activity window. Before every frame (`OnPreDrawListener`, after layout and before draw) it looks at the children of the window's scrolling containers. A container is an `AbsListView`, a view that can scroll, or a view whose class name (or a superclass name) ends in `RecyclerView`, `ViewPager`, `ViewPager2` or `ScrollView`. It finds containers again when the layout changes or every 500 ms. Nested lists inside an item are judged item by item. Only a container whose class name ends in `ScrollView` is looked into (through up to three levels of single children) to find its items. A list or pager that shows one full-screen page at rest (Reels, Shorts) holds one child too, but that child is the item itself, so the page is covered as one item. A list drawn by Jetpack Compose is not made of such views, so it is not recognised as a container (not tested).

**Other windows.** Dialogs, bottom sheets, popup menus and drop-downs (search suggestions) are windows of their own, not part of the activity's. The blocker finds their root views with `WindowInspector` (API 29 and newer): on every frame for a second after a touch, a key press or a resume, and every half second otherwise. Each gets its own scanner, and covers there get their buttons through a transparent view added on top of the window. The settings screen and its dialogs are never scanned. Below API 29 these windows are not scanned.

**Text.** For each item it collects:

- `TextView` text (not `EditText`),
- content descriptions,
- text reported by the X and Instagram setter hooks,
- the accessibility tree of views that have an `AccessibilityNodeProvider` (Litho, Compose and similar), read through `onProvideVirtualStructure` with a minimal `ViewStructure`.

A cheap fingerprint of the item (view identities, texts, sizes, images) decides whether to read it again. An unchanged item is re-read at most once per second as a safety net. The text goes through the Java matcher and the decision rule, and, for style `spoilers`, the classifier. The classifier loads on the first item that needs it and is released when no work uses that style.

**Cover.** An opaque panel is drawn in the item's own `ViewGroupOverlay`, so it scrolls and animates with the item. It shows the contract's wording ("Mentions {t}", "Spoiler about {t}" and so on) and three buttons: "Show once", "I've seen it" and ⋮ for settings. On a short item, such as one line of a message, the message and the buttons sit side by side and the buttons shrink to fit. Touches on a cover go to the app until they turn into a scroll. A tap cancels the app's gesture and is handled by the blocker. A floating view that lies over the visible part of a covered item (for example YouTube's inline player) gets an opaque shade too (see "Where a cover counts" below). "Show once" is per post and lasts for the current process (see "Show once" below). While an item's pictures are being judged, each picture gets an opaque shade of its own, without text or buttons, and the post's text stays readable (the extension dims pending pictures instead; see [Images and video](#images-and-video)).

**Text and the decision rule.** The item's own text is read first. Any U+0001 in it is replaced by a space, so an app's text cannot pose as OCR text. The OCR text of the item's pictures follows it behind one U+0001 (at most the last 4,000 characters; contract rule 8), and `Matcher.evaluate` reads it as the extension's matcher does ([how-it-works.md](how-it-works.md#text-read-from-pictures)). Rule 7 is applied in `Scanner`: the post's own text is evaluated alone (`ownNames`) when the item has pictures. A model title is dropped when that text names any work, and per picture when the picture's OCR text names one (`ocrNames`). When the own text names a seen work and no covered one (`ownSeenOnly`), pictures cover nothing. The label lists text groups in the matcher's order (own text first, then OCR-only, then image titles). The classifier gets the text with the marker replaced by a line break.

**Where a cover counts.** A covered item is judged by the part of it that is visible on screen (`Scanner.visibleOnScreen`): its bounds clipped by its list and every other ancestor (`getGlobalVisibleRect`), and nothing at all when no part is visible. Three things use that rectangle. The shade of a floating view (`shadeFloaters`) applies only to a view that lies at least 90 percent over the visible part of the item and is 40 to 110 percent of the item's size; a view over the part the list does not show is not the item's. The touch lookup (`coverAt`) finds a cover only inside the visible part, so a cover never takes a tap outside its list or under a pinned bar. This stopped YouTube's watch-page player, pinned above the related list, from being shaded and muted while a covered row scrolled under it (the owner's report from 0.2.2; reproduced in the demo's `watch` screen, below). Not implemented: a "moves with the item" check. A pinned player that is drawn inside the list's own area and is about the size of a covered row could still match; no such case is known.

**Show once.** The key is the post's own text (never the text read from its pictures) with every number blanked (`\d[\d.,:]*` becomes `#`) and spaces collapsed (`Scanner.shownKey`). A post with no letters is keyed by the keys of its pictures instead, leaving out video players, whose key changes with every sampled frame. The last 500 posts are kept (`SpoilerBlock.revealed`, an insertion-ordered set), for the life of the process. It fixed "Show once" re-covering a post in X: the old key included the text of the post's ticking counters, so the key changed every time a like count moved. The trade-off: two posts with identical text share the choice, so showing one shows the other. The extension does the same without blanking numbers (see [Differences](#differences-from-the-extension)).

**YouTube row text.** A YouTube result row's content description is its title followed by metadata joined with " - ": "title - duration - Go to channel C - C - views - age - play video". `YouTubeText.strip` (used only when the host package name contains "youtube") cuts it to "title - channel" before matching, so durations, view counts, ages and button labels never reach the matcher (a "45 minutes" no longer matches a numeric title). It works from structure, not phrase lists: the views and the age are two neighbouring parts that start with a number, the channel is the part before them, and a part before the channel is metadata when it is empty, names the channel as its first or last words (the localised "go to channel" button) or is a duration. A Short is read in its own comma-separated shape. It was verified in English and Turkish against `test/fixtures/yt-rows.jsonl` (rows logged on the emulator; the Turkish ones with the app's language set to Turkish), through `YouTubeTextTest`. A description that fits no shape (an ad, another app's string) is left unchanged. A language that writes the number after the unit word ("views 223") would defeat it. In every app, the content description of a small tappable icon (a clickable `ImageView` of at most 64 dp in both directions: "Go to channel X", "Action menu", "Like") is skipped, because it is a button label, not the post's content.

**Colours.** A cover and the shade over a picture are coloured from the surface behind them (`Ui.on`, `Ui.surface`), not from the system night-mode setting. The surface is the first background of the view or one of its parents that is a solid colour (a colour, a gradient fill, the top solid layer of a layer drawable, a wrapped or state-dependent drawable; alpha at least 0xE0), then the theme's window background colour, and when none can be read the cover is dark. A surface that is dark by luminance gives a dark palette. The cover is the surface mixed 6% toward white (dark) or black (light). The picture shade is the surface mixed 10% the same way, so it is a tone of the host's own colour and close to the grey a host paints a picture's place with while it loads; when no surface is found it is the palette's cover colour lightened by 4%. The settings screen still uses the palette of the system setting.

**Touch.** The window touch hook (`TouchGate`) must be the outermost `Window.Callback`. Apps may wrap the callback after the blocker (Instagram's Reels viewer installs a gesture wrapper). `Scanner.gate()` runs on every frame of an activity window and on resume, and puts a new `TouchGate` on top when the callback is no longer one. A gate further in passes on what an outer gate of ours already saw (a depth counter), and the blocker's own cancel events do not re-enter the gate.

**Seen picker.** "I've seen it" on a cover whose names stand for one work marks it at once (`SpoilerBlock.markWorks`). With several works (a franchise name, an original and its remake) it opens `SeenPicker`, a plain framework dialog titled "Which have you seen?" with one checkbox per work not yet seen of every group the cover names (title, and `{type} · {year}` under it), nothing ticked, the note `Posts that only say "{t}" stay covered until every one is marked.` (or `This post names several works. It stays covered until each one is marked.` when the cover names several groups) and the buttons All (the first section only), Cancel and Mark seen. A second section, "More from this series", lists the other works of the same catalog series that are not yet seen, oldest first (`Matcher.moreFromSeries`, `SeenPicker.moreFromSeries`), with its own "All N" and, above six rows, a "Show N more" row. Its rows are optional; Mark seen is enabled when a row in either section is ticked. A cover for one work marks it at once and shows no picker, so it shows no second section. Mark seen is disabled until a work is ticked. Only the ticked works are written, in one write. The dialog is in the dark or light of the surface the cover sat on, and its window is on the `ownWindows` list, so the scanner never reads it.

**TalkBack.** A covered item is exposed to TalkBack as its cover: the message and the three buttons, as focusable and activatable nodes, through an accessibility delegate. The item's real content stays hidden from TalkBack. This works on API 29 and newer, and only for views that do not have an accessibility node provider of their own. On API 28, and on views that have one (Litho, Compose), the content is hidden from TalkBack and the cover is not readable. Tested only in the demo app on the emulator.

**Debugging aid: what the matcher received.** With the log tag raised to verbose, the scanner logs each item it evaluates: the item's class, the labels of the groups found and the exact text given to the matcher (line breaks written as `\n`, the OCR marker as `<U+0001>`), under the tag `SpoilerBlock`:

```sh
adb shell setprop log.tag.SpoilerBlock VERBOSE
adb logcat -s SpoilerBlock:V
```

Use it to see why a post was or was not covered. The log holds the text on the user's screen, so treat it as personal data and do not share it unread. `test/fixtures/yt-rows.jsonl` holds YouTube rows taken from logs of 0.2.2 builds.

### Notifications

A push notification can carry a spoiler in its preview. The patch rewrites every call of `NotificationManager.notify(int, Notification)` and `notify(String, int, Notification)` in the app's own code (including androidx and Firebase display code), so it goes through `Notifications.notify`. The call sites name the framework method, which obfuscation never renames. The patch logged 18 such call sites in YouTube 21.30.

If the decision rule covers the notification's text, it is posted with its text replaced by the cover label, and with the title replaced by "SpolierBlock" when the title names the work too. The lock-screen version is removed. Anything else, and any error, posts the original notification, so a notification is never lost. If the index has not loaded yet, the notification is posted unchecked. In style `spoilers` the classifier runs off the main thread with a 10 second limit, and on the main thread the notification is covered without waiting. Verified only with the demo app's push from a background thread on the emulator.

### Images and video

The Android pipeline is a port of the browser's (see [how-it-works.md](how-it-works.md#images-and-video)). Both run the same models on ONNX Runtime 1.22: the title model is SigLIP 2 base/32 (weights in int8) and OCR is PaddleOCR v5 (detector and English recogniser). The Java code is `Images.java` (scan, capture, queue, models), `Clip.java` (title verdict), `Ocr.java` (OCR) and `Accel.java` (hardware acceleration).

With "Scan images and video" on, `ImageView`s that are at least 96 dp in both directions and show a drawable other than a plain colour are scanned.

- **Capture.** The image view's own drawable is drawn into a `RenderNode`, rendered off screen by a `HardwareRenderer` into an `ImageReader`, and the result is scaled to at most 1280 px on the long side (the size the extension's OCR reads). It does not call `View.draw`: drawing the view on a hardware canvas put the host's own render nodes into the capture renderer, which can take their damage and leave stale regions on devices with partial screen updates. That was the suspected cause of a feed that jumped on a real phone. The change was checked by the demo app's frame checks on the emulator. The owner ran 0.2.0 on a phone and has not reported the jump again; no frame counter or log from that run is kept here, and it was not checked in X separately. One capture is done per frame. A queue of 8 jobs is kept, newest first. Below Android 10, and for animated images, the capture draws in software; hardware bitmaps then fail closed.
- **Resize.** The picture is squashed to the model's 256 x 256 input by a Java port of `src/background/pixels.js` (`Images.visionPixels`): a separable triangle filter like PIL's antialiased bilinear, the whole picture without a crop. The browsers use the same function, so the numbers agree. `ClipTest` requires pixel values within 1 of the extension's (4 values were off by 1 in 75 images).
- **Title check.** `Clip.java` is the title verdict of `engine.js`: the cosine to the shipped int8 title rows (`clip-text.bin`), compared with the generic prompts, with the cut-offs and prompts read from `clip-meta.json` (minimum score, margin, title gap, media gate). Title checks that wait together run as one batch of up to 4, as in the engine.
- **OCR.** `Ocr.java` is `ocr.js` step for step: detector input up to 960 px, a probability map thresholded at 0.3, boxes, a recogniser pass per box, lines with a mean confidence of at least 0.6, read in rows. A run past 10 seconds is stopped and counts as a failure. The text joins the item's text for matching.
- **Cache and scope.** A pixel hash cache (500 entries, keyed by the hash of the model's 256 x 256 input) avoids judging the same picture twice. Images are judged only when they could change the outcome: scanning on, and unlisted works covered, unrecognised images covered, or at least one work blocked. The image models are released when "Scan images and video" is turned off.
- **Video frames.** An on-screen `TextureView` or `SurfaceView` inside an item is sampled (`Images.captureVideo`): a `TextureView` is read with `getBitmap`, a `SurfaceView` with `PixelCopy`, neither draws or lays out the host's views. The frame is at most 448 px on the long side and a new one is taken every 5 seconds (it is part of the picture's key). It goes through the same title check and OCR as a picture. The last frame's verdict holds until the next is in, and a player stays shaded until its first frame has a verdict. A frame that cannot be read (a protected surface) gives no verdict and no shade, so the post's text and pictures still count. A `TextureView` is shaded in its parent's overlay, because it draws only its layer. A player that floats over a list instead of sitting in the item (YouTube's inline feed player) is not inside the item and is not sampled (a `shortcut` comment in `Images.java`). This replaces the earlier "video frames are not scanned": thumbnails and posters were always scanned, frames are new in 0.2.2 and have run only in the demo.
- **Early load and saved verdicts.** The image models load when the first activity resumes, when images matter for the current settings (`Images.prewarm`), so the load overlaps the host's own start instead of following its first feed. A picture whose verdict is known (from this run or a saved one) is answered on the capture thread without waiting for the models. Each verdict is applied as soon as it is ready, not when its batch ends. Verdicts are saved across restarts in `spoilerblock-images.bin` in the app's cache directory (`getCacheDir()`; the system may clear it), keyed by the pixel hash. A file is used only for the same build of the app (the package's last update time) and the same file version. It is written when the queue runs dry and at most every 5 seconds while busy, with the OCR text cut at 8,000 characters, and it never leaves the device. It is read again when scanning is switched back on.
- **Pending and failed pictures.** A picture whose verdict is not in yet gets an opaque shade over just that picture, in the picture's own overlay (no text, no buttons). The post's text stays readable, and only a verdict covers the post. A failed check (a capture or model failure, or OCR that timed out) leaves the picture shaded. The wording is in the [contract](agents/contract.md).
- **Threads.** The CPU sessions use half the cores, at most 4, and do not spin between runs. The classifier uses 1 thread. The worker thread runs at background priority. XNNPACK is not used: it was slower (690 ms alone and 355 ms in a batch of 4 on the emulator, against 333 and 155 ms for the CPU session) and crashed on 1.22.

**Hardware acceleration** (`Accel.java`). The vision model can run on NNAPI instead of the CPU. The shipped model has int8 weights, which only run on the CPU, so the accelerated session folds them to float when it is created (in memory, there is no second model file). It is used only if all of these hold:

- the device has at least 6 GB of memory (the float weights take about 330 MB more; +550 MB of native heap was measured on the emulator) and Android 8.1 or newer;
- a bundled reference picture (generated in code) gives an embedding with cosine of at least 0.99 against the CPU result, and the accelerated run is faster;
- no earlier attempt on this install took the app down. A marker is written before the first accelerated run and cleared after it. If it is found set at the next start, acceleration is turned off for good on that install.

The check runs once and is repeated after an app or OS update. Later starts run the reference picture once on the accelerated session to be sure it still works. A failed accelerated run falls back to the CPU session, and the CPU is kept until the next app or OS update. When acceleration wins, the CPU vision session is dropped, so one copy of the weights is in memory. The current mode is shown in Settings > About. OCR always runs on the CPU.

**Startup on the emulator** (x86_64, a logged-out YouTube search, seconds after process start; the `cold start:` line in logcat under the tag `SpoilerBlock`, one run per figure, so read them as indicative):

| | Before 0.2.2 | After, pictures not seen before | After, pictures seen before (saved verdicts) |
|---|---|---|---|
| First verdict | 3.9 to 4.2 s | 3.3 to 3.4 s | 1.9 to 2.3 s |
| Every picture on screen judged | 5.5 to 5.8 s | 4.9 to 5.1 s | 2.0 to 2.8 s |

**What was measured, and where.** Only on the x86_64 emulator, with 2 threads: a title check takes 333 ms for one picture and 155 ms per picture in a batch of 4, and OCR 196 ms per picture in the fixture run. Parity with the extension on the fixtures (`ClipTest`, `OcrTest`, and the demo's on-device check): 0 of 75 title verdicts differ, and 21 of 21 OCR texts are identical. **Hardware acceleration, arm64 speed and every figure above have never been measured on a real phone** (the owner's 0.2.0 run on a Galaxy S25+ gave no numbers). The emulator's x86_64 numbers say little about a phone.

## Settings

The full-screen settings screen has the same five parts as the extension's settings page: Library, Add by hand, Blocking, Data and About. It is built in code from plain framework views (`SettingsActivity.java`, `Ui.java`), because the extension is merged into other apps and has no resources of its own. One implementation serves both the companion app, where it is the launcher activity, and the patched apps, where the patch adds it to the manifest.

It opens from:

- the ⋮ button on a cover,
- a dynamic app shortcut, "SpolierBlock settings" (long-press the app icon). It is the way back in when blocking is switched off, because no cover is visible then,
- a "SpolierBlock" row in the host's own settings, where the patch knows the screen:

  | App | Row |
  |---|---|
  | YouTube | Added to both settings lists (`settings_fragment.xml` and the "Cairo" one, `settings_fragment_cairo.xml`). Verified on the emulator. |
  | X | Added to `settings_root.xml` (order 105). Present in the patched file. Not seen working by an agent; the owner has not reported on it. |
  | Instagram | None. Its settings come from server data, so there is no preference file to add a row to. |
  | Demo apps | Added to the demo's own settings. |

  A missing screen in another app version only loses the row (the patch logs a warning). The cover's ⋮ button and the shortcut always work.

The Library can select several works at once, as the extension's does: long-press a work, or press "Select". Each row then has a checkbox, the header reads "Select all N shown" (N is the number of works the filter and search show) or "N selected", and the actions are Seen, Blocked, Style (Default, Everything, Spoilers only) and Remove, each one write for all selected works. "Done" and the back button leave selection first.

The About part shows the version from `SettingsActivity.VERSION` (0.2.3, matching `android/gradle.properties`).

The Data part exports and imports `spolierblock-config.json` (the contract's export file) through the system document picker, so neither the companion app nor the patch needs a storage permission. It also holds the catalog update setting and a reset.

"Update now" runs one update at once, even when the setting is off. The status line shows the catalog size, the number of added titles, the time of the last success and the last error. An updated index is stored as `spoilerblock-index.dat` in the app's files directory, and dropped if it was built from a different bundled catalog. The index is rebuilt in the background when hand-added works change (and, as in the extension, hand-added works are indexed with popularity 1,000).

Resource use:

- The index is loaded on the first activity, not in `Application.onCreate`.
- Style `all` loads no model. The classifier loads on the first item that needs it and is released when no work uses style `spoilers`.
- The image models are released when "Scan images and video" is turned off.
- The catalog update runs on a low-priority thread and is the only network use. It queries `https://query.wikidata.org/sparql` with the same rules as the extension, including the narrative filter and the `other` lookup.

## Parity tests

The Java code is a port of the extension's. Tests check that Java gives the same answers as the JavaScript. The expected values are produced by the extension's own code, not restated by hand.

1. Build `dist/` (`npm run build`), then generate vectors from the repository root:

   ```sh
   node android/tools/vectors.mjs
   node android/tools/catalog-vectors.mjs
   node android/tools/spoiler-vectors.mjs
   node android/tools/clip-vectors.mjs
   ```

   They write to `android/build/vectors/`. `vectors.mjs` also asserts that `dist/firefox/data/index.bin` is what `data/catalog.json` builds. `clip-vectors.mjs` runs the extension's own `pixels.js`, `engine.js` title check and `ocr.js` on the fixture images (it imports `sharp`, which comes with `@huggingface/transformers`).

2. Run the Java tests:

   ```sh
   cd android
   ./gradlew :extensions:blocker:testDebugUnitTest
   ```

| Test class | Checks |
|---|---|
| `MatcherTest` | The matcher on hand-written cases and a seeded random corpus, on the fixture catalog and the shipped index. |
| `CatalogTest` | The index builder, and the catalog update: same queries sent, same index bytes. |
| `ClassifierTest` | The tokenizer's token ids and the classifier's probabilities. |
| `ClipTest` | The title verdict on the fixture images: on the extension's own 256 x 256 pixels, and after Java's own resize (`Images.visionPixels`). Needs 0 differing verdicts and pixel values within 1 of the extension's. |
| `OcrTest` | `Ocr.java` reads the OCR fixtures to the same text as `ocr.js`. Runs in its own Gradle task, see below. |
| `ConfigTest` | The config: defaults, merge patches, migration from 0.1, the export file and its refusals, import merge, the merge into the companion, the decision rule and the provider's caller check. |
| `CustomWorkTest` | Hand-added works are indexed as the extension indexes them: same popularity value, aliases as given, lower-case matching. |
| `YouTubeTextTest` | `YouTubeText.strip` on the rows of `test/fixtures/yt-rows.jsonl` and on hand-written English and Turkish videos and Shorts. |
| `ShownKeyTest` | `Scanner.shownKey`: counters and picture keys do not change the key, other text does, a post without words is keyed by its pictures. |
| `SeenPickerTest` | The picker's two notes. |

The three new classes (0.2.3) were not run for this page.

`testDebugUnitTest` skips `OcrTest` and is finalised by the task `ocrTestDebugUnitTest`, which runs only `OcrTest`, on desktop ONNX Runtime 1.32.0. The desktop (Linux x86-64) builds 1.22 to 1.31 give the PP-OCR v5 detector a blank probability map, so the test would find no text. The Android 1.22 build is fine (it read all 21 OCR fixtures like the extension in the demo's on-device check), so the app stays on 1.22. `SB_LIVE=1 ./gradlew :extensions:blocker:testDebugUnitTest` also runs one opt-in test against the live Wikidata endpoint. The tests run with a 1 GB heap.

## Demo app

`android/demo` is a test app, not part of the bundle. It has two flavours that install side by side: `one` (`dev.spoilerblock.demo`) and `two` (`dev.spoilerblock.demo2`). Both are patched alike, so a work marked seen in one is seen in the other through the shared config.

The main screen is a feed of 240 items that mixes plain text views, text drawn on a canvas and exposed only through a content description, text exposed only through an accessibility node provider, text exposed nowhere (reached only by a setter hook), clean posts, ambiguous titles and a nested horizontal shelf. It knows which items must be covered and checks every drawn frame, counting frames and logging mismatches under the tag `SBDemo`. Its release build is minified, like the real apps. Rows of type quote (every 25th post, offset 18) are clean posts that quote another: the quote is drawn by `QuoteBox`, a view that keeps the text in a field and lays it out in `onMeasure`, like X's `QuoteView`. Only the patch's field hook can read it, so only the quote can cover the row. A screen of full-screen pages (`--es screen reels`, `Reels.java`) plays sound and a `TextureView`, one page per swipe, with an Instagram-style wrapper: after the activity resumes it wraps the window callback and keeps every plain tap to itself, as Instagram's Reels viewer does, so the demo checks that the blocker's gate gets back in front. A second screen (`--es screen more`) holds the places a spoiler reaches outside a feed: a direct-message conversation, a bottom sheet, search suggestions and a test push notification. Another (`--es screen settings`) is a preference settings screen that carries the patch's settings row. A TextureView row stands in for a video player: its frames (plain colours, no title) are sampled like a real player's. Since 0.2.3 the player rows carry a like counter that ticks every 300 ms (`MainActivity.Counter`, as X's counters do), and `--ei watchShown N` makes the test show post N once and then reports a mismatch if its row is ever covered again. A watch screen (`--es screen watch`, `Watch.java`) pins a player with sound at the top and scrolls a list of related rows under it, every other one covered. It counts, in the log, taps that reached the player and shades put on it: both must stay 0 (a mismatch is logged as `pinned ... shaded`).

| Script | What it does |
|---|---|
| `android/tools/demo-build.sh` | Builds the bundle, both demos and the companion, copies the unpatched APKs to `android/out/` (`demo-unpatched.apk`, `demo2-unpatched.apk`, `spolierblock-companion-debug.apk`), then patches both demos with `apply.sh` into `demo-patched.apk` and `demo2-patched.apk`. |
| `android/tools/mock-sparql.mjs [port=8765]` | A mock of Wikidata's SPARQL endpoint with a few invented works. The demo patch points the catalog update at `http://10.0.2.2:8765/sparql`, the emulator's view of the host. `curl localhost:8765/mode?set=ok\|429\|malformed` changes its answer mode. |
| `android/tools/demo-fling.sh [revealed]` | Needs `adb`. Fling stress on the installed demo (the first flavour). Prints mismatches from logcat. |
| `android/tools/demo-jank.sh <label>` | Needs `adb`. Frame times over a fixed swipe script (`dumpsys gfxinfo`). |
| `android/tools/tap-text.sh <text>` | Needs `adb`. Taps the first on-screen node whose text or description equals the argument. |
| `android/tools/spoiler-eval-compare.mjs` | Compares an on-device classifier run with the extension's probabilities. Feed it `adb logcat -d -s SBEVAL:I` on stdin. |

The demo's intent extras `spoilerEval` and `imageEval` start on-device runs of the classifier and the image model, whose results can be compared with the extension's. The demo patches are the only ones that ship the `test-endpoint.txt` asset.

### Sound

A cover silences what it covers. The patch rewrites the app's own calls of `AudioTrack.play`, `setVolume`, `setStereoVolume` and `MediaPlayer.start`, `setVolume` so they go through a registry (`Media.java`) that remembers each player and the volume the app last asked for. While a cover hides a video surface (inside the item or floating over it) or fills at least 60% of the window (Reels, Shorts), every known player in the app plays at volume 0, and volume changes the app makes meanwhile are only remembered. Sound returns when the cover goes, the window goes to the background, blocking is switched off, or the blocker disables itself after an error. The device's stream volume and mute state are never touched.

Call sites rewritten in the 0.1 patched files: YouTube 4 `AudioTrack.play` and 5 `MediaPlayer.start`, Instagram 11 and 28, X 8 and 10. Limits: an uncovered video playing next to a covered one is muted too; the covered video keeps playing silently; YouTube's VR/360 audio (`libgvr_audio.so`, OpenSL ES) is not reached; a covered video can sound for a few seconds after the app starts, until the index has loaded. Verified in the demo app on the emulator (an `AudioTrack` feed row and a `MediaPlayer` pager). The owner reports that a covered reel was muted on the real phone with the 0.2.0 bundle (not measured by an agent).

## Not covered

- YouTube comments. The comments list is scanned, but its rows draw their own text (Litho): there is no `TextView`, no content description, and the accessibility tree carries no comment text unless an accessibility service is running. A fix needs a YouTube-specific hook on Litho's text drawable (`com.facebook.litho.TextContent` keeps its name; its implementation is obfuscated). Seen on the logged-out emulator build. Shorts comments and live chat were not checked.
- Comments in X and Instagram were not checked (no account).
- YouTube's inline feed player is not sampled for video frames: it floats over the list. Its thumbnail and the item's text still count.
- Android differs from the extension in a few details: see [Differences from the extension](#differences-from-the-extension).

Real-device status (the owner's reports, not measured by an agent): with 0.2.0, covers and buttons worked in the YouTube and X feeds, a covered reel was muted, and the feed jump was not reported again; with 0.2.2 he confirmed that the picker, the covers and the colours work. He reported "Show once" re-covering in X, the watch-page player blacked out, franchise entries missing from the picker, wrong works for bare names and a rapper matched as a film: the 0.2.3 changes address these. Not tested:

- The 0.2.3 changes on a phone: "Show once" per post, the visible-part rule for covers, the YouTube row cleanup, the picker's second section. They ran only on the emulator and in the demo.
- A watch-page player drawn inside the list's own area (see "Where a cover counts").
- The 0.2.2 changes on a phone that the owner did not name: early loading and saved verdicts, video-frame sampling, the multi-select library.
- The Reels touch fix and the X quoted-post hook. Both come from reading the APKs (Instagram 452.1, X 12.19.1) and never ran in Instagram or X.
- The audio hooks in YouTube and X (the owner's report names a reel).
- The X settings row, and comments in X and Instagram.
- Firefox for Android.
- NNAPI acceleration, arm64 speed and every speed and memory figure on a phone. The figures above are from the x86_64 emulator with 2 threads. The only memory figure is the emulator's +550 MB for the accelerated session.
- Using the bundle as a local source in Morphe Manager (see above).
- Updating a patched app after the host app updates: the patch does not fingerprint, so it is expected to apply to a new version, but only the versions in the table above were tried.
- Lists drawn by Jetpack Compose, and windows below API 29.

## Differences from the extension

The contract is the same on both platforms; these details differ and are not in it:

- Order of "Image from" and "Spoiler about". Android decides "Image from" first: a post with a spoilers-style text match and a titled picture is labelled "Image from {t}" and the classifier is not asked (`Scanner`). The extension asks the classifier and labels "Spoiler about {t}" when it says spoiler, and "Image from {t}" otherwise (`decide` in `content.js`).
- Names in a label. When "Mentions" applies, Android lists every covered text group in the label ("and N more" counts them), including spoilers-style ones; the extension counts only the style-`all` groups.
- Mark seen in the picker is disabled on Android until a work is ticked; in the extension it is enabled and writes nothing when nothing is ticked.
- "Show once" keys. Android blanks the numbers in the post's text (ticking counters) and keeps 500 posts; the extension collapses whitespace only and keeps at most 500 posts too. A textless post is keyed by its pictures on both (on Android without video players).
- A failed picture check stays shaded on Android; the extension reveals it after its retries (see the contract).
