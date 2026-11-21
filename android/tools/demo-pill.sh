#!/usr/bin/env bash
# The pill after "Show once" on the installed demo (first flavour, Pill.java). The demo logs each tap it wants
# ("PILL tap <what> x y", from the blocker's accessibility nodes) and checks every frame; this script taps in order:
# Show once, the row outside the pill, Cover again, Show once, the pill's Not this. PASS needs the demo's summary
# ("pill: summary: done") and no mismatch.
set -euo pipefail
export LC_ALL=C # [a-z] leaves out "i" in a Turkish locale
p=dev.spoilerblock.demo
adb shell am force-stop $p
adb logcat -c
adb shell am start -W -n $p/.MainActivity --es screen pill >/dev/null
n=0
for i in $(seq 1 150); do
  log=$(adb logcat -d -s SBDemo:I)
  grep -q "pill: summary" <<<"$log" && break
  taps=$(sed -n 's/.*PILL tap \([a-z]*\) \([0-9]*\) \([0-9]*\).*/\1 \2 \3/p' <<<"$log")
  c=$(grep -c . <<<"$taps" || true)
  if [ "$c" -gt "$n" ]; then
    n=$((n + 1))
    read -r what x y <<<"$(sed -n "${n}p" <<<"$taps")"
    echo "tap $what at $x $y"
    adb shell input tap "$x" "$y"
  fi
  sleep 0.4
done
adb shell input keyevent KEYCODE_HOME
sleep 1
adb logcat -d -s SBDemo:I SpoilerBlock:I | grep -E "pill: |shown once|covered again|not this: " || true
s=$(adb logcat -d -s SBDemo:I | grep "pill: summary" | tail -1 || true)
m=$(adb logcat -d -s SBDemo:* AndroidRuntime:E | grep -cE "MISMATCH|FATAL" || true)
echo "$m mismatch lines"
[ "$m" = 0 ] || adb logcat -d -s SBDemo:E AndroidRuntime:E | head -5
grep -q "summary: done" <<<"$s" && [ "$m" = 0 ] && [ "$n" = 5 ] && echo PASS || { echo FAIL; exit 1; }
