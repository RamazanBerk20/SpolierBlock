# Android

The Android part is a [Morphe](https://github.com/MorpheApp) patch bundle (version 0.2.0) and a companion app. The bundle adds one app-agnostic Java extension to a host app. Thin per-app patches inject it. The companion app, `dev.spoilerblock`, owns the settings that every patched app shares.

Read the [limits in the README](../README.md#status-and-known-limits) first. In short: it has only run in an x86_64 emulator, nothing has run in X or Instagram feeds or on a real phone, and patching these apps is against the services' terms. The config, the decision rule and the cover wording are in [agents/contract.md](agents/contract.md). The Java code follows them, and `ConfigTest` and `CustomWorkTest` check it.

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
3. Writes the models under `assets/spoilerblock/`: the spoiler classifier (`spoiler/`), the image model and its title matrix (`clip/`), and the OCR data (`ocr/eng.traineddata.gz`). They are loaded only when the matching feature is used. See [Images](#images-and-video) for the state of the image files.
4. Adds native libraries: `libonnxruntime.so`, `libonnxruntime4j_jni.so` and the Tesseract set (`libjpeg.so`, `libpngx.so`, `libleptonica.so`, `libtesseract.so`), for `arm64-v8a` and `x86_64`.
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

   The bundle is written to `android/patches/build/libs/patches-0.2.0.mpp`. The version comes from `version` in `android/gradle.properties`. The 0.1 bundle was about 112 MB. If `dist/firefox/data` lacks one of the six catalog files, the build stops and tells you to run `npm run build`.

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

### Manifest and native libraries

- New library files are written compressed into the APK. That only installs with `extractNativeLibs=true`. X declares `false`, so the patch sets it to `true`. X's own libraries stay stored in the APK and are now also extracted at install. YouTube and Instagram already extract.
- The patch adds libraries only to ABI folders the app already has. A new ABI folder would make a device of that ABI pick it and lose the app's own libraries. If the app has no native code at all, it gets both.
- The libraries have unique names (`libonnxruntime*.so`) and a statically linked C++ runtime.
- Tesseract4Android's libraries have generic names (`libjpeg.so`, `libpngx.so`, `libleptonica.so`, `libtesseract.so`). The patch rewrites their sonames, and the references between them, to same-length SpoilerBlock names (`libsbjp.so`, `libsbpn.so`, `libsbleptoni.so`, `libsbtessera.so`). They never bind to a host library that happens to share a soname.
- If the host app already ships one of these files for an ABI, it is kept and a warning is logged. Then style `spoilers` fails closed if the host's version does not fit.
- Besides `extractNativeLibs`, the patch adds an activity and a `<queries>` entry to the manifest, assets, libraries, one `onCreate` call, the notification call rewrites and the settings rows. It does not edit shared classes or resources otherwise, which is why it can run next to other patches, such as the official ones.

## Using the bundle in Morphe Manager

Not verified on a real device. The bundle is an ordinary `.mpp` file, so the intent is to add `patches-0.2.0.mpp` as a local patch source in Morphe Manager and enable `SpoilerBlock` together with the other patches you want. The menu steps are not described here because they could not be checked in this repository. If you do this, also read the signing notes above.

## How text and pixels are captured

The blocker uses only public Android APIs on the host's views.

**Feed items.** A `Scanner` is attached to each activity window. Before every frame (`OnPreDrawListener`, after layout and before draw) it looks at the children of the window's scrolling containers. A container is an `AbsListView`, a view that can scroll, or a view whose class name (or a superclass name) ends in `RecyclerView`, `ViewPager`, `ViewPager2` or `ScrollView`. It finds containers again when the layout changes or every 500 ms. Nested lists inside an item are judged item by item. A list drawn by Jetpack Compose is not made of such views, so it is not recognised as a container (not tested).

**Other windows.** Dialogs, bottom sheets, popup menus and drop-downs (search suggestions) are windows of their own, not part of the activity's. The blocker finds their root views with `WindowInspector` (API 29 and newer): on every frame for a second after a touch, a key press or a resume, and every half second otherwise. Each gets its own scanner, and covers there get their buttons through a transparent view added on top of the window. The settings screen and its dialogs are never scanned. Below API 29 these windows are not scanned.

**Text.** For each item it collects:

- `TextView` text (not `EditText`),
- content descriptions,
- text reported by the X and Instagram setter hooks,
- the accessibility tree of views that have an `AccessibilityNodeProvider` (Litho, Compose and similar), read through `onProvideVirtualStructure` with a minimal `ViewStructure`.

A cheap fingerprint of the item (view identities, texts, sizes, images) decides whether to read it again. An unchanged item is re-read at most once per second as a safety net. The text goes through the Java matcher and the decision rule, and, for style `spoilers`, the classifier. The classifier loads on the first item that needs it and is released when no work uses that style.

**Cover.** An opaque panel is drawn in the item's own `ViewGroupOverlay`, so it scrolls and animates with the item. It shows the contract's wording ("Mentions {t}", "Spoiler about {t}" and so on) and three buttons: "Show once", "I've seen it" and ⋮ for settings. On a short item, such as one line of a message, the message and the buttons sit side by side and the buttons shrink to fit. Touches on a cover go to the app until they turn into a scroll. A tap cancels the app's gesture and is handled by the blocker. A floating view that lies over a covered item (for example YouTube's inline player) gets an opaque shade too. "Show once" lasts for the current process. While an item's pictures are being judged it shows "Checking image…" (Android only; the extension dims pending pictures instead).

**TalkBack.** A covered item is exposed to TalkBack as its cover: the message and the three buttons, as focusable and activatable nodes, through an accessibility delegate. The item's real content stays hidden from TalkBack. This works on API 29 and newer, and only for views that do not have an accessibility node provider of their own. On API 28, and on views that have one (Litho, Compose), the content is hidden from TalkBack and the cover is not readable. Tested only in the demo app on the emulator.

### Notifications

A push notification can carry a spoiler in its preview. The patch rewrites every call of `NotificationManager.notify(int, Notification)` and `notify(String, int, Notification)` in the app's own code (including androidx and Firebase display code), so it goes through `Notifications.notify`. The call sites name the framework method, which obfuscation never renames. The patch logged 18 such call sites in YouTube 21.30.

If the decision rule covers the notification's text, it is posted with its text replaced by the cover label, and with the title replaced by "SpolierBlock" when the title names the work too. The lock-screen version is removed. Anything else, and any error, posts the original notification, so a notification is never lost. If the index has not loaded yet, the notification is posted unchecked. In style `spoilers` the classifier runs off the main thread with a 10 second limit, and on the main thread the notification is covered without waiting. Verified only with the demo app's push from a background thread on the emulator.

### Images and video

<!-- TODO(port): verify after the Android image port lands. This section describes the code at commit 19cccb7 (version 0.2.0), where Android still has the 0.1 image pipeline and the browser has the new one. -->

At this commit the Android image pipeline is the 0.1 one, and the browser's is not.

With "Scan images and video" on, `ImageView`s that are at least 96 dp in both directions and show a drawable other than a plain colour are scanned.

- Capture: the image view's own drawable is drawn into a `RenderNode`, rendered off screen by a `HardwareRenderer` into an `ImageReader`, and the result is scaled to at most 768 px on the long side. It does not call `View.draw`: drawing the view on a hardware canvas put the host's own render nodes into the capture renderer, which can take their damage and leave stale regions on devices with partial screen updates. That is the suspected cause of a feed that jumped on a real phone. The change was checked only by the demo app's frame checks on the emulator. It was never tried on a phone or in X. One capture is done per frame. A queue of 8 jobs is kept, newest first.
- Title check: CLIP ViT-B/32 (int8) against the shipped title matrix, with the media gate, minimum score, margin and title gap of `data/clip-meta.json` (`Clip.java`). The Java code mirrors the 0.1 `clipCheck`.
- OCR: Tesseract (Tesseract4Android, `eng` data `4.0.0_best_int`, LSTM engine), mean confidence of at least 60, a 10 second limit. The text joins the item's text for matching.
- A pixel hash cache (500 entries) avoids judging the same picture twice.
- An item is covered as "Checking image…" until its images have verdicts. A capture or model failure keeps it covered. Below Android 10 the capture draws in software, and hardware bitmaps fail closed.
- Video frames are not scanned. Only the `ImageView` thumbnails are.
- The image model session uses 2 threads, the classifier 1 thread.
- Images are judged only when they could change the outcome: scanning on, and unlisted works covered, unrecognised images covered, or at least one work blocked.

Known mismatch at this commit, read from the build files and not run: the patch build and `android/tools/clip-vectors.mjs` still read `dist/firefox/models/clip/onnx/vision_model_quantized.onnx`, which the 0.2 browser build no longer writes (it writes `models/vision/model.onnx`), and `clip-meta.json` and `clip-text.bin` now describe the SigLIP 2 rows. So the bundle and `ClipTest` need the image port before they build and pass again.

## Settings

The full-screen settings screen has the same five parts as the extension's settings page: Library, Add by hand, Blocking, Data and About. It is built in code from plain framework views (`SettingsActivity.java`, `Ui.java`), because the extension is merged into other apps and has no resources of its own. One implementation serves both the companion app, where it is the launcher activity, and the patched apps, where the patch adds it to the manifest.

It opens from:

- the ⋮ button on a cover,
- a dynamic app shortcut, "SpolierBlock settings" (long-press the app icon). It is the way back in when blocking is switched off, because no cover is visible then,
- a "SpolierBlock" row in the host's own settings, where the patch knows the screen:

  | App | Row |
  |---|---|
  | YouTube | Added to both settings lists (`settings_fragment.xml` and the "Cairo" one, `settings_fragment_cairo.xml`). Verified on the emulator. |
  | X | Added to `settings_root.xml` (order 105). Present in the patched file; X was never run, so it has never been seen working. |
  | Instagram | None. Its settings come from server data, so there is no preference file to add a row to. |
  | Demo apps | Added to the demo's own settings. |

  A missing screen in another app version only loses the row (the patch logs a warning). The cover's ⋮ button and the shortcut always work.

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

   They write to `android/build/vectors/`. `vectors.mjs` also asserts that `dist/firefox/data/index.bin` is what `data/catalog.json` builds. `clip-vectors.mjs` needs the old image model file (see the mismatch above).

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
| `ClipTest` | The image verdict on the fixture images. |
| `ConfigTest` | The config: defaults, merge patches, migration from 0.1, the export file and its refusals, import merge, the merge into the companion, the decision rule and the provider's caller check. |
| `CustomWorkTest` | Hand-added works are indexed as the extension indexes them: same popularity value, aliases as given, lower-case matching. |

`SB_LIVE=1 ./gradlew :extensions:blocker:testDebugUnitTest` also runs one opt-in test against the live Wikidata endpoint. The tests run with a 1 GB heap.

## Demo app

`android/demo` is a test app, not part of the bundle. It has two flavours that install side by side: `one` (`dev.spoilerblock.demo`) and `two` (`dev.spoilerblock.demo2`). Both are patched alike, so a work marked seen in one is seen in the other through the shared config.

The main screen is a feed of 240 items that mixes plain text views, text drawn on a canvas and exposed only through a content description, text exposed only through an accessibility node provider, text exposed nowhere (reached only by a setter hook), clean posts, ambiguous titles and a nested horizontal shelf. It knows which items must be covered and checks every drawn frame, counting frames and logging mismatches under the tag `SBDemo`. Its release build is minified, like the real apps. A second screen (`--es screen more`) holds the places a spoiler reaches outside a feed: a direct-message conversation, a bottom sheet, search suggestions and a test push notification. Another (`--es screen settings`) is a preference settings screen that carries the patch's settings row. A TextureView row stands in for video content that no image capture can reach.

| Script | What it does |
|---|---|
| `android/tools/demo-build.sh` | Builds the bundle, both demos and the companion, copies the unpatched APKs to `android/out/` (`demo-unpatched.apk`, `demo2-unpatched.apk`, `spolierblock-companion-debug.apk`), then patches both demos with `apply.sh` into `demo-patched.apk` and `demo2-patched.apk`. |
| `android/tools/mock-sparql.mjs [port=8765]` | A mock of Wikidata's SPARQL endpoint with a few invented works. The demo patch points the catalog update at `http://10.0.2.2:8765/sparql`, the emulator's view of the host. `curl localhost:8765/mode?set=ok\|429\|malformed` changes its answer mode. |
| `android/tools/demo-fling.sh [revealed]` | Needs `adb`. Fling stress on the installed demo (the first flavour). Prints mismatches from logcat. |
| `android/tools/demo-jank.sh <label>` | Needs `adb`. Frame times over a fixed swipe script (`dumpsys gfxinfo`). |
| `android/tools/tap-text.sh <text>` | Needs `adb`. Taps the first on-screen node whose text or description equals the argument. |
| `android/tools/spoiler-eval-compare.mjs` | Compares an on-device classifier run with the extension's probabilities. Feed it `adb logcat -d -s SBEVAL:I` on stdin. |

The demo's intent extras `spoilerEval` and `imageEval` start on-device runs of the classifier and the image model, whose results can be compared with the extension's. The demo patches are the only ones that ship the `test-endpoint.txt` asset.

## Not covered

- Real phones, Firefox for Android, and the X and Instagram feeds were not tested. Nothing has run in X or Instagram, and everything on Android ran only in an emulator.
- The X settings row has never been run.
- The capture change that is meant to stop the feed from jumping was checked only by frame counters in the demo on the emulator.
- No Android latency or memory figures are published here. `research/REPORT.md` has none for Android.
- Updating a patched app after the host app updates: the patch does not fingerprint, so it is expected to apply to a new version, but only the versions in the table above were tried.
- Lists drawn by Jetpack Compose, and windows below API 29.
