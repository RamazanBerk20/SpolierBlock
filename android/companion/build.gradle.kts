plugins {
    id("com.android.application")
}

// The companion app: owns the one shared config (ConfigProvider) and shows the settings screen the patched apps show.
// It is built from the extension's own sources, so both always agree. It ships the title index (for search), not the models.
val keystoreDir = rootDir.resolve("keystore")

android {
    namespace = "dev.spoilerblock.companion"
    compileSdk = 36
    defaultConfig {
        applicationId = "dev.spoilerblock"
        minSdk = 28
        targetSdk = 36
        versionCode = 1
        versionName = project.version.toString()
    }
    sourceSets["main"].java.srcDir("../extensions/blocker/src/main/java")
    sourceSets["main"].assets.srcDir(layout.buildDirectory.get().asFile.resolve("generated/sbassets"))
    signingConfigs {
        // android/keystore (made by apply.sh, not in git), or KEYSTORE / KEYSTORE_PASSWORD / KEY_ALIAS / KEY_PASSWORD as for apply.sh
        create("release") {
            val ks = System.getenv("KEYSTORE")?.let { file(it) } ?: keystoreDir.resolve("spoilerblock.keystore")
            val pw = System.getenv("KEYSTORE_PASSWORD") ?: keystoreDir.resolve("password").takeIf { it.exists() }?.readText()?.trim()
            if (ks.exists() && pw != null) {
                storeFile = ks
                storePassword = pw
                keyAlias = System.getenv("KEY_ALIAS") ?: "Morphe"
                keyPassword = System.getenv("KEY_PASSWORD") ?: pw
            }
        }
    }
    buildTypes {
        release {
            isMinifyEnabled = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            signingConfig = signingConfigs.getByName("release").takeIf { it.storeFile != null }
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}

dependencies {
    // only to compile the shared sources; the companion never loads a model
    compileOnly("com.microsoft.onnxruntime:onnxruntime-android:1.22.0")
}

// The title index the extension builds (npm run build -> dist/firefox/data), for the library's search.
val companionAssets by tasks.registering(Sync::class) {
    from(rootDir.resolve("../dist/firefox/data")) { include("index.bin", "index.json") }
    into(layout.buildDirectory.dir("generated/sbassets/spoilerblock"))
    doFirst { check(rootDir.resolve("../dist/firefox/data/index.bin").exists()) { "run `npm run build` in the repo root first" } }
}
tasks.named("preBuild") { dependsOn(companionAssets) }
