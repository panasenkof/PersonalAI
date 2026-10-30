package com.persai.visionlab

import org.junit.Assert.assertEquals
import org.junit.Test

class ImageSamplingTest {
  @Test fun defaultAndSmallPhotosNeverDivideByZero() {
    assertEquals(1, ImageSampling.factor(1, 1))
    assertEquals(1, ImageSampling.factor(1536, 1536))
    assertEquals(1, ImageSampling.factor(640, 480))
  }

  @Test fun largerPhonePhotosAreDownsampled() {
    assertEquals(2, ImageSampling.factor(1537, 1536))
    assertEquals(2, ImageSampling.factor(2048, 1536))
    assertEquals(4, ImageSampling.factor(4032, 3024))
    assertEquals(8, ImageSampling.factor(8064, 6048))
    assertEquals(16, ImageSampling.factor(16384, 12000))
  }

  @Test fun keepsBothDimensionsWithinLimitForAllowedPhotos() {
    val photos = listOf(
      1 to 1, 640 to 480, 1536 to 1536, 1537 to 1024,
      4032 to 3024, 8064 to 6048, 16384 to 16384
    )
    for ((width, height) in photos) {
      val sample = ImageSampling.factor(width, height)
      assert(sample >= 1)
      assertEquals(0, sample and (sample - 1)) // power of two
      assert(width / sample <= 1536)
      assert(height / sample <= 1536)
    }
  }

  @Test(expected = IllegalArgumentException::class)
  fun rejectsZeroWidthBeforeAnyDivide() {
    ImageSampling.factor(0, 4000)
  }

  @Test(expected = IllegalArgumentException::class)
  fun rejectsZeroHeightBeforeAnyDivide() {
    ImageSampling.factor(4000, 0)
  }
}
