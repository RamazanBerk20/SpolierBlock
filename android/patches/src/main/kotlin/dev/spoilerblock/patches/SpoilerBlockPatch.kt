package dev.spoilerblock.patches

import app.morphe.patcher.extensions.InstructionExtensions.addInstruction
import app.morphe.patcher.extensions.InstructionExtensions.replaceInstruction
import app.morphe.patcher.patch.classDefForEach
import com.android.tools.smali.dexlib2.Opcode
import com.android.tools.smali.dexlib2.iface.instruction.Instruction
import com.android.tools.smali.dexlib2.iface.instruction.ReferenceInstruction
import com.android.tools.smali.dexlib2.iface.instruction.formats.Instruction35c
import com.android.tools.smali.dexlib2.iface.instruction.formats.Instruction3rc
import com.android.tools.smali.dexlib2.iface.reference.MethodReference
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
import app.morphe.patcher.patch.resourceXmlOrNull
import java.util.logging.Logger

private const val INIT = "Ldev/spoilerblock/SpoilerBlock;->init(Landroid/app/Application;)V"
private val ORT_ABIS = listOf("arm64-v8a", "x86_64")
private val ORT_LIBS = listOf("libonnxruntime.so", "libonnxruntime4j_jni.so")

/** invoke-virtual NotificationManager.notify(int, Notification) or notify(String, int, Notification). */
private fun isNotify(i: Instruction): Boolean {
    if (i.opcode != Opcode.INVOKE_VIRTUAL && i.opcode != Opcode.INVOKE_VIRTUAL_RANGE) return false
    val r = (i as ReferenceInstruction).reference as? MethodReference ?: return false
    return r.definingClass == "Landroid/app/NotificationManager;" && r.name == "notify" && r.returnType == "V" &&
        (r.parameterTypes.map { it.toString() } == listOf("I", "Landroid/app/Notification;") ||
            r.parameterTypes.map { it.toString() } == listOf("Ljava/lang/String;", "I", "Landroid/app/Notification;"))
}

private const val TEXT ="Ldev/spoilerblock/SpoilerBlock;->text(Landroid/view/View;Ljava/lang/Object;)V"

private fun bundled(name: String) = object {}.javaClass.getResourceAsStream("/spoilerblock/$name")?.use { it.readBytes() }
    ?: throw PatchException("bundle lacks spoilerblock/$name")

/** A host view that draws its text itself: its setter (one CharSequence or Layout parameter) reports the text. */
private class TextHook(val type: String, val method: String, val param: String)

/**
 * A row in the host's own settings screen, added to a preference XML. [file]: the screen. The
 * row opens SettingsActivity with an explicit intent whose
 * package is written last (finalize), after any patch that renames the app (Morphe's GmsCore support renames YouTube).
 */
private class SettingsRow(val file: String, val order: String? = null, val inCategory: Boolean = false)

private const val SETTINGS_KEY = "spoilerblock_settings"
private const val SETTINGS_ACTIVITY = "dev.spoilerblock.SettingsActivity"

/**
 * The same patch for every app: merge the app-agnostic blocker extension, ship the matcher index as assets and
 * call SpoilerBlock.init(this) first thing in Application.onCreate. The Application class is read from the
 * manifest, so nothing here depends on obfuscated names and the patch survives app updates.
 */
private fun spoilerBlockPatch(
    compatibility: Compatibility,
    textHooks: List<TextHook> = emptyList(),
    settingsRows: List<SettingsRow> = emptyList(),
    testEndpoint: String? = null,
) = patch(
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

        // The spoiler classifier and "Scan images": the models (each loaded only when used) and ONNX Runtime. The libraries go only
        // into ABIs the app already ships (a new ABI directory would make a device of that ABI pick it and lose the app's own
        // libraries); an app without native code gets both. Unique names (libonnxruntime*.so), statically linked C++ runtime.
        for (name in listOf("spoiler/model_int8.onnx", "spoiler/tokenizer.json", "spoiler/meta.json",
            "vision/model.onnx", "vision/clip-text.bin", "vision/clip-meta.json", "ocr/det.onnx", "ocr/rec.onnx", "ocr/dict.txt")) {
            resourceFile("assets/spoilerblock/$name", false).apply { parentFile.mkdirs(); writeBytes(bundled(name)) }
        }
        val appAbis = listApkEntries("lib/").mapNotNull { it.split('/').getOrNull(1) }.toSet()
        val abis = if (appAbis.isEmpty()) ORT_ABIS else ORT_ABIS.filter { it in appAbis }
        for (abi in abis) for (lib in ORT_LIBS) {
            // shortcut: an app shipping its own ONNX Runtime keeps it; spoiler mode then fails closed if that one does not fit
            if (listApkEntries("lib/$abi/$lib").isNotEmpty()) { Logger.getLogger("SpoilerBlock").warning("$pkg has its own lib/$abi/$lib"); continue }
            resourceFile("lib/$abi/$lib", false).apply { parentFile.mkdirs(); writeBytes(bundled("jni/$abi/$lib")) }
        }
        // New libraries are written compressed, which only installs with extractNativeLibs=true. X declares false: its own
        // libraries stay stored in the APK and are now also extracted at install. YouTube and Instagram already extract.
        if (abis.isNotEmpty()) resourceXml("AndroidManifest.xml").use { xml ->
            val application = xml.elements("application").first()
            if (application.attribute("android:extractNativeLibs") == "false") application.setAttribute("android:extractNativeLibs", "true")
        }

        // The settings screen is an activity of the extension: declared here, it can use the system's file pickers for
        // export and import. <queries>: the app must see the companion app to use its shared config (Android 11+).
        resourceXml("AndroidManifest.xml").use { xml ->
            val application = xml.elements("application").first()
            if (xml.elementByAttributeOrNull("android:name", SETTINGS_ACTIVITY) == null) application.appendChild("activity") {
                setAttribute("android:name", SETTINGS_ACTIVITY)
                setAttribute("android:exported", "false")
                setAttribute("android:theme", "@android:style/Theme.Material.NoActionBar")
                setAttribute("android:windowSoftInputMode", "adjustResize")
            }
            xml.root.insertChild(0, "queries") { appendChild("package") { setAttribute("android:name", "dev.spoilerblock") } }
        }

        // A "SpolierBlock" row in the app's own settings. Optional like the text hooks: a screen missing in another
        // version only loses the row (the cover's settings button and the app shortcut still open the screen).
        for (row in settingsRows) {
            val xml = resourceXmlOrNull(row.file)
            if (xml == null) { Logger.getLogger("SpoilerBlock").warning("settings screen not found: ${row.file}"); continue }
            xml.use {
                if (it.elementByAttributeOrNull("android:key", SETTINGS_KEY) != null) return@use
                val screen = it.root
                // look like the rows around it: the layouts the screen's own rows and section headers use, when they set one
                val layout = screen.elements("Preference").mapNotNull { p -> p.attribute("android:layout") }.firstOrNull()
                val categoryLayout = screen.elements("PreferenceCategory").mapNotNull { p -> p.attribute("android:layout") }.firstOrNull()
                // a screen made of sections gets a section of its own
                val parent = if (!row.inCategory) screen else screen.appendChild("PreferenceCategory") {
                    setAttribute("android:title", "SpolierBlock")
                    if (categoryLayout != null) setAttribute("android:layout", categoryLayout)
                }
                parent.appendChild("Preference") {
                    setAttribute("android:key", SETTINGS_KEY)
                    setAttribute("android:title", if (row.inCategory) "Spoiler blocking" else "SpolierBlock")
                    setAttribute("android:summary", "Your library, what to cover, backup")
                    if (layout != null) setAttribute("android:layout", layout)
                    // rows with icons are laid out around them: without one the title would touch the screen edge
                    if (screen.elements("Preference").any { p -> p.attribute("android:icon") != null })
                        setAttribute("android:icon", "@android:drawable/ic_menu_view")
                    if (row.order != null) setAttribute("android:order", row.order)
                    appendChild("intent") {
                        setAttribute("android:targetPackage", pkg) // rewritten in finalize with the final package name
                        setAttribute("android:targetClass", SETTINGS_ACTIVITY)
                    }
                }
            }
        }

        // Optional: a missing hook (renamed in a future app version) only loses that view's text, it does not fail the patch.
        for (h in textHooks) {
            val m = classDefByOrNull(h.type)?.let { mutableClassDefBy(h.type) }?.methods
                ?.firstOrNull { it.name == h.method && it.parameterTypes == listOf(h.param) && it.implementation != null }
            if (m == null) Logger.getLogger("SpoilerBlock").warning("text hook not found: ${h.type}->${h.method}(${h.param})")
            else m.addInstruction(0, "invoke-static/range { p0 .. p1 }, $TEXT")
        }

        // Push notifications: every NotificationManager.notify call in the app's own code (androidx's
        // NotificationManagerCompat and Firebase's display code included) goes through Notifications.notify, which
        // hides a spoiler in the text. The call sites name the framework method, which obfuscation never renames.
        val extensionClass = Regex("Ldev/spoilerblock/[^/]+;")
        val callers = mutableListOf<String>()
        classDefForEach { c ->
            if (!extensionClass.matches(c.type) && c.methods.any { m -> m.implementation?.instructions?.any(::isNotify) == true }) callers += c.type
        }
        var calls = 0
        for (type in callers) for (m in mutableClassDefBy(type).methods) {
            val ins = m.implementation?.instructions ?: continue
            for (i in ins.indices) {
                val call = ins[i]
                if (!isNotify(call)) continue
                val target = "Ldev/spoilerblock/Notifications;->notify(Landroid/app/NotificationManager;" +
                    ((call as ReferenceInstruction).reference as MethodReference).parameterTypes.joinToString("") + ")V"
                val regs = when (call) {
                    is Instruction35c -> "{" + listOf(call.registerC, call.registerD, call.registerE, call.registerF, call.registerG)
                        .take(call.registerCount).joinToString(", ") { "v$it" } + "}"
                    is Instruction3rc -> "{v${call.startRegister} .. v${call.startRegister + call.registerCount - 1}}"
                    else -> continue
                }
                m.replaceInstruction(i, "invoke-static${if (call is Instruction3rc) "/range" else ""} $regs, $target")
                calls++
            }
        }
        Logger.getLogger("SpoilerBlock").info("notification calls routed through the blocker: $calls in ${callers.size} classes")

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

    finalize {
        val pkg = resourceXml("AndroidManifest.xml").use { it.root.attribute("package") } ?: return@finalize
        for (row in settingsRows) resourceXmlOrNull(row.file)?.use { xml ->
            xml.elements("intent").filter { it.attribute("android:targetClass") == SETTINGS_ACTIVITY }
                .forEach { it.setAttribute("android:targetPackage", pkg) }
        }
        if (settingsRows.isNotEmpty()) Logger.getLogger("SpoilerBlock").info("settings rows open $pkg/$SETTINGS_ACTIVITY")
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
    // "Settings and privacy" is a preference XML; its rows are ordered by android:order (10 to 100 in 12.19).
    listOf(SettingsRow("res/xml/settings_root.xml", order = "105")),
)

@Suppress("unused")
val youtubePatch = spoilerBlockPatch(
    tested("com.google.android.youtube", "YouTube", "21.30.216", ApkFileType.APK, 0xFF0000),
    // The settings list exists twice (21.30 shows the "Cairo" one); Morphe's own settings patch edits both as well.
    settingsRows = listOf(SettingsRow("res/xml/settings_fragment.xml"),
        SettingsRow("res/xml/settings_fragment_cairo.xml", inCategory = true)),
)

@Suppress("unused")
val instagramPatch = spoilerBlockPatch(
    tested("com.instagram.android", "Instagram", "452.1.0.53.64", ApkFileType.APKM, 0xFF0069),
    // Feed captions/comments are IgTextLayoutView, a View drawing a Layout. Its text is only reachable through its
    // accessibility node provider, which may be absent; the setter hook makes it independent of that. Named in layout XML.
    listOf(TextHook("Lcom/instagram/ui/widget/textview/IgTextLayoutView;", "setTextLayout", "Landroid/text/Layout;")),
)

/** Test app in android/demo, patched exactly like the real apps; a second package tests the shared config. */
private fun demoPatch(pkg: String) = spoilerBlockPatch(
    Compatibility(packageName = pkg, name = "SpoilerBlock demo"),
    listOf(TextHook("Ldev/spoilerblock/demo/DrawnText;", "setText", "Ljava/lang/CharSequence;")),
    listOf(SettingsRow("res/xml/demo_settings.xml")),
    testEndpoint = "http://10.0.2.2:8765/sparql", // the emulator's host: android/tools/mock-sparql.mjs
)

@Suppress("unused")
val demoPatch = demoPatch("dev.spoilerblock.demo")

@Suppress("unused")
val demo2Patch = demoPatch("dev.spoilerblock.demo2")
