# Android

The Android part is a [Morphe](https://github.com/MorpheApp) patch bundle. It adds one app-agnostic Java extension to a host app. Thin per-app patches inject it.

Read the [limits in the README](../README.md#status-and-known-limits) first. In short: it has only run in an x86_64 emulator, X and Instagram were only launched to their login screens, and patching these apps is against the services' terms.

## What the patch does

The bundle contains one patch, `SpoilerBlock` (enabled by default), registered once per target app.

| App | Package | Tested version | APK type |
|---|---|---|---|
| YouTube | `com.google.android.youtube` | 21.30.216 | APK |
| X | `com.twitter.android` | 12.19.1-release.0 | APKM |
| Instagram | `com.instagram.android` | 452.1.0.53.64 | APKM |

Other versions are marked experimental in the patch. Nothing is fingerprinted, so a different version may work, but it has not been tried.

For each app the patch:

1. Merges the extension (`extensions/blocker.mpe`, package `dev.spoilerblock`) into the app.
2. Writes the matcher index and catalog files under `assets/spoilerblock/`: `index.bin`, `index.json`, `catalog.json`, `common-words.txt`, `catalog-classes.json`, `catalog-info.json`.
3. Writes the models under `assets/spoilerblock/`: the spoiler classifier (`spoiler/`), the CLIP vision model and text matrix (`clip/`), and the OCR data (`ocr/eng.traineddata.gz`). They are loaded only when the matching feature is used.
4. Adds native libraries: `libonnxruntime.so`, `libonnxruntime4j_jni.so` and the Tesseract set (`libjpeg.so`, `libpngx.so`, `libleptonica.so`, `libtesseract.so`), for `arm64-v8a` and `x86_64`.
5. Adds one call, `SpoilerBlock.init(Application)`, at the start of `Application.onCreate`. The Application class is read from the manifest, then the first class up its hierarchy that implements `onCreate()` is patched. Nothing depends on obfuscated names.
6. For X and Instagram, adds text hooks (see below).

The patch changes no permissions. The three apps already hold the network permission the catalog update needs.

If anything in the blocker throws, it disables itself for the session and removes every cover, so the host app stays usable.

## Prerequisites

| Need | Detail |
|---|---|
| JDK 21 or newer | `apply.sh` and `demo-build.sh` look in `$JAVA_HOME`, then `$HOME/.local/jdks/jdk-21.0.13+9`. `apply.sh` falls back to `java` on `PATH` and checks the version. |
| Android SDK | Gradle reads `android/local.properties` (not in git): `sdk.dir=<path to the SDK>`. `apply.sh` reads an `.apk`'s package name with `aapt2` from `$ANDROID_HOME/build-tools/*` (default `$HOME/Android/Sdk`). `.apkm` and `.xapk` files do not need it. |
| `unzip`, `git`, `gh` | `bootstrap-morphe.sh` clones with `git` and downloads the CLI with `gh`. `apply.sh` reads bundles with `unzip`. |
| Node.js and npm | To run `npm run build` first. The bundle packs its data from `dist/firefox`. |
| Your own APKs | Not in the repository. Put them in `android/apks/` (ignored by git) or anywhere else. |
| `adb` | Only for `--install` and for the device scripts. |

Gradle uses the wrapper (Gradle 9.9.1). `android/gradle.properties` limits it to a 2 GB heap, 2 workers and a 1 GB Kotlin daemon.

## Build the bundle

Run these from the repository root unless stated.

1. Build the extension data. The bundle packs `dist/firefox/data`, `dist/firefox/models/clip` and the OCR data from `node_modules`.

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

   The bundle is written to `android/patches/build/libs/patches-0.1.0.mpp`. The version comes from `version` in `android/gradle.properties`. The file is about 112 MB. If `dist/firefox/data` lacks a required file, the build stops and tells you to run `npm run build`.

`apply.sh` uses the newest `patches-*.mpp` it finds in that folder.

## Patch an APK: `android/apply.sh`

```sh
cd android
./apply.sh <app.apk|app.apkm|app.xapk|app.apks> [out.apk]
./apply.sh --install <app...> [out.apk]
```

- `--install` must be the first argument. It installs over `adb` on the first device, or on `$ANDROID_SERIAL` if that is set.
- The Morphe CLI merges split bundles into one APK.
- The package name is read from the input. `.apkm` uses `info.json` (`pname`), `.xapk` uses `manifest.json` (`package_name`), `.apk` and `.apks` use `aapt2`.
- Supported packages: `com.twitter.android`, `com.google.android.youtube`, `com.instagram.android` and `dev.spoilerblock.demo` (the demo app). Others stop with exit code 2.
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
| Demo | `arm64-v8a,armeabi-v7a,x86,x86_64` |

The patch only adds its libraries to ABIs the app already ships. So a patched app runs on arm64 phones and on x86_64 emulators (Android 11 and newer images translate arm64). The patch ships libraries for `arm64-v8a` and `x86_64` only. On a device of another ABI, "Only block actual spoilers" fails closed (it blocks every text match) and the image scan fails closed (see below).

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
- If the host app already ships one of these files for an ABI, it is kept and a warning is logged. Then "Only block actual spoilers" fails closed if the host's version does not fit.
- The patch touches one manifest attribute and adds assets, libraries and one `onCreate` call. This is why it can run next to other patches, such as the official ones: it does not edit shared classes or resources.

## Using the bundle in Morphe Manager

Not verified on a real device. The bundle is an ordinary `.mpp` file, so the intent is to add `patches-0.1.0.mpp` as a local patch source in Morphe Manager and enable `SpoilerBlock` together with the other patches you want. The menu steps are not described here because they could not be checked in this repository. If you do this, also read the signing notes above.

## How text and pixels are captured

The blocker uses only public Android APIs on the host's views.

**Feed items.** A `Scanner` is attached to each activity window. Before every frame (`OnPreDrawListener`, after layout and before draw) it looks at the children of the window's scrolling containers. A container is an `AbsListView`, a view that can scroll, or a view whose class name (or a superclass name) ends in `RecyclerView`, `ViewPager`, `ViewPager2` or `ScrollView`. It finds containers again when the layout changes or every 500 ms. Nested lists inside an item are judged item by item.

**Text.** For each item it collects:

- `TextView` text (not `EditText`),
- content descriptions,
- text reported by the X and Instagram setter hooks,
- the accessibility tree of views that have an `AccessibilityNodeProvider` (Litho, Compose and similar), read through `onProvideVirtualStructure` with a minimal `ViewStructure`.

A cheap fingerprint of the item (view identities, texts, sizes, images) decides whether to read it again. An unchanged item is re-read at most once per second as a safety net. The text goes through the Java matcher and, in `spoiler` mode, the classifier.

**Pixels.** With "Scan images and video" on, `ImageView`s that are at least 96 dp in both directions and show a drawable other than a plain colour are scanned.

- Capture: the view's display list is recorded into a `RenderNode`, rendered off screen by a `HardwareRenderer` into an `ImageReader`, and the result is scaled to at most 768 px on the long side. This works for hardware bitmaps and any drawable type, and it leaves the cover out. One capture is done per frame. A queue of 8 jobs is kept, newest first.
- Judging: the same as the extension. CLIP (media gate, title rows, title gap, generic label), then Tesseract OCR whose text joins the post's text for matching. OCR uses the same English data, the LSTM engine, a mean confidence of at least 60 and a 10 second limit.
- A pixel hash cache (500 entries) avoids judging the same picture twice.
- An item is covered as "Checking image..." until its images have verdicts. A capture or model failure keeps it covered. Below Android 10 the capture draws in software, and hardware bitmaps fail closed.
- Video frames are not scanned. Only the `ImageView` thumbnails are.
- The CLIP session uses 2 threads, the classifier 1 thread.

**Cover.** An opaque panel is drawn in the item's own `ViewGroupOverlay`, so it scrolls and animates with the item. It shows "Contains spoiler about {title}" (or "May contain a spoiler (unrecognised film, show or game image)") and three buttons: "Show once", "I've seen {title}" and a ⋮ button for settings. Touches on a cover go to the app until they turn into a scroll. A tap cancels the app's gesture and is handled by the blocker. The covered item is hidden from TalkBack. A floating view that lies over a covered item (for example YouTube's inline player) gets an opaque shade too.

"Show once" lasts for the current process.

## Settings

Open the dialog with the ⋮ button on any cover, or long-press the app icon and choose "Spoiler settings" (a dynamic shortcut). The shortcut is the way back in when blocking is switched off.

| Setting | Preference key | Default |
|---|---|---|
| Block spoilers | `enabled` | on |
| Only block actual spoilers | `mode` (`"any"` or `"spoiler"`) | off (`"any"`) |
| Scan images and video | `scanImages` | on |
| Update catalog: Off, Daily, Weekly, Monthly | `catalogMode` | Off |
| Seen list, with a Remove button per work | `seen` (a set of Wikidata ids) | empty |

"Update now" runs one update at once, even when the mode is Off. The status line shows the catalog size, the number of added titles, the time of the last success and the last error. Preferences are stored in the app's private `spoilerblock` preferences. An updated index is stored as `spoilerblock-index.dat` in the app's files directory, and dropped if it was built from a different bundled catalog.

Resource use:

- The index is loaded on the first activity, not in `Application.onCreate`.
- "Any" mode loads no model. The classifier loads on the first item that needs it and is released when `spoiler` mode is turned off.
- The image models are released when "Scan images and video" is turned off.
- The catalog update runs on a low-priority thread and is the only network use. It queries `https://query.wikidata.org/sparql` with the same rules as the extension.

## Parity tests

The Java code is a port of the extension's. Tests check that Java gives the same answers as the JavaScript. The expected values are produced by the extension's own code, not restated by hand.

1. Build `dist/` (`npm run build`), then generate vectors from the repository root:

   ```sh
   node android/tools/vectors.mjs
   node android/tools/catalog-vectors.mjs
   node android/tools/spoiler-vectors.mjs
   node android/tools/clip-vectors.mjs
   ```

   They write to `android/build/vectors/`. `vectors.mjs` also asserts that `dist/firefox/data/index.bin` is what `data/catalog.json` builds.

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

`SB_LIVE=1 ./gradlew :extensions:blocker:testDebugUnitTest` also runs one opt-in test against the live Wikidata endpoint. The tests run with a 1 GB heap.

## Demo app

`android/demo` is a test app, not part of the bundle. It is a feed of 240 items that mixes plain text views, text drawn on a canvas and exposed only through a content description, text exposed only through an accessibility node provider, text exposed nowhere (reached only by a setter hook), clean posts, ambiguous titles and a nested horizontal shelf. It knows which items must be covered and checks every drawn frame, logging mismatches under the tag `SBDemo`. Its release build is minified, like the real apps.

| Script | What it does |
|---|---|
| `android/tools/demo-build.sh` | Builds the bundle and the demo, copies the unpatched demo to `android/out/demo-unpatched.apk`, then patches it with `apply.sh` into `android/out/demo-patched.apk`. |
| `android/tools/mock-sparql.mjs [port=8765]` | A mock of Wikidata's SPARQL endpoint with a few invented works. The demo patch points the catalog update at `http://10.0.2.2:8765/sparql`, the emulator's view of the host. `curl localhost:8765/mode?set=ok\|429\|malformed` changes its answer mode. |
| `android/tools/demo-fling.sh [revealed]` | Needs `adb`. Fling stress on the installed demo. Prints mismatches from logcat. |
| `android/tools/demo-jank.sh <label>` | Needs `adb`. Frame times over a fixed swipe script (`dumpsys gfxinfo`). |
| `android/tools/tap-text.sh <text>` | Needs `adb`. Taps the first on-screen node whose text or description equals the argument. |
| `android/tools/spoiler-eval-compare.mjs` | Compares an on-device classifier run with the extension's probabilities. Feed it `adb logcat -d -s SBEVAL:I` on stdin. |

The demo's intent extras `spoilerEval` and `imageEval` start on-device runs of the classifier and the image model, whose results can be compared with the extension's. The demo patch is the only one that ships the `test-endpoint.txt` asset.

## Not covered

- Real phones, Firefox for Android, and the X and Instagram feeds were not tested.
- No Android latency or memory figures are published here. `research/REPORT.md` has none for Android.
- Updating a patched app after the host app updates: the patch does not fingerprint, so it is expected to apply to a new version, but only the versions in the table above were tried.
