#!/usr/bin/env bash
# Rule 10, videos with no caption, on the installed demo (first flavour, Captionless.java): with demo.test listed the
# short-text player rows must be covered once their player attaches and stay covered while it comes and goes, the row
# with a clean 11-word caption never; with the list empty no row is ever covered. Ends with the list empty.
set -euo pipefail
p=dev.spoilerblock.demo
fail=0
run() { # listed: true|false
  adb shell am force-stop $p
  adb logcat -c
  adb shell am start -W -n $p/.MainActivity --es screen captionless --ez listed "$1" >/dev/null
  sleep 4
  for i in 1 2 3 4 5; do adb shell input swipe 540 1800 540 900 400; sleep 2; done
  adb shell input swipe 540 900 540 1800 400; sleep 2
  adb shell input keyevent KEYCODE_HOME
  sleep 1
  s=$(adb logcat -d -s SBDemo:I | grep "frame check summary" | tail -1)
  n=$(sed -n 's/.*captionless rows covered: \([0-9]*\) of.*/\1/p' <<<"$s")
  m=$(adb logcat -d -s SBDemo:* AndroidRuntime:E | grep -cE "MISMATCH|FATAL" || true)
  echo "listed=$1: ${s#*: }"
  echo "listed=$1: $m mismatch lines, ${n:-?} rows covered"
  [ "$m" = 0 ] || { adb logcat -d -s SBDemo:E | head -3; fail=1; }
  if [ "$1" = true ]; then [ "${n:-0}" -gt 0 ] || fail=1; else [ "${n:-1}" = 0 ] || fail=1; fi
}
run true
run false
[ $fail = 0 ] && echo PASS || { echo FAIL; exit 1; }
