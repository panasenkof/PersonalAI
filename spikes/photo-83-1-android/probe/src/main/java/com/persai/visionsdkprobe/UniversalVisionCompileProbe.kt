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

  /** Raw 768D vectors from the SAME model/normalization as compareMany.
   * They are transient: no second index and no source bytes persisted here.
   * The producer may be Kotlin 2.4, but only Java float[] crosses the ABI.
   */
  fun embedTextVector(context: Context, model: File, query: String): FloatArray {
    require(query.isNotBlank() && query.length <= 256) { "invalid_vision_query" }
    return withEmbedder(context, model, {}) { embedder ->
      checkedVector(embedder.embedText(query).embeddings().first().floatEmbedding())
    }
  }

  fun embedImageVector(context: Context, model: File, image: Bitmap): FloatArray {
    require(!image.isRecycled && image.width > 0 && image.height > 0) { "invalid_vision_bitmap" }
    return withEmbedder(context, model, {}) { embedder ->
      checkedVector(embedder.embedImage(
        BitmapImageBuilder(image).build()
      ).embeddings().first().floatEmbedding())
    }
  }

  private fun checkedVector(values: FloatArray): FloatArray {
    check(values.size == 768 && values.all { it.isFinite() }) { "invalid_vision_vector" }
    // Preserve the L2-normalized model output. No dimension truncation,
    // quantization, synthetic results or unversioned model crossovers.
    val energy = values.sumOf { (it * it).toDouble() }
    check(energy.isFinite() && energy in 0.9..1.1) { "invalid_vision_vector_norm" }
    return values.copyOf()
  }

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
    require(query.isNotBlank()) { "vision_query_absent" }
    require(imageCount in 1..5) { "invalid_image_batch_size" }
    return withEmbedder(context, model, mark) { embedder ->
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
          val score = UniversalEmbedder.cosineSimilarity(textEmbedding, imageEmbedding)
          verifyScore(score)
        } finally {
          releaseImage(bitmap)
        }
      }
    }
  }

  /**
   * Reference photo → 2..5 candidates, on device, using exactly the same
   * UniversalEmbedder model, L2 normalization and cosine metric as text.
   * Both the reference and candidates are decoded/released in sequence.
   * Image embeddings are transient and never written to storage.
   */
  fun comparePhotoToMany(
    context: Context,
    model: File,
    imageCount: Int,
    referenceAt: () -> Bitmap,
    candidateAt: (Int) -> Bitmap,
    releaseImage: (Bitmap) -> Unit,
    mark: (String) -> Unit = {}
  ): List<Double> {
    require(imageCount in 2..5) { "invalid_image_batch_size" }
    return withEmbedder(context, model, mark) { embedder ->
      mark("image-decode")
      val reference = referenceAt()
      val referenceEmbedding = try {
        mark("embed-reference")
        embedder.embedImage(BitmapImageBuilder(reference).build()).embeddings().first()
      } finally {
        releaseImage(reference)
      }
      List(imageCount) { index ->
        mark("image-decode")
        val candidate = candidateAt(index)
        try {
          mark("embed-image")
          val candidateEmbedding = embedder.embedImage(
            BitmapImageBuilder(candidate).build()
          ).embeddings().first()
          mark("cosine-similarity")
          verifyScore(UniversalEmbedder.cosineSimilarity(
            referenceEmbedding, candidateEmbedding
          ))
        } finally {
          releaseImage(candidate)
        }
      }
    }
  }

  private fun verifyScore(score: Double): Double {
    check(score.isFinite() && score in -1.00001..1.00001) {
      "invalid_similarity"
    }
    return score
  }

  private fun <T> withEmbedder(
    context: Context,
    model: File,
    mark: (String) -> Unit,
    block: (UniversalEmbedder) -> T
  ): T {
    require(model.isFile && model.name.endsWith(".litertlm")) { "vision_model_absent" }
    mark("embedder-options")
    val options = UniversalEmbedderOptions.builder()
      .setBaseOptions(BaseOptions.builder().setModelAssetPath(model.absolutePath).build())
      .setL2Normalize(true)
      .build()
    mark("embedder-create")
    val embedder = UniversalEmbedder.createFromOptions(context, options)
    return try {
      block(embedder)
    } finally {
      mark("embedder-close")
      embedder.close()
    }
  }
}
