#!/bin/bash
# downloads first 45 s audio of every manifest clip as 16 kHz mono wav; failures logged to dl-failed.txt
cd "$(dirname "$0")/../../data/speech"; : > dl-failed.txt
for id in $(node -e "console.log(require('./manifest.json').map(c=>c.id).join(' '))"); do
  [ -s clips/$id.wav ] && continue
  /usr/bin/yt-dlp -q --no-warnings -x --audio-format wav --postprocessor-args "ffmpeg:-ar 16000 -ac 1" \
    --download-sections "*0-45" --no-playlist -o "clips/$id.%(ext)s" "https://www.youtube.com/watch?v=$id" 2>>dl-err.txt || echo $id >> dl-failed.txt
done
echo finished > dl-done.txt
