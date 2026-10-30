package com.persai.visionlab

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class VisionFailureTest {
  @Test fun extractsMissingDexClassWithoutPersonalData() {
    val t = NoClassDefFoundError("Failed resolution of: Lcom/google/ai/edge/SomeClass;")
    val message = VisionFailure.report("embedder-create", t)
    assertTrue(message.contains("com.google.ai.edge.SomeClass"))
    assertTrue(message.contains("embedder-create"))
  }

  @Test fun followsClassNotFoundCause() {
    val missing = ClassNotFoundException("com.google.mediapipe.HiddenDependency")
    val top = IllegalStateException("failed to load /storage/emulated/0/secret.jpg", missing)
    val message = VisionFailure.report("embed-text", top)
    assertTrue(message.contains("com.google.mediapipe.HiddenDependency"))
    assertFalse(message.contains("secret.jpg"))
  }

  @Test fun hidesSensitiveUnknownErrors() {
    val t = IllegalArgumentException("user text /storage/emulated/0/Private/image.jpg")
    val message = VisionFailure.report("some-stage /storage/private", t)
    assertTrue(message.contains("unknown"))
    assertFalse(message.contains("Private"))
    assertFalse(message.contains("user text"))
    assertFalse(message.contains("some-stage"))
  }

  @Test fun handlesNoClassMessageWithoutIdentifier() {
    val message = VisionFailure.report("embed-image", NoClassDefFoundError(null))
    assertTrue(message.contains("неизвестен"))
  }
}
