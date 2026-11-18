plugins {
    id("com.android.application")
}

android {
    namespace = "dev.spoilerblock.demo"
    compileSdk = 36
    defaultConfig {
        applicationId = "dev.spoilerblock.demo"
        minSdk = 28
        targetSdk = 36
        versionCode = 1
        versionName = "1.0"
    }
    // two installs side by side, patched alike: a work marked seen in one must be seen in the other (shared config)
    flavorDimensions += "id"
    productFlavors {
        create("one") { dimension = "id"; manifestPlaceholders["appLabel"] = "SB Demo" }
        create("two") { dimension = "id"; applicationId = "dev.spoilerblock.demo2"; manifestPlaceholders["appLabel"] = "SB Demo 2" }
    }
    buildTypes {
        release {
            // obfuscated like the real apps: RecyclerView is renamed, so the blocker must find lists by behaviour
            isMinifyEnabled = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            signingConfig = signingConfigs.getByName("debug")
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
}

dependencies {
    implementation("androidx.recyclerview:recyclerview:1.4.0")
}
