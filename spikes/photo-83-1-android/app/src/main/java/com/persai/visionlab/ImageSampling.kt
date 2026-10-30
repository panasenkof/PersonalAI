package com.persai.visionlab

/**
 * Bounded image decode factor for Android's BitmapFactory.
 * BitmapFactory.Options.inSampleSize may start at 0, which BitmapFactory
 * itself tolerates; integer division in application code does not.
 *
 * Keep this calculation independent of Android framework classes so the
 * factor can be tested on the JVM without a device.
 */
internal object ImageSampling {
  private const val MAX_DECODED_SIDE = 1536

  fun factor(width: Int, height: Int): Int {
    require(width > 0 && height > 0) { "invalid_image_dimensions" }
    var sample = 1
    while (width / sample > MAX_DECODED_SIDE ||
      height / sample > MAX_DECODED_SIDE) {
      sample *= 2
    }
    return sample
  }
}
