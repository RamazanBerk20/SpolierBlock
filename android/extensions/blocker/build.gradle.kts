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
    // "Only block actual spoilers": the extension's sentence model runs on ONNX Runtime (1.22.0, the version of the
    // extension's onnxruntime-web). Only its Java classes reach the .mpe dex; the patch ships the AAR's native libs.
    implementation("com.microsoft.onnxruntime:onnxruntime-android:1.22.0")
    // OCR for "Scan images and video": native Tesseract 5 (the engine the extension runs as tesseract.js). Not transitive:
    // its androidx.annotation dependency is compile-time only and must not be merged into the host app.
    implementation("cz.adaptech.tesseract4android:tesseract4android:4.9.0") { isTransitive = false }
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
    // the vectors are inputs: regenerated vectors must re-run the tests (and never hit the build cache)
    inputs.dir(rootDir.resolve("build/vectors"))
    inputs.dir(rootDir.resolve("../dist/firefox/data"))
    maxHeapSize = "1g"
    testLogging { showStandardStreams = true }
}

// The extension is plain Java: keep AGP's default Kotlin stdlib out of the dex merged into the host app.
configurations.configureEach {
    if (name.contains("RuntimeClasspath") && !name.contains("UnitTest")) exclude(group = "org.jetbrains.kotlin")
    if (name.contains("UnitTest")) exclude(group = "com.microsoft.onnxruntime", module = "onnxruntime-android")
    if (name.contains("UnitTest")) exclude(group = "cz.adaptech.tesseract4android")
}
