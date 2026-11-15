# PersAI: app-owned R8/JNI contract. Added to Expo-generated app/proguard-rules.pro
# by prepare-android-release.cjs. Do not use -dontshrink globally.
# JNI upcalls use names invisible to R8's normal reachability analysis.
-keep class org.pytorch.executorch.** { *; }
-keep class com.googlecode.tesseract.android.** { *; }
-keep class expo.modules.persaidiagnostics.** { *; }
# Existing TDLib JsonClient rule stays in persai-tdlib/android/consumer-rules.pro.
# Do not add ONNX: PersAI currently uses ExecuTorch rather than ONNX Runtime.
