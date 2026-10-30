package expo.modules.persaivision;

import android.content.Context;
import android.graphics.Bitmap;
import com.google.mediapipe.framework.image.BitmapImageBuilder;
import com.google.mediapipe.tasks.core.BaseOptions;
import com.google.mediapipe.tasks.retrieval.universalembedder.UniversalEmbedder;
import com.google.mediapipe.tasks.retrieval.universalembedder.UniversalEmbedderOptions;

/**
 * Java-only adapter for the isolated #83.1 experiment.
 *
 * MediaPipe Tasks Retrieval 1.1.0 resolves LiteRT-LM 0.17 with Kotlin 2.4
 * metadata, while Expo SDK 57 is built with Kotlin 2.1. Keep the vendor API
 * off the Kotlin compiler's source references; javac reads the Java-visible
 * API without attempting to deserialize the newer Kotlin metadata.
 *
 * This is a guarded interoperability experiment, NOT production support:
 * native ABI/runtime compatibility still requires exact-head Android CI and
 * a separate device inference run with real model weights.
 */
public final class VisionProbeEngine {
  private VisionProbeEngine() {}

  public static double score(Context context, String modelPath, Bitmap bitmap, String query) {
    UniversalEmbedderOptions options = UniversalEmbedderOptions.builder()
        .setBaseOptions(BaseOptions.builder().setModelAssetPath(modelPath).build())
        .setL2Normalize(true)
        .build();
    UniversalEmbedder embedder = UniversalEmbedder.createFromOptions(context, options);
    try {
      var textResult = embedder.embedText(query);
      var imageResult = embedder.embedImage(new BitmapImageBuilder(bitmap).build());
      if (textResult.embeddings().isEmpty() || imageResult.embeddings().isEmpty()) {
        throw new IllegalStateException("vision_empty_embedding");
      }
      double score = UniversalEmbedder.cosineSimilarity(
          textResult.embeddings().get(0), imageResult.embeddings().get(0));
      if (!Double.isFinite(score)) throw new IllegalStateException("vision_invalid_similarity");
      return score;
    } finally {
      embedder.close();
    }
  }
}
