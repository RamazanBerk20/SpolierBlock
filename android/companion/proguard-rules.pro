# The extension's sources are shared with the patch bundle; the model classes (ONNX Runtime) are compile-only
# here and never reached from the companion's entry points.
-dontwarn ai.onnxruntime.**
