package com.persai.visionlab

/**
 * Diagnostic for failures during the isolated offline inference experiment.
 *
 * Only Java/Kotlin class identifiers and a fixed stage label are shown.
 * Never echo raw exception messages for arbitrary failures: those may contain
 * app-private file paths, SAF URIs, user prompts or photo names.
 */
internal object VisionFailure {
  private val classToken = Regex(
    """(?:L)?(?:[A-Za-z_$][A-Za-z0-9_$]*[./])+[A-Za-z_$][A-Za-z0-9_$]*(?:;)?"""
  )
  private val allowedStages = setOf(
    "image-decode", "image-metrics", "embedder-options", "embedder-create",
    "embed-text", "embed-reference", "embed-image", "cosine-similarity", "embedder-close"
  )

  fun report(stage: String, error: Throwable): String {
    val safeStage = if (stage in allowedStages) stage else "unknown"
    var item: Throwable? = error
    repeat(5) {
      val current = item ?: return@repeat
      if (current is NoClassDefFoundError || current is ClassNotFoundException) {
        // Extract class identifier only, not a complete (possibly sensitive)
        // exception message. Support Android ART: "Failed resolution of: Lx/y/Z;".
        val token = classToken.find(current.message.orEmpty())?.value
          ?.removePrefix("L")?.removeSuffix(";")?.replace('/', '.')
          ?.take(180)
        return "Этап: $safeStage. Не найден класс: ${token ?: "неизвестен"}. " +
          "Вероятна несовместимость/неполная упаковка Android SDK. " +
          "Пришлите скриншот этой строки."
      }
      item = current.cause
    }
    return "Этап: $safeStage. Ошибка: ${error.javaClass.simpleName}. " +
      "Не удалось завершить запуск локальной модели. Пришлите скриншот."
  }
}
