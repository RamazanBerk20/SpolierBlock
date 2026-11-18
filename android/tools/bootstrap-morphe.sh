#!/usr/bin/env bash
# One-time: the Morphe gradle plugin (2.1.1) and morphe-patcher (2.4.0) are published only to GitHub Packages, which
# needs a token with read:packages. This builds the same tagged sources into ~/.m2 instead (no credentials needed),
# and fetches the Morphe CLI (morphe-desktop) release jar used by apply.sh.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
work=${TMPDIR:-/tmp}/morphe-bootstrap
mkdir -p "$work"
cat > "$work/nosign.gradle" <<'EOF'
allprojects { tasks.withType(Sign).configureEach { enabled = false } }
EOF
build() { # repo, git ref
  [ -d "$work/$1" ] || git clone -q https://github.com/MorpheApp/$1.git "$work/$1"
  git -C "$work/$1" fetch -q --tags && git -C "$work/$1" checkout -q "$2"
  (cd "$work/$1" && ./gradlew -q --init-script "$work/nosign.gradle" publishToMavenLocal -x test)
}
build morphe-patcher v2.4.0
build morphe-patches-gradle-plugin v2.1.1
[ -f "$here/morphe-desktop-2.2.0-all.jar" ] || gh release download v2.2.0 -R MorpheApp/morphe-desktop -p 'morphe-desktop-2.2.0-all.jar' -D "$here"
echo "ok: ~/.m2/repository/app/morphe, $here/morphe-desktop-2.2.0-all.jar"
