#!/usr/bin/env bash
# Watch and reels screens of the installed demo (first flavour). Watch: a pinned player with sound above covered rows
# that hold silent previews (the player must stay audible, never shaded or tapped through), and two end-screen cards
# outside any list after 1.5 s (the spoiler one covered, the clean one not). Reels: a covered full-screen page must be
# silent, a clean one audible. The demo checks every frame and logs mismatches (MainActivity, Watch, Sound).
set -euo pipefail
p=dev.spoilerblock.demo
run() { # screen, swipes
  adb shell am force-stop $p
  adb logcat -c
  adb shell am start -W -n $p/.MainActivity --es screen "$1" >/dev/null
  sleep 6
  eval "$2"
  sleep 2
  adb shell input keyevent KEYCODE_HOME
  sleep 1
  s=$(adb logcat -d -s SBDemo:I | grep "frame check summary" | tail -1)
  echo "$1: ${s#*: }"
  m=$(adb logcat -d -s SBDemo:* AndroidRuntime:E | grep -cE "MISMATCH|FATAL" || true)
  echo "$1: $m mismatch lines"; [ "$m" = 0 ] || { adb logcat -d -s SBDemo:E | head -3; fail=1; }
  [ -n "$3" ] && { adb logcat -d -s SBDemo:I SpoilerBlock:I | grep -q "$3" || { echo "$1: missing log '$3'"; fail=1; }; }
  return 0
}
fail=0
run watch 'for i in 1 2 3 4 5 6; do adb shell input swipe 540 2000 540 1000 300; sleep 1.5; done; for i in 1 2 3; do adb shell input swipe 540 1000 540 2000 300; sleep 1.5; done' "end cards shown"
run reels 'for i in 1 2 3 4; do adb shell input swipe 540 1800 540 600 200; sleep 2.5; done; adb shell input swipe 540 1800 540 1300 1500; sleep 2' "audio muted under a cover"
[ $fail = 0 ] && echo PASS || { echo FAIL; exit 1; }
