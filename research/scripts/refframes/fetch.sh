#!/usr/bin/env bash
# Downloads each video of videos.json at <=360p (only the listed section), extracts sparse frames, deletes the video.
# Frames: research/data/refframes/frames/<id>/NNNNN.jpg, frame i at section start + i / fps seconds.
# ref videos at 1 fps (short trailers, rapid cuts), the rest at 0.4 fps (every 2nd frame = the product's 5 s sampling).
# Sections are cut to their first 360 s (section downloads stream at about 2-3x real time).
# usage (from the repo root): flock ~/.cache/sb-heavy.lock research/scripts/refframes/fetch.sh  (several copies may run
# side by side under one lock: each video is claimed with mkdir)
set -u
D=research/data/refframes
mkdir -p "$D/frames" "$D/dl" "$D/claim"
# VIDEOS=videos2.json LEN=150 for the wider set of footage.mjs (search2.mjs)
V=${VIDEOS:-videos.json} LEN=${LEN:-360}
node -e 'for (const v of require("./research/scripts/refframes/" + process.argv[1])) console.log(v.slice(0, 4).join("\t"))' "$V" |
while IFS=$'\t' read -r id cat split sec; do
  out="$D/frames/$id"
  [ -f "$out/.done" ] && continue
  mkdir "$D/claim/$id" 2>/dev/null || continue
  rm -rf "$out" "$D/dl/$id".*; mkdir -p "$out"
  args=(); [ -n "$sec" ] && args=(--download-sections "*${sec%-*}-$(( ${sec%-*} + LEN ))")
  timeout 300 yt-dlp -q --no-warnings --no-playlist --socket-timeout 30 -f 'bv*[height<=360]/b[height<=360]/wv*' "${args[@]}" -o "$D/dl/$id.%(ext)s" -- "$id" < /dev/null \
    || { echo "FAIL download $id ($cat)"; continue; }
  fps=0.4; [ "$split" = ref ] && fps=1
  f=$(ls "$D/dl/$id".* | head -1)
  ffmpeg -nostdin -loglevel error -i "$f" -vf "fps=$fps,scale=-2:360" -q:v 3 "$out/%05d.jpg" && touch "$out/.done" || echo "FAIL ffmpeg $id"
  rm -f "$D/dl/$id".*
  echo "$id $cat $split $(ls "$out" | wc -l) frames"
done
