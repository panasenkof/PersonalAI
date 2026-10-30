package com.persai.visionlab

import org.junit.Assert.assertEquals
import org.junit.Test

/**
 * The Vivo Android 16 device failed at embedder-create with
 * NoClassDefFoundError: com.google.ai.edge.litertlm.ActivationDataType.
 *
 * A successful MediaPipe compilation does not prove that this class is
 * included on the consuming app's resolved *runtime* classpath.
 */
class RuntimeDependencyTest {
  @Test fun mediaPipeActivationDataTypeClassIsOnAppRuntimeClasspath() {
    val name = "com.google.ai.edge.litertlm.ActivationDataType"
    val loaded = javaClass.classLoader!!.loadClass(name)
    assertEquals(name, loaded.name)
  }
}
