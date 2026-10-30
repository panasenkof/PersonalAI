package com.persai.visionlab

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class VisionRankingTest {
  @Test fun realUserLabeledPositiveRanksAheadOfNegative() {
    // Real Vivo X200 Pro results, annotated by the user as relevant/irrelevant.
    val result = VisionRanking.order(listOf(0.7686, 0.5397))
    assertEquals(listOf(1, 2), result.map { it.selectedNumber })
    assertEquals(0.2289, result.first().cosine - result.last().cosine, 0.00001)
  }

  @Test fun negativeScoresAndMultipleCandidatesAreAllowed() {
    val result = VisionRanking.order(listOf(-0.8, 0.7, -0.2, 0.3, 0.69))
    assertEquals(listOf(2, 5, 4, 3, 1), result.map { it.selectedNumber })
  }

  @Test fun equalScoresKeepManualSelectionOrder() {
    val result = VisionRanking.order(listOf(0.6, 0.6, 0.2))
    assertEquals(listOf(1, 2, 3), result.map { it.selectedNumber })
  }

  @Test(expected = IllegalArgumentException::class)
  fun rejectsSinglePhotoAsRankingSample() {
    VisionRanking.order(listOf(0.2))
  }

  @Test(expected = IllegalArgumentException::class)
  fun rejectsSixPhotosToBoundMemoryAndLatency() {
    VisionRanking.order(List(6) { 0.5 })
  }

  @Test(expected = IllegalArgumentException::class)
  fun rejectsNaNInsteadOfShowingNonsense() {
    VisionRanking.order(listOf(Double.NaN, 0.8))
  }

  @Test fun doesNotInventProbabilityOrThresholdLabels() {
    val result = VisionRanking.order(listOf(0.1, -0.9))
    assertTrue(result.first().cosine < 0.5)
    assertEquals(1, result.first().selectedNumber)
  }
}
