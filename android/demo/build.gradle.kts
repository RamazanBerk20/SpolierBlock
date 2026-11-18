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
