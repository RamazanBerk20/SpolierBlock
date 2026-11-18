group = "dev.spoilerblocker"

patches {
    about {
        name = "SpoilerBlocker patches"
        description = "Blacks out feed items about films, shows, games and books you have not seen. On-device only."
        source = "na" // Manager reads "na" as absent (no repository to open)
        author = "SpoilerBlocker"
        contact = "na"
        website = "na"
        // The bundle links against morphe-patcher (GPLv3).
        license = "GPLv3"
    }
}

// "Only block actual spoilers" / "Scan images and video": ONNX Runtime's and Tesseract's native libs (the extension carries
// only their Java classes) and the models.
val ortNative: Configuration by configurations.creating { isTransitive = false }
dependencies {
    ortNative("com.microsoft.onnxruntime:onnxruntime-android:1.22.0@aar")
    ortNative("cz.adaptech.tesseract4android:tesseract4android:4.9.0@aar") // OCR: libtesseract, libleptonica, libjpeg, libpngx
}
val modelDir = rootDir.resolve("../models/spoiler")

// The matcher index is the browser extension's build output (tools/build.mjs -> dist/firefox/data), shipped as-is.
val indexDir = rootDir.resolve("../dist/firefox/data")
tasks.processResources {
    doFirst {
        check(listOf("index.bin", "index.json", "catalog.json", "common-words.txt", "catalog-classes.json", "catalog-info.json").all { indexDir.resolve(it).exists() }) {
            "$indexDir/ incomplete: run `npm run build` in the repo root first"
        }
    }
    from(indexDir) {
        // the index, plus what the opt-in catalog update rebuilds it from (zip-compressed in the bundle and the APK)
        include("index.bin", "index.json", "catalog.json", "common-words.txt", "catalog-classes.json", "catalog-info.json")
        into("spoilerblocker")
    }
    from(modelDir) {
        include("model_int8.onnx", "tokenizer.json", "meta.json")
        into("spoilerblocker/spoiler")
    }
    // "Scan images and video": the extension's CLIP vision model and text matrix (npm run build), and its OCR model
    from(rootDir.resolve("../dist/firefox")) {
        include("models/clip/onnx/vision_model_quantized.onnx", "data/clip-text.bin", "data/clip-meta.json")
        eachFile { path = "spoilerblocker/clip/$name" }
        includeEmptyDirs = false
    }
    from(rootDir.resolve("../node_modules/@tesseract.js-data/eng/4.0.0_best_int")) {
        include("eng.traineddata.gz")
        into("spoilerblocker/ocr")
    }
    // arm64-v8a for phones, x86_64 for emulators; 32-bit devices fail closed (spoiler mode blocks every match)
    from(provider { ortNative.map { zipTree(it) } }) {
        include("jni/arm64-v8a/*.so", "jni/x86_64/*.so")
        into("spoilerblocker")
    }
}
