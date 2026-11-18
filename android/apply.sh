#!/usr/bin/env bash
# Patches X, YouTube or Instagram (or the demo app) with SpoilerBlock and writes a signed, installable APK.
#
#   ./apply.sh <app.apk|app.apkm|app.xapk|app.apks> [out.apk]
#   ./apply.sh --install <app...> [out.apk]      also installs over adb (first device, or $ANDROID_SERIAL)
#
# Split bundles are merged into one APK by the Morphe CLI. Native libraries are reduced to ABIS (default: arm64-v8a,
# plus x86_64 where the app ships a full x86_64 build), which runs on arm64 phones and on x86_64 emulators (Android 11+
# images translate arm64). The same keystore (keystore/spoilerblock.keystore, created on first use) signs every
# build so updates install over each other; it is not the original signature, so uninstall the store app first.
#
# To update an app Morphe Manager already patched (same signature, data kept), sign with the Manager's key instead:
# export it in Manager (Settings -> Signing key -> Export, a BKS file; alias and password are both "Morphe") and run
#   KEYSTORE=Morphe.keystore KEYSTORE_PASSWORD=Morphe KEY_ALIAS=Morphe KEY_PASSWORD=Morphe MORPHE_ALL=1 ./apply.sh <app>
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
install=()
[ "${1:-}" = --install ] && { install=(--install${ANDROID_SERIAL:+=$ANDROID_SERIAL}); shift; }
in=${1:?usage: apply.sh [--install] <app.apk|.apkm|.xapk|.apks> [out.apk]}
[ -f "$in" ] || { echo "error: $in not found" >&2; exit 1; }

java=${JAVA_HOME:-$HOME/.local/jdks/jdk-21.0.13+9}/bin/java
[ -x "$java" ] || java=java
"$java" -version 2>&1 | grep -qE 'version "(2[1-9]|[3-9][0-9])' || { echo "error: Java 21+ needed (set JAVA_HOME)" >&2; exit 1; }
cli=$here/tools/morphe-desktop-2.2.0-all.jar
[ -f "$cli" ] || { echo "error: $cli missing, run tools/bootstrap-morphe.sh" >&2; exit 1; }
mpp=$(ls -t "$here"/patches/build/libs/patches-*.mpp 2>/dev/null | head -1)
[ -n "$mpp" ] || { echo "error: no patch bundle, run: (cd $here && ./gradlew :patches:buildAndroid)" >&2; exit 1; }

# ---- package name ----
tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
case "$in" in
  *.apkm) pkg=$(unzip -p "$in" info.json | sed -n 's/.*"pname": *"\([^"]*\)".*/\1/p') ;;
  *.xapk) pkg=$(unzip -p "$in" manifest.json | sed -n 's/.*"package_name": *"\([^"]*\)".*/\1/p') ;;
  *)
    aapt2=$(ls -d "${ANDROID_HOME:-$HOME/Android/Sdk}"/build-tools/*/aapt2 2>/dev/null | tail -1)
    [ -n "$aapt2" ] || { echo "error: aapt2 (Android SDK build-tools) needed to read the package name of an .apk" >&2; exit 1; }
    apk=$in
    if [[ "$in" == *.apks ]]; then unzip -q -o "$in" base.apk -d "$tmp" 2>/dev/null || unzip -q -o "$in" 'splits/base-master.apk' -d "$tmp"; apk=$(ls "$tmp"/base.apk "$tmp"/splits/base-master.apk 2>/dev/null | head -1); fi
    pkg=$("$aapt2" dump packagename "$apk" 2>/dev/null) ;;
esac

official=()
case "$pkg" in
  com.google.android.youtube)
    abis=${ABIS:-arm64-v8a,x86_64}
    # A re-signed YouTube cannot use Google Play services: the official Morphe "GmsCore support" patch (with its
    # dependencies) moves it to the MicroG-RE GmsCore app. Fetched from github.com/MorpheApp/morphe-patches.
    official=(-p "${MORPHE_PATCHES:-https://github.com/MorpheApp/morphe-patches}" -e "GmsCore support")
    note="Install MicroG-RE (https://github.com/MorpheApp/MicroG-RE/releases) before opening the patched YouTube.
The patched app is installed as app.morphe.android.youtube next to the store app. Other official Morphe patches
(ad blocking, ...) can be added with: MORPHE_ALL=1 ./apply.sh ..." ;;
  com.twitter.android) abis=${ABIS:-arm64-v8a}; note="No official Morphe patches are needed for X." ;;
  com.instagram.android) abis=${ABIS:-arm64-v8a}; note="No official Morphe patches are needed for Instagram." ;;
  dev.spoilerblock.demo) abis=${ABIS:-arm64-v8a,armeabi-v7a,x86,x86_64}; note="Demo app." ;;
  *) echo "error: unsupported package '${pkg:-unknown}' in $in (supported: com.twitter.android, com.google.android.youtube, com.instagram.android, dev.spoilerblock.demo)" >&2; exit 2 ;;
esac

out=${2:-$here/out/$pkg-spoilerblock.apk}
mkdir -p "$(dirname "$out")" "$here/keystore"
ks=${KEYSTORE:-$here/keystore/spoilerblock.keystore}
[ -n "${KEYSTORE:-}" ] && [ ! -f "$ks" ] && { echo "error: keystore $ks not found" >&2; exit 1; }
if [ ! -f "$ks" ]; then # local signing key, created once; keep it to install updates over earlier builds
  (umask 077; head -c 24 /dev/urandom | base64 | tr -d '/+=' > "$here/keystore/password")
  "$(dirname "$java")/keytool" -genkeypair -keystore "$ks" -storetype PKCS12 -alias Morphe -keyalg RSA -keysize 4096 \
    -validity 10000 -dname "CN=SpoilerBlock local" -storepass "$(cat "$here/keystore/password")" >/dev/null
fi
pw=${KEYSTORE_PASSWORD:-$( [ -n "${KEYSTORE:-}" ] || cat "$here/keystore/password")}
exclusive=(--exclusive)
[ -n "${MORPHE_ALL:-}" ] && exclusive=()
echo "patching $pkg -> $out (ABIs: $abis)"
status=0
"$java" -Xmx3g -jar "$cli" patch -p "$mpp" -e SpoilerBlock "${official[@]}" "${exclusive[@]}" \
  --striplibs "$abis" --keystore "$ks" --keystore-password "$pw" --keystore-entry-alias "${KEY_ALIAS:-Morphe}" --keystore-entry-password "${KEY_PASSWORD:-$pw}" \
  -t "$tmp/work" -r "$out.result.json" -o "$out" "${install[@]}" "$in" || status=$?
[ "$status" = 0 ] && grep -q '"success" *: *true' "$out.result.json" || { echo "error: patching failed (exit $status), see $out.result.json" >&2; exit 3; }
echo "ok: $out"
echo "$note"
