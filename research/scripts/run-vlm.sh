#!/bin/bash
# VLM batch, one model at a time (llama-server, 4 threads)
cd "$(dirname "$0")/.."
G=models/gguf
for pair in "SmolVLM-256M-Instruct-Q8_0 mmproj-SmolVLM-256M-Instruct-Q8_0" "LFM2.5-VL-450M-Q8_0 mmproj-LFM2.5-VL-450m-Q8_0" "SmolVLM2-500M-Video-Instruct-Q8_0 mmproj-SmolVLM2-500M-Video-Instruct-Q8_0" "Qwen3.5-0.8B-Q4_K_M mmproj-Qwen3.5-0.8B-F16"; do
  set -- $pair
  while [ $(free -m | awk '/Mem:/{print $7}') -lt 5000 ]; do sleep 10; done
  timeout 2400 node scripts/vlm-eval.mjs $G/$1.gguf $G/$2.gguf 4 80 2>&1 | tail -1
done
echo ALLDONE
