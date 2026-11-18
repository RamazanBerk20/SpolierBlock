package dev.spoilerblock.patches

import app.morphe.patcher.extensions.InstructionExtensions.addInstruction
import app.morphe.patcher.patch.ApkFileType
import app.morphe.patcher.patch.AppTarget
import app.morphe.patcher.patch.Compatibility
import app.morphe.patcher.patch.PatchException
import app.morphe.patcher.patch.classDefByOrNull
import app.morphe.patcher.patch.listApkEntries
import app.morphe.patcher.patch.mutableClassDefBy
import app.morphe.patcher.patch.packageMetadata
import app.morphe.patcher.patch.patch
import app.morphe.patcher.patch.resourceFile
import app.morphe.patcher.patch.resourceXml
import java.util.logging.Logger

private const val INIT = "Ldev/spoilerblock/SpoilerBlock;->init(Landroid/app/Application;)V"
private val ORT_ABIS = listOf("arm64-v8a", "x86_64")
private val ORT_LIBS = listOf("libonnxruntime.so", "libonnxruntime4j_jni.so", "libjpeg.so", "libpngx.so", "libleptonica.so", "libtesseract.so")

// Tesseract4Android's libraries carry generic names; their sonames (and the references between them) get same-length
// SpoilerBlock names so they never bind to a host library that happens to share a soname (Java still loads them
// by file name, in dependency order, so the linker finds each renamed soname already loaded).
private val SONAMES = listOf("libjpeg.so" to "libsbjp.so", "libpngx.so" to "libsbpn.so",
    "libleptonica.so" to "libsbleptoni.so", "libtesseract.so" to "libsbtessera.so")

private fun renameSonames(elf: ByteArray): ByteArray {
    for ((from, to) in SONAMES) {
        val f = (from + "\u0000").toByteArray(); val t = (to + "\u0000").toByteArray()
        var i = 0
        while (i <= elf.size - f.size) {
            var hit = elf[i] == f[0] && (i == 0 || elf[i - 1] == 0.toByte()) // whole strings of the string table only
            var k = 1
            while (hit && k < f.size) { hit = elf[i + k] == f[k]; k++ }
            if (hit) { t.copyInto(elf, i); i += f.size } else i++
        }
    }
    return elf
}
private const val TEXT = "Ldev/spoilerblock/SpoilerBlock;->text(Landroid/view/View;Ljava/lang/Object;)V"

private fun bundled(name: String) = object {}.javaClass.getResourceAsStream("/spoilerblock/$name")?.use { it.readBytes() }
    ?: throw PatchException("bundle lacks spoilerblock/$name")

/** A host view that draws its text itself: its setter (one CharSequence or Layout parameter) reports the text. */
private class TextHook(val type: String, val method: String, val param: String)

/**
 * The same patch for every app: merge the app-agnostic blocker extension, ship the matcher index as assets and
 * call SpoilerBlock.init(this) first thing in Application.onCreate. The Application class is read from the
 * manifest, so nothing here depends on obfuscated names and the patch survives app updates.
 */
private fun spoilerBlockPatch(compatibility: Compatibility, textHooks: List<TextHook> = emptyList(), testEndpoint: String? = null) = patch(
    name = "SpoilerBlock",
    description = "Blacks out feed items about films, shows, games and books you have not marked as seen. On-device only.",
    default = true,
) {
    compatibleWith(compatibility)
    extendWith("extensions/blocker.mpe")

    execute {
        val pkg = packageMetadata.packageName
        for (name in listOf("index.bin", "index.json", "catalog.json", "common-words.txt", "catalog-classes.json", "catalog-info.json")) {
            resourceFile("assets/spoilerblock/$name", false).apply { parentFile.mkdirs(); writeBytes(bundled(name)) }
        }

        // "Only block actual spoilers" and "Scan images and video": the models (each loaded only when used), ONNX Runtime and Tesseract. The libraries go only
        // into ABIs the app already ships (a new ABI directory would make a device of that ABI pick it and lose the app's own
        // libraries); an app without native code gets both. Unique names (libonnxruntime*.so), statically linked C++ runtime.
        for (name in listOf("spoiler/model_int8.onnx", "spoiler/tokenizer.json", "spoiler/meta.json",
            "clip/vision_model_quantized.onnx", "clip/clip-text.bin", "clip/clip-meta.json", "ocr/eng.traineddata.gz")) {
            resourceFile("assets/spoilerblock/$name", false).apply { parentFile.mkdirs(); writeBytes(bundled(name)) }
        }
        val appAbis = listApkEntries("lib/").mapNotNull { it.split('/').getOrNull(1) }.toSet()
        val abis = if (appAbis.isEmpty()) ORT_ABIS else ORT_ABIS.filter { it in appAbis }
        for (abi in abis) for (lib in ORT_LIBS) {
            // shortcut: an app shipping its own ONNX Runtime keeps it; spoiler mode then fails closed if that one does not fit
            if (listApkEntries("lib/$abi/$lib").isNotEmpty()) { Logger.getLogger("SpoilerBlock").warning("$pkg has its own lib/$abi/$lib"); continue }
            resourceFile("lib/$abi/$lib", false).apply { parentFile.mkdirs(); writeBytes(renameSonames(bundled("jni/$abi/$lib"))) }
        }
        // New libraries are written compressed, which only installs with extractNativeLibs=true. X declares false: its own
        // libraries stay stored in the APK and are now also extracted at install. YouTube and Instagram already extract.
        if (abis.isNotEmpty()) resourceXml("AndroidManifest.xml").use { xml ->
            val application = xml.elements("application").first()
            if (application.attribute("android:extractNativeLibs") == "false") application.setAttribute("android:extractNativeLibs", "true")
        }

        // Optional: a missing hook (renamed in a future app version) only loses that view's text, it does not fail the patch.
        for (h in textHooks) {
            val m = classDefByOrNull(h.type)?.let { mutableClassDefBy(h.type) }?.methods
                ?.firstOrNull { it.name == h.method && it.parameterTypes == listOf(h.param) && it.implementation != null }
            if (m == null) Logger.getLogger("SpoilerBlock").warning("text hook not found: ${h.type}->${h.method}(${h.param})")
            else m.addInstruction(0, "invoke-static/range { p0 .. p1 }, $TEXT")
        }

        // test builds only (the demo): the catalog update talks to a local mock instead of query.wikidata.org
        if (testEndpoint != null) resourceFile("assets/spoilerblock/test-endpoint.txt", false).writeText(testEndpoint)

        val appName = resourceXml("AndroidManifest.xml").use { it.elements("application").first().attribute("android:name") }
        appName ?: throw PatchException("$pkg declares no Application class")
        val appType = "L" + (if (appName.startsWith(".")) pkg + appName else appName).replace('.', '/') + ";"

        // The first class of the hierarchy that implements onCreate() (the manifest class itself in all three apps).
        var type: String? = appType
        while (type != null) {
            val cls = classDefByOrNull(type) ?: break
            if (cls.methods.any { it.name == "onCreate" && it.parameterTypes.isEmpty() && it.returnType == "V" && it.implementation != null }) {
                mutableClassDefBy(type).methods.first { it.name == "onCreate" && it.parameterTypes.isEmpty() && it.returnType == "V" }
                    .addInstruction(0, "invoke-static/range { p0 .. p0 }, $INIT") // range form: p0 can be above v15
                return@execute
            }
            type = cls.superclass
        }
        // shortcut: an Application without any onCreate() in app code is not handled, add a generated override if an app needs it.
        throw PatchException("no onCreate() in the hierarchy of $appType")
    }
}

private fun tested(packageName: String, name: String, version: String, type: ApkFileType, color: Int) = Compatibility(
    packageName = packageName,
    name = name,
    apkFileType = type,
    appIconColor = color,
    // The tested version first; any other version is expected to work because nothing is fingerprinted.
    targets = listOf(AppTarget(version = version), AppTarget(version = null, isExperimental = true)),
)

@Suppress("unused")
val xPatch = spoilerBlockPatch(
    tested("com.twitter.android", "X", "12.19.1-release.0", ApkFileType.APKM, 0x000000),
    // Tweet text and names are custom Views that draw a Layout; X sets the tweet's content description only while an
    // accessibility service runs (TweetAccessibilityViewDelegateBinder), so without these hooks a tweet has no text.
    // Both classes are named in layout XML, so their names survive obfuscation.
    listOf(
        TextHook("Lcom/twitter/ui/widget/TextContentView;", "setText", "Ljava/lang/CharSequence;"),
        TextHook("Lcom/twitter/ui/widget/TextLayoutView;", "setText", "Ljava/lang/CharSequence;"),
    ),
)

@Suppress("unused")
val youtubePatch = spoilerBlockPatch(tested("com.google.android.youtube", "YouTube", "21.30.216", ApkFileType.APK, 0xFF0000))

@Suppress("unused")
val instagramPatch = spoilerBlockPatch(
    tested("com.instagram.android", "Instagram", "452.1.0.53.64", ApkFileType.APKM, 0xFF0069),
    // Feed captions/comments are IgTextLayoutView, a View drawing a Layout. Its text is only reachable through its
    // accessibility node provider, which may be absent; the setter hook makes it independent of that. Named in layout XML.
    listOf(TextHook("Lcom/instagram/ui/widget/textview/IgTextLayoutView;", "setTextLayout", "Landroid/text/Layout;")),
)

/** Test app in android/demo, patched exactly like the real apps. */
@Suppress("unused")
val demoPatch = spoilerBlockPatch(
    Compatibility(packageName = "dev.spoilerblock.demo", name = "SpoilerBlock demo"),
    listOf(TextHook("Ldev/spoilerblock/demo/DrawnText;", "setText", "Ljava/lang/CharSequence;")),
    testEndpoint = "http://10.0.2.2:8765/sparql", // the emulator's host: android/tools/mock-sparql.mjs
)
