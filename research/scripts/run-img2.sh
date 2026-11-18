#!/bin/bash
# second image batch: MobileCLIP-S2, SigLIP2 (fp32 vision upper bound, own per-channel int8 vision)
cd "$(dirname "$0")/.."
echo "== mobileclip_s2"; node --max-old-space-size=3000 scripts/img-embed.mjs Xenova/mobileclip_s2 2>&1 | grep -E "images 5|rror"; node scripts/img-score.mjs mobileclip_s2
echo "== siglip2 fp32 vision"; TD=fp16 VD=fp32 TAG=-fp32 node --max-old-space-size=3000 scripts/img-embed.mjs onnx-community/siglip2-base-patch16-224-ONNX 2>&1 | grep -E "images 5|rror"; node scripts/img-score.mjs siglip2-base-patch16-224-ONNX-fp32
echo "== siglip2 int8pc vision"; TD=fp16 VD=int8 TAG=-int8pc node --max-old-space-size=3000 scripts/img-embed.mjs onnx-community/siglip2-base-patch16-224-ONNX 2>&1 | grep -E "images 5|rror"; node scripts/img-score.mjs siglip2-base-patch16-224-ONNX-int8pc
echo ALLDONE
