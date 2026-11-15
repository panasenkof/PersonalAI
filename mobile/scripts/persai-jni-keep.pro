# PersAI: app-owned R8/JNI contract. Injected into generated app/proguard-rules.pro
# by expo-build-properties extraProguardRules (app.config.js). Do not use -dontshrink globally.
# JNI upcalls use names invisible to R8's normal reachability analysis.
-keep class org.pytorch.executorch.** { *; }
-keep class com.swmansion.rnexecutorch.** { *; }
-keep class com.googlecode.tesseract.android.** { *; }
-keep class expo.modules.persaidiagnostics.** { *; }
-keep class expo.modules.persaipdf.** { *; }
# Opt-in Kotlin 2.4 vision engine and its JNI-bound runtime.
# The R8 smoke detected removal of VisionInteropApi (the Kotlin 2.4 AAR Java ABI).
-keep class com.persai.visionsdkprobe.VisionInteropApi { *; }
-keep class expo.modules.persaivision.** { *; }
-keep class com.google.ai.edge.litertlm.** { *; }
-keep class com.google.mediapipe.tasks.retrieval.** { *; }
# Existing TDLib JsonClient rule stays in persai-tdlib/android/consumer-rules.pro.
# Do not add ONNX: PersAI currently uses ExecuTorch rather than ONNX Runtime.
