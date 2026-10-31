package com.persai.visionsdkprobe;

import android.content.Context;
import android.graphics.Bitmap;
import java.io.File;
import kotlin.Unit;
import kotlin.jvm.functions.Function1;

/**
 * Minimal Java ABI for the exact already-tested Kotlin 2.4 vision engine.
 * Do NOT put UniversalEmbedder, vendor Kotlin types, vectors, or Kotlin
 * Function1 in any PUBLIC signature visible to a Kotlin 2.1 consumer.
 * Runtime dependencies are deliberately not exposed on the consuming
 * Kotlin compiler classpath. This is a compile-time interoperability
 * experiment, not a supported Expo production engine or index.
 */
public final class VisionInteropApi {
  private VisionInteropApi() {}

  /** Java primitive arrays keep Kotlin 2.4 vendor metadata outside the
   * Kotlin 2.1 Expo consumer compile classpath. No SDK types in API.
   */
  public static float[] embedText(Context context, File model, String query) {
    if (context == null || model == null || query == null ||
        query.trim().isEmpty() || query.length() > 256) {
      throw new IllegalArgumentException("invalid_vision_input");
    }
    return UniversalVisionCompileProbe.INSTANCE.embedTextVector(context, model, query);
  }

  public static float[] embedImage(Context context, File model, Bitmap image) {
    if (context == null || model == null || image == null || image.isRecycled()) {
      throw new IllegalArgumentException("invalid_vision_input");
    }
    return UniversalVisionCompileProbe.INSTANCE.embedImageVector(context, model, image);
  }

  public static double scoreTextImage(Context context, File model, Bitmap image, String query) {
    if (context == null || model == null || image == null ||
        query == null || query.trim().isEmpty() || query.length() > 256) {
      throw new IllegalArgumentException("invalid_vision_input");
    }
    return UniversalVisionCompileProbe.INSTANCE.compare(
        context, model, image, query, new Function1<String, Unit>() {
          @Override public Unit invoke(String stage) { return Unit.INSTANCE; }
        });
  }
}
