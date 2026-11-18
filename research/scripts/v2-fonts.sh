#!/bin/sh
# OFL display fonts used only to render the v2 OCR evaluation images (not shipped). usage: sh v2-fonts.sh <outDir>
mkdir -p "$1" && cd "$1" || exit 1
G=https://raw.githubusercontent.com/google/fonts/main/ofl
for f in anton/Anton-Regular.ttf bebasneue/BebasNeue-Regular.ttf bangers/Bangers-Regular.ttf creepster/Creepster-Regular.ttf \
  pressstart2p/PressStart2P-Regular.ttf "cinzel/Cinzel%5Bwght%5D.ttf" "montserrat/Montserrat%5Bwght%5D.ttf" "oswald/Oswald%5Bwght%5D.ttf"; do
  out=$(basename "$f" | sed 's/%5B.*%5D//')
  curl -sSfL -o "$out" "$G/$f" || echo "FAIL $f"
done
ls -la
