rootProject.name = "spoilerblock-android"

pluginManagement {
    repositories {
        // app.morphe.patches 2.1.1 and morphe-patcher 2.4.0 are only on GitHub Packages (needs a read:packages token);
        // tools/bootstrap-morphe.sh builds them from source into ~/.m2 instead.
        mavenLocal()
        gradlePluginPortal()
        google()
        maven { url = uri("https://jitpack.io") }
    }
}

plugins {
    id("app.morphe.patches") version "2.1.1"
}

settings {
    extensions {
        defaultNamespace = "dev.spoilerblock"
    }
}

// Test app for the blocker (not part of the patch bundle).
include(":demo")

// The companion app: the shared config and the settings screen (android/companion).
include(":companion")
