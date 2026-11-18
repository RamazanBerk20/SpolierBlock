#!/usr/bin/env bash
# Builds the bundle, the companion app and the demo app (two packages), and patches both demos with the Morphe CLI
# exactly as apply.sh patches real apps. Outputs in android/out/.
set -euo pipefail
cd "$(dirname "$0")/.."
export JAVA_HOME=${JAVA_HOME:-$HOME/.local/jdks/jdk-21.0.13+9}
./gradlew --console=plain -q :patches:buildAndroid :demo:assembleOneRelease :demo:assembleTwoRelease :companion:assembleDebug :companion:assembleRelease
mkdir -p out
cp demo/build/outputs/apk/one/release/demo-one-release.apk out/demo-unpatched.apk
cp demo/build/outputs/apk/two/release/demo-two-release.apk out/demo2-unpatched.apk
cp companion/build/outputs/apk/debug/companion-debug.apk out/spolierblock-companion-debug.apk
cp companion/build/outputs/apk/release/companion-release*.apk out/ 2>/dev/null || true
./apply.sh out/demo-unpatched.apk out/demo-patched.apk
./apply.sh out/demo2-unpatched.apk out/demo2-patched.apk
