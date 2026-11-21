#!/bin/bash
# usage: search.sh  -> writes cand/<slug>.txt
cd "$(dirname "$0")/../../data/speech"; mkdir -p cand
s(){ slug=$1; shift; yt-dlp "ytsearch30:$*" --flat-playlist --print "%(id)s|%(duration)s|%(title)s" > cand/$slug.txt 2>/dev/null; }
s a_gta6_clip "GTA 6 clip shorts"
s a_gta6_funny "GTA 6 funny moment"
s a_gta6_short "GTA 6 gameplay short"
s a_elden "Elden Ring clip shorts"
s a_cp "Cyberpunk 2077 clip shorts"
s b_gta6 "GTA 6 review reaction first hour"
s b_dune "Dune Part Two review"
s b_opp "Oppenheimer ending explained"
s c_bb "Breaking Bad scene"
s c_int "Interstellar docking scene"
s c_joker "Joker stairs scene"
