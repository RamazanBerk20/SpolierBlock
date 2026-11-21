#!/bin/bash
cd "$(dirname "$0")/../../data/speech"; mkdir -p cand
s(){ slug=$1; shift; yt-dlp "ytsearch40:$*" --flat-playlist --print "%(id)s|%(duration)s|%(title)s" > cand/$slug.txt 2>/dev/null; }
s a2_gta6 "GTA 6 #shorts"
s a2_gta6b "GTA 6 gameplay #shorts funny"
s a2_elden "Elden Ring #shorts"
s a2_cp "Cyberpunk 2077 #shorts"
