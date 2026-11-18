#!/usr/bin/env bash
# Frame times of the installed demo over a fixed swipe script (dumpsys gfxinfo). Usage: demo-jank.sh <label>
set -euo pipefail
p=dev.spoilerblocker.demo
adb shell am force-stop $p
adb shell am start -W -n $p/.MainActivity >/dev/null
sleep 3
adb shell dumpsys gfxinfo $p reset >/dev/null
adb shell 'for i in $(seq 1 20); do input swipe 540 1900 540 500 150; done; for i in $(seq 1 20); do input swipe 540 500 540 1900 150; done'
sleep 2
echo "== $1"
adb shell dumpsys gfxinfo $p | grep -E "Total frames rendered|Janky frames|50th|90th|95th|99th|Number Slow UI thread|Number Frame deadline missed" | head -12
