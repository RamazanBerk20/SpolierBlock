#!/usr/bin/env bash
# Rule 11, "Not this", on the installed demo (first flavour, NotThis.java): taps "Show once" on a covered Breaking Bad
# row from @alpha_fan, then the "Not this" of its pill (a cover has none); every such row must uncover while @beta_fan's
# Breaking Bad rows and @alpha_fan's The Last of Us rows stay covered, and once the demo removes the key every row is
# covered again (but the one shown once, which keeps its pill). The demo checks every frame.
set -euo pipefail
export LC_ALL=C # [a-z] leaves out "i" in a Turkish locale
p=dev.spoilerblock.demo
adb shell am force-stop $p
adb logcat -c
adb shell am start -W -n $p/.MainActivity --es screen notthis >/dev/null
n=0
for i in $(seq 1 75); do # the demo logs each tap it wants: Show once, then the pill's Not this
  taps=$(adb logcat -d -s SBDemo:I | sed -n 's/.*NOTTHIS tap \([a-z]*\) \([0-9]*\) \([0-9]*\).*/\1 \2 \3/p')
  c=$(grep -c . <<<"$taps" || true)
  if [ "$c" -gt "$n" ]; then
    n=$((n + 1))
    read -r what x y <<<"$(sed -n "${n}p" <<<"$taps")"
    echo "tap $what at $x $y"
    adb shell input tap "$x" "$y"
  fi
  [ "$n" = 2 ] && break
  sleep 0.4
done
[ "$n" = 2 ] || { echo "no Show once and pill Not this on an @alpha_fan row"; adb logcat -d -s SBDemo:* | tail -5; echo FAIL; exit 1; }
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
