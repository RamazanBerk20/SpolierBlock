#!/usr/bin/env bash
# Builds the bundle and the demo app, patches the demo with the Morphe CLI exactly as apply.sh patches real apps.
set -euo pipefail
cd "$(dirname "$0")/.."
export JAVA_HOME=${JAVA_HOME:-$HOME/.local/jdks/jdk-21.0.13+9}
./gradlew --console=plain -q :patches:buildAndroid :demo:assembleRelease
mkdir -p out
cp demo/build/outputs/apk/release/demo-release.apk out/demo-unpatched.apk
./apply.sh out/demo-unpatched.apk out/demo-patched.apk
