package expo.modules.persaivision

import android.graphics.BitmapFactory
import android.os.Build
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.File
import java.security.MessageDigest

/**
 * 83.1 Android-only *isolated* inference probe. It does not touch user memory,
 * native search indexes, cloud APIs or logs. A real local model + real photo
 * must be staged deliberately; missing weights are a normal fail-closed result.
 */
class PersaiVisionProbeModule : Module() {
  private fun privateFile(base: File, folder: String, name: String, suffixes: Set<String>): File {
    require(Regex("^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,119}$").matches(name) &&
      name != "." && name != ".." && suffixes.any { name.lowercase().endsWith(it) }) {
      "invalid_vision_asset_name"
    }
    val root = File(base, folder).canonicalFile
    val file = File(root, name).canonicalFile
    require(file.parentFile == root) { "vision_asset_outside_sandbox" }
    require(file.isFile) { "vision_asset_absent" }
    return file
  }

  private fun sha256(file: File): String {
    val digest = MessageDigest.getInstance("SHA-256")
    file.inputStream().buffered().use { stream ->
      val buffer = ByteArray(256 * 1024)
      while (true) {
        val n = stream.read(buffer)
        if (n < 0) break
        if (n > 0) digest.update(buffer, 0, n)
      }
    }
    return digest.digest().joinToString("") { "%02x".format(it.toInt() and 0xff) }
  }

  private fun checkedModel(ctx: android.content.Context, name: String, checksum: String): File {
    require(Build.VERSION.SDK_INT >= 26) { "vision_android_version_unsupported" }
    require(checksum.matches(Regex("^[a-f0-9]{64}$"))) { "invalid_vision_model_checksum" }
    val model = privateFile(ctx.filesDir, "persai-vision-models", name, setOf(".litertlm"))
    require(model.length() in 1024L..(1024L * 1024 * 1024)) { "invalid_vision_model_size" }
    require(sha256(model) == checksum) { "vision_model_checksum_mismatch" }
    return model
  }

  private fun checkedImage(ctx: android.content.Context, name: String): File {
    val image = privateFile(ctx.cacheDir, "persai-vision-probe", name,
      setOf(".jpg", ".jpeg", ".png", ".webp"))
    require(image.length() in 1L..(12L * 1024 * 1024)) { "invalid_vision_image_size" }
    val dimensions = BitmapFactory.Options().apply { inJustDecodeBounds = true }
    BitmapFactory.decodeFile(image.absolutePath, dimensions)
    require(dimensions.outWidth in 1..4096 && dimensions.outHeight in 1..4096) {
      "vision_image_dimensions_unsupported"
    }
    return image
  }

  /** 768D normalized floating-point values only, not an identity match or
   * search hit. This is still opt-in and isolated from SQLCipher indexing.
   */
  private fun validatedVector(values: FloatArray): List<Double> {
    require(values.size == 768 && values.all { it.isFinite() }) { "invalid_vision_vector" }
    return values.map { it.toDouble() }
  }

  override fun definition() = ModuleDefinition {
    Name("PersaiVisionProbe")

    Function("isSupported") { Build.VERSION.SDK_INT >= 26 }

    AsyncFunction("embedTextVector") {
        modelName: String, modelSha256: String, query: String ->
      require(query.isNotBlank() && query.length <= 256) { "invalid_vision_query" }
      val ctx = appContext.reactContext ?: throw IllegalStateException("vision_context_unavailable")
      val model = checkedModel(ctx, modelName, modelSha256)
      validatedVector(VisionProbeEngine.textVector(ctx, model.absolutePath, query))
    }

    AsyncFunction("embedImageVector") {
        modelName: String, modelSha256: String, imageName: String ->
      val ctx = appContext.reactContext ?: throw IllegalStateException("vision_context_unavailable")
      val model = checkedModel(ctx, modelName, modelSha256)
      val image = checkedImage(ctx, imageName)
      val bitmap = BitmapFactory.decodeFile(image.absolutePath)
        ?: throw IllegalArgumentException("vision_image_decode_failed")
      try {
        validatedVector(VisionProbeEngine.imageVector(ctx, model.absolutePath, bitmap))
      } finally {
        bitmap.recycle()
      }
    }

    AsyncFunction("scoreTextAgainstImage") {
        modelName: String, modelSha256: String, imageName: String, query: String ->
      require(Build.VERSION.SDK_INT >= 26) { "vision_android_version_unsupported" }
      require(modelSha256.matches(Regex("^[a-f0-9]{64}$"))) { "invalid_vision_model_checksum" }
      require(query.isNotBlank() && query.length <= 256) { "invalid_vision_query" }
      val ctx = appContext.reactContext ?: throw IllegalStateException("vision_context_unavailable")
      val model = checkedModel(ctx, modelName, modelSha256)
      val image = checkedImage(ctx, imageName)
      // The model is opened only for this single opt-in lab call and released
      // even after an inference failure. NEVER log the query, paths or image.
      val bitmap = BitmapFactory.decodeFile(image.absolutePath)
        ?: throw IllegalArgumentException("vision_image_decode_failed")
      val start = System.nanoTime()
      try {
        // Do not reference vendor Kotlin metadata here: the tested bridge
        // has a Java-only API boundary for the newer LiteRT SDK.
        val cosine = VisionProbeEngine.score(ctx, model.absolutePath, bitmap, query)
        require(cosine.isFinite() && cosine in -1.00001..1.00001) {
          "invalid_vision_similarity"
        }
        mapOf(
          "cosine" to cosine,
          "elapsedMs" to ((System.nanoTime() - start) / 1_000_000L),
          "model" to "embeddinggemma2-text-vision-spike"
        )
      } finally {
        bitmap.recycle()
      }
    }
  }
}
