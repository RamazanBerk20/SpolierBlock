group = "dev.spoilerblock"

patches {
    about {
        name = "SpoilerBlock patches"
        description = "Blacks out feed items about films, shows, games and books you have not seen. On-device only."
        source = "na" // Manager reads "na" as absent (no repository to open)
        author = "SpoilerBlock"
        contact = "na"
        website = "na"
        // The bundle links against morphe-patcher (GPLv3).
        license = "GPLv3"
    }
}

// The spoiler classifier and "Scan images": ONNX Runtime's native libs (the extension carries only its Java classes) and the models.
val ortNative: Configuration by configurations.creating { isTransitive = false }
dependencies {
    ortNative("com.microsoft.onnxruntime:onnxruntime-android:1.32.0@aar")
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
        into("spoilerblock")
    }
    from(modelDir) {
        include("model_int8.onnx", "tokenizer.json", "meta.json")
        into("spoilerblock/spoiler")
    }
    // "Scan images": the extension's SigLIP 2 vision tower, title rows and cut-offs, and its PP-OCR models (npm run build)
    val dist = rootDir.resolve("../dist/firefox")
    doFirst {
        check(listOf("models/vision/model.onnx", "data/clip-text.bin", "data/clip-meta.json", "models/ocr/det.onnx", "models/ocr/rec.onnx",
            "models/ocr/dict.txt").all { dist.resolve(it).exists() }) { "$dist/ lacks the image models: run `npm run build` in the repo root first" }
    }
    from(dist) {
        include("models/vision/model.onnx", "data/clip-text.bin", "data/clip-meta.json")
        eachFile { path = "spoilerblock/vision/$name" }
        includeEmptyDirs = false
    }
    from(dist.resolve("models/ocr")) {
        include("det.onnx", "rec.onnx", "dict.txt")
        into("spoilerblock/ocr")
    }
    // arm64-v8a for phones, x86_64 for emulators; 32-bit devices fail closed (spoiler mode blocks every match)
    from(provider { ortNative.map { zipTree(it) } }) {
        include("jni/arm64-v8a/*.so", "jni/x86_64/*.so")
        into("spoilerblock")
    }
}
