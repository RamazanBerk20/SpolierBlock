#!/usr/bin/env bash
# Taps the centre of the first on-screen node whose text or content-desc equals $1 (uiautomator dump).
set -euo pipefail
adb shell uiautomator dump /sdcard/tap.xml >/dev/null
b=$(adb shell cat /sdcard/tap.xml | grep -o "<node [^>]*\(text\|content-desc\)=\"$1\"[^>]*>" | head -1 | grep -o 'bounds="[^"]*"' | tr -dc '0-9,[]' | tr '][' ',,' )
[ -n "$b" ] || { echo "no node '$1'" >&2; exit 1; }
IFS=, read -r _ x1 y1 _ x2 y2 _ <<<"$b"
adb shell input tap $(( (x1 + x2) / 2 )) $(( (y1 + y2) / 2 ))
