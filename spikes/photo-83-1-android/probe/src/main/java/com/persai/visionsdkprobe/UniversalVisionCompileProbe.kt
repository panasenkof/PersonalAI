package com.persai.visionsdkprobe

import android.content.Context
import android.graphics.Bitmap
import com.google.mediapipe.framework.image.BitmapImageBuilder
import com.google.mediapipe.tasks.core.BaseOptions
import com.google.mediapipe.tasks.retrieval.universalembedder.UniversalEmbedder
import com.google.mediapipe.tasks.retrieval.universalembedder.UniversalEmbedderOptions
import java.io.File

/**
 * One isolated offline Android 16 engine. Single-photo and batch experiments
 * share the same model/options/embedding path. Never linked into PersAI.
 */
object UniversalVisionCompileProbe {
  fun compare(
    context: Context, model: File, image: Bitmap, query: String,
    mark: (String) -> Unit = {}
  ): Double = compareMany(
    context = context,
    model = model,
    imageCount = 1,
    query = query,
    imageAt = { image },
    releaseImage = { /* Single photo caller owns its bitmap. */ },
    mark = mark
  ).single()

  /**
   * Encode query once, score 1..5 user-selected photos sequentially with the
   * same embedder, then close it. No image/vector caching or extra writer.
   * imageAt must decode only one bitmap at a time; releaseImage must recycle it.
   */
  fun compareMany(
    context: Context,
    model: File,
    imageCount: Int,
    query: String,
    imageAt: (Int) -> Bitmap,
    releaseImage: (Bitmap) -> Unit,
    mark: (String) -> Unit = {}
  ): List<Double> {
    require(model.isFile && model.name.endsWith(".litertlm")) { "vision_model_absent" }
    require(query.isNotBlank()) { "vision_query_absent" }
    require(imageCount in 1..5) { "invalid_image_batch_size" }
    mark("embedder-options")
    val options = UniversalEmbedderOptions.builder()
      .setBaseOptions(BaseOptions.builder().setModelAssetPath(model.absolutePath).build())
      .setL2Normalize(true)
      .build()
    mark("embedder-create")
    val embedder = UniversalEmbedder.createFromOptions(context, options)
    return try {
      mark("embed-text")
      val textEmbedding = embedder.embedText(query).embeddings().first()
      List(imageCount) { index ->
        mark("image-decode")
        val bitmap = imageAt(index)
        try {
          mark("embed-image")
          val imageEmbedding = embedder.embedImage(
            BitmapImageBuilder(bitmap).build()
          ).embeddings().first()
          mark("cosine-similarity")
          val similarity = UniversalEmbedder.cosineSimilarity(
            textEmbedding, imageEmbedding
          )
          check(similarity.isFinite() && similarity in -1.00001..1.00001) {
            "invalid_similarity"
          }
          similarity
        } finally {
          releaseImage(bitmap)
        }
      }
    } finally {
      mark("embedder-close")
      embedder.close()
    }
  }
}
