package com.persai.visionsdkprobe

import android.content.Context
import android.graphics.Bitmap
import com.google.mediapipe.framework.image.BitmapImageBuilder
import com.google.mediapipe.tasks.core.BaseOptions
import com.google.mediapipe.tasks.retrieval.universalembedder.UniversalEmbedder
import com.google.mediapipe.tasks.retrieval.universalembedder.UniversalEmbedderOptions
import java.io.File

/**
 * Compile-only native SDK API contract with Kotlin 2.4.21.
 * This library is never linked into the production app.
 * Model path must be an app-owned local file in eventual device tests.
 */
object UniversalVisionCompileProbe {
  fun compare(
    context: Context, model: File, image: Bitmap, query: String,
    mark: (String) -> Unit = {}
  ): Double {
    require(model.isFile && model.name.endsWith(".litertlm")) { "vision_model_absent" }
    require(query.isNotBlank()) { "vision_query_absent" }
    mark("embedder-options")
    val options = UniversalEmbedderOptions.builder()
      .setBaseOptions(BaseOptions.builder().setModelAssetPath(model.absolutePath).build())
      .setL2Normalize(true)
      .build()
    mark("embedder-create")
    val embedder = UniversalEmbedder.createFromOptions(context, options)
    return try {
      mark("embed-text")
      val textResult = embedder.embedText(query)
      mark("embed-image")
      val imageResult = embedder.embedImage(BitmapImageBuilder(image).build())
      mark("cosine-similarity")
      val similarity = UniversalEmbedder.cosineSimilarity(
        textResult.embeddings().first(), imageResult.embeddings().first())
      check(similarity.isFinite()) { "invalid_similarity" }
      similarity
    } finally {
      mark("embedder-close")
      embedder.close()
    }
  }
}
