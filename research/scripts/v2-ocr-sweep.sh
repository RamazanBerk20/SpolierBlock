#!/bin/sh
# OCR sweep (run from the repo root, under flock): tesseract baseline, PP-OCR detector/recogniser/size variants.
export SB_RESEARCH=${SB_RESEARCH:?}
O=$SB_RESEARCH/results/v2/models/ocr
E="node research/scripts/v2-ocr-eval.mjs"
$E tesseract
for dm in 960:0 960:384 960:512 960:736 640:0; do $E "ppocr:$O/ch_PP-OCRv5_det_mobile.onnx:$O/en_PP-OCRv5_rec_mobile.onnx:$dm"; done
$E "ppocr:$O/ch_PP-OCRv4_det_mobile.onnx:$O/en_PP-OCRv5_rec_mobile.onnx"
$E "ppocr:$O/en_PP-OCRv3_det_mobile.onnx:$O/en_PP-OCRv5_rec_mobile.onnx"
$E "ppocr:$O/ch_PP-OCRv5_det_mobile.onnx:$O/en_PP-OCRv4_rec_mobile.onnx"
$E "ppocr:$O/ch_PP-OCRv5_det_mobile.onnx:$O/latin_PP-OCRv5_rec_mobile.onnx"
