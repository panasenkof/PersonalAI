package com.persai.visioninteropconsumer

import android.content.Context
import android.graphics.Bitmap
import com.persai.visionsdkprobe.VisionInteropApi
import java.io.File

/** Compiler-only gate: Kotlin 2.1 consumes a Kotlin 2.4 compiled AAR
 * through the Java public ABI, not through Kotlin's 2.4 metadata.
 * Not called at application startup; no model bytes in the APK.
 */
object ConsumerBridge {
  fun score(context: Context, model: File, photo: Bitmap, query: String): Double =
    VisionInteropApi.scoreTextImage(context, model, photo, query)
}
