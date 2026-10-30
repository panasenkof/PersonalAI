package com.persai.visionlab

/** Offline, read-only ranking. User selection order is the stable identity. */
internal object VisionRanking {
  data class RankedPhoto(val selectedNumber: Int, val cosine: Double)

  fun order(scores: List<Double>): List<RankedPhoto> {
    require(scores.size in 2..5) { "rank_requires_two_to_five_photos" }
    require(scores.all { it.isFinite() && it in -1.00001..1.00001 }) {
      "invalid_cosine_score"
    }
    return scores.mapIndexed { index, value -> RankedPhoto(index + 1, value) }
      .sortedWith(
        compareByDescending<RankedPhoto> { it.cosine }.thenBy { it.selectedNumber }
      )
  }
}
