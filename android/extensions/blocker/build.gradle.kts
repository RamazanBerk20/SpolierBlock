import com.android.build.api.dsl.ApplicationExtension

extension {
    name = "extensions/blocker.mpe"
}

configure<ApplicationExtension> {
    namespace = "dev.spoilerblock"
    defaultConfig { minSdk = 28 }
    testOptions { unitTests.isReturnDefaultValues = true }
}

dependencies {
    // Plain JUnit on the JVM for the matcher; org.json is part of Android but only a stub in android.jar.
    // The models (spoiler classifier, SigLIP 2 vision tower, PP-OCR) run on ONNX Runtime 1.22.0, the version of the
    // extension's onnxruntime-web. Only its Java classes reach the .mpe dex; the patch ships the AAR's native libs.
    implementation("com.microsoft.onnxruntime:onnxruntime-android:1.22.0")
    // the same Java API with desktop natives, for the JVM parity test (the AAR has no JVM natives)
    testImplementation("com.microsoft.onnxruntime:onnxruntime:1.22.0")
    testImplementation("junit:junit:4.13.2")
    testImplementation("org.json:json:20250517")
}

// The matcher tests read the shared vectors that tools/vectors.mjs writes from the extension's own JS matcher.
tasks.withType<Test>().configureEach {
    systemProperty("sb.vectors", rootDir.resolve("build/vectors").absolutePath)
    systemProperty("sb.dist", rootDir.resolve("../dist/firefox/data").absolutePath)
    systemProperty("sb.model", rootDir.resolve("../models/spoiler").absolutePath)
    systemProperty("sb.context", rootDir.resolve("../models/context").absolutePath)
    // the vectors are inputs: regenerated vectors must re-run the tests (and never hit the build cache)
    inputs.dir(rootDir.resolve("build/vectors"))
    inputs.dir(rootDir.resolve("../dist/firefox/data"))
    maxHeapSize = "1g"
    testLogging { showStandardStreams = true }
}

// OcrTest runs on desktop ONNX Runtime 1.32.0: the desktop (Linux x86-64) builds 1.22 to 1.31 give the PP-OCR v5
// detector a blank probability map at every optimisation level, so the JVM finds no text. The Android 1.22 build
// reads all 21 fixtures like the extension (the demo's on-device ImageEval), so the app keeps 1.22.
val ortDesktopNew: Configuration by configurations.creating { isTransitive = false }
dependencies { ortDesktopNew("com.microsoft.onnxruntime:onnxruntime:1.32.0") }
afterEvaluate {
    val unit = tasks.named<Test>("testDebugUnitTest")
    val ocr = tasks.register<Test>("ocrTestDebugUnitTest") {
        description = "OcrTest on desktop ONNX Runtime 1.32.0"
        testClassesDirs = unit.get().testClassesDirs
        classpath = unit.get().classpath.filter { !it.name.startsWith("onnxruntime-1.22") } + ortDesktopNew
        filter { includeTestsMatching("dev.spoilerblock.OcrTest") }
    }
    unit.configure {
        filter { excludeTestsMatching("dev.spoilerblock.OcrTest") }
        finalizedBy(ocr)
    }
}

// The extension is plain Java: keep AGP's default Kotlin stdlib out of the dex merged into the host app.
configurations.configureEach {
    if (name.contains("RuntimeClasspath") && !name.contains("UnitTest")) exclude(group = "org.jetbrains.kotlin")
    if (name.contains("UnitTest")) exclude(group = "com.microsoft.onnxruntime", module = "onnxruntime-android")
}
