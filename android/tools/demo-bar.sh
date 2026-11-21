#!/usr/bin/env bash
# X's floating bottom bar over covered rows (demo, --ez bottomBar true, BottomBar.java): taps on the bar's three buttons
# and on the round button above it must reach the app while a covered row lies under them; a cover must still take a tap
# where nothing of the app lies over it; "Show once" on a covered row clear of the bar must still reveal it.
# The demo logs, whenever the list rests, where such rows are and the points to tap ("bar check" lines).
set -euo pipefail
p=dev.spoilerblock.demo
adb shell am force-stop $p
adb logcat -c
adb shell am start -W -n $p/.MainActivity --ez bottomBar true >/dev/null
sleep 5

report() { adb logcat -d -s SBDemo:I | grep "bar check" | tail -1 || true; }
val() { sed -n "s/.* $1=\([^ ]*\).*/\1/p" <<<"$2"; }
count() { adb logcat -d -s SBDemo:* SpoilerBlock:* | grep -c -- "$1" || true; }
# a slow short drag: no fling, the list rests and the demo reports again
seek() { for _ in $(seq 1 40); do r=$(report); [ "$(val "$1" "$r")" != "-1" ] && [ -n "$(val "$1" "$r")" ] && return; adb shell input swipe 540 1500 540 1330 600; sleep 1.5; done; r=""; }
tap() { adb shell input tap "${1%,*}" "${1#*,}"; sleep 0.7; }

# 1. a covered row under the bar, reaching above it: tap the three bar buttons, then the row just above the bar
seek under; [ -n "$r" ] || { echo "FAIL: no covered row under the bar"; exit 1; }
echo "$r"
u=$(val under "$r"); under=${u%@*}
IFS=, read -r x1 x2 x3 y <<<"$(val bar "$r")"
for x in $x1 $x2 $x3; do tap "$x,$y"; done
tap "${u#*@}"
barGot=$(count "bar tap")
aboveOpened=$(adb logcat -d -s SBDemo:I | grep -c "CLICK reached app: post $under\$" || true)

# 2. a covered row under the round button
seek round; fabSent=0; fabGot=0
if [ -n "$r" ]; then echo "$r"; fabSent=1; tap "$(val fab "$r")"; fabGot=$(count "fab tap"); fi

# 3. "Show once" on a covered row clear of the bar and the round button
seek free; revealed=no; free=-1
if [ -n "$r" ]; then
  echo "$r"
  f=$(val free "$r"); free=${f%@*}
  before=$(count "shown once")
  tap "${f#*@}"; sleep 1
  [ "$(count "shown once")" -gt "$before" ] && [ "$(count "MISMATCH .* post $free covered=false")" -gt 0 ] && revealed=yes
fi
other=$(adb logcat -d -s SBDemo:E | grep MISMATCH | grep -vc "post $free covered=false" || true)
adb shell input keyevent KEYCODE_HOME; sleep 1

echo "bar taps: sent 3, received $barGot"
echo "round button taps: sent $fabSent, received $fabGot"
echo "tap on covered post $under just above the bar opened it: $aboveOpened times (must be 0)"
echo "Show once on covered post $free (clear of the bar) revealed it: $revealed"
echo "other mismatches: $other"
adb logcat -d -s AndroidRuntime:E | grep FATAL || true
if [ "$barGot" = 3 ] && [ "$fabSent" = 1 ] && [ "$fabGot" = 1 ] && [ "$aboveOpened" = 0 ] && [ $revealed = yes ] && [ "$other" = 0 ]; then
  echo PASS
else
  echo FAIL; exit 1
fi
