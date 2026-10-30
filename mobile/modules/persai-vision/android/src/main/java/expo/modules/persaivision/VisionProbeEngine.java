package expo.modules.persaivision;

import android.content.Context;
import android.graphics.Bitmap;
import com.persai.visionsdkprobe.VisionInteropApi;
import java.io.File;

/**
 * Thin Expo-side Java adapter for the #83.2 exact-head Android integration gate.
 * Java-facing producer API is the same engine verified on Vivo in Vision Lab.
 * No MediaPipe/Kotlin-2.4 types can escape into the Expo Kotlin 2.1 compiler.
 *
 * The module is still disabled by expo-module.config.json: platforms=[] in
 * every ordinary build. The opt-in CI workflow stages a verified Java-only
 * stub and the separately built engine AAR without replacing the root Kotlin
 * compiler, text embedding model, or any SQLCipher index.
 */
public final class VisionProbeEngine {
  private VisionProbeEngine() {}

  public static double score(Context context, String modelPath, Bitmap bitmap, String query) {
    return VisionInteropApi.scoreTextImage(context, new File(modelPath), bitmap, query);
  }
}
