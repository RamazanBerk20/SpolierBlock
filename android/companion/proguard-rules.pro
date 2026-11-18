# The extension's sources are shared with the patch bundle; the model classes (ONNX Runtime, Tesseract) are compile-only
# here and never reached from the companion's entry points.
-dontwarn ai.onnxruntime.**
-dontwarn com.googlecode.tesseract.**
