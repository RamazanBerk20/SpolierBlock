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
    // The models (spoiler classifier, SigLIP 2 vision tower, PP-OCR) run on ONNX Runtime 1.32.0: 1.22 to 1.31 give the
    // PP-OCR v5 detector a blank probability map on x86-64 (OcrTest finds no text). Only its Java
    // classes reach the .mpe dex; the patch ships the AAR's native libs.
    implementation("com.microsoft.onnxruntime:onnxruntime-android:1.32.0")
    // the same Java API with desktop natives, for the JVM parity test (the AAR has no JVM natives)
    testImplementation("com.microsoft.onnxruntime:onnxruntime:1.32.0")
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
}
