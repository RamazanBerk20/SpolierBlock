#!/usr/bin/env bash
# Fling stress on the installed demo: the demo checks every drawn frame (MainActivity.check) and logs mismatches.
set -euo pipefail
adb shell am force-stop dev.spoilerblocker.demo
adb logcat -c
adb shell am start -W -n dev.spoilerblocker.demo/.MainActivity ${1:+--es revealed "$1"} >/dev/null
sleep 2
adb shell 'for r in 1 2; do for i in $(seq 1 25); do input swipe 540 2000 540 300 40; done; sleep 1; for i in $(seq 1 25); do input swipe 540 400 540 2100 40; done; sleep 1; done; for i in $(seq 1 30); do input swipe 540 1800 540 600 120; input swipe 540 600 540 1800 120; done'
sleep 2
adb shell input keyevent KEYCODE_HOME
sleep 1
adb logcat -d -s SBDemo:* SpoilerBlocker:* AndroidRuntime:E | grep -E "MISMATCH|summary|scan |disabled|FATAL" | tail -12
