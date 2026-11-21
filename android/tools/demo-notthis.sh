#!/usr/bin/env bash
# Rule 11, "Not this", on the installed demo (first flavour, NotThis.java): taps "Not this" on a covered Breaking Bad
# row from @alpha_fan; every such row must uncover while @beta_fan's Breaking Bad rows and @alpha_fan's The Last of Us
# rows stay covered, and once the demo removes the key every row is covered again. The demo checks every frame.
set -euo pipefail
p=dev.spoilerblock.demo
adb shell am force-stop $p
adb logcat -c
adb shell am start -W -n $p/.MainActivity --es screen notthis >/dev/null
xy=""
for i in $(seq 1 25); do
  xy=$(adb logcat -d -s SBDemo:I | sed -n 's/.*NOTTHIS tap \([0-9]*\) \([0-9]*\).*/\1 \2/p' | tail -1)
  [ -n "$xy" ] && break
  sleep 1
done
[ -n "$xy" ] || { echo "no covered @alpha_fan row with a Not this button"; adb logcat -d -s SBDemo:* | tail -5; echo FAIL; exit 1; }
echo "tap Not this at $xy"
adb shell input tap $xy
sleep 2.5
adb shell input swipe 540 1600 540 900 400; sleep 2 # other rows of the same source, bound after the tap
adb shell input swipe 540 900 540 1600 400
sleep 9
adb shell input keyevent KEYCODE_HOME
sleep 1
s=$(adb logcat -d -s SBDemo:I | grep "notthis summary" | tail -1 || true)
echo "${s#*: }"
adb logcat -d -s SBDemo:I SpoilerBlock:I | grep -E "notthis: |not this: " || true
m=$(adb logcat -d -s SBDemo:* AndroidRuntime:E | grep -cE "MISMATCH|FATAL" || true)
echo "$m mismatch lines"
[ "$m" = 0 ] || adb logcat -d -s SBDemo:E | head -5
u=$(sed -n 's/.*uncovered checks \([0-9]*\),.*/\1/p' <<<"$s"); c=$(sed -n 's/.*covered-again checks \([0-9]*\),.*/\1/p' <<<"$s")
[ "$m" = 0 ] && [ "${u:-0}" -gt 0 ] && [ "${c:-0}" -gt 0 ] && echo PASS || { echo FAIL; exit 1; }
