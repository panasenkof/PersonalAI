package expo.modules.persaidiagnostics

import android.app.ActivityManager
import android.app.ApplicationExitInfo
import android.os.Build
import android.util.Base64
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.ByteArrayOutputStream

/**
 * Read-only system exit history. No crash handler, network, background upload,
 * or duplicate log store. Binary tombstones are exported only on explicit tap.
 */
class PersaiCrashDiagnosticsModule : Module() {
  private fun recentCrashes(): List<ApplicationExitInfo> {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.R) return emptyList()
    val context = appContext.reactContext ?: return emptyList()
    val manager = context.getSystemService(ActivityManager::class.java) ?: return emptyList()
    return manager.getHistoricalProcessExitReasons(context.packageName, 0, 32)
      .filter {
        it.reason == ApplicationExitInfo.REASON_CRASH_NATIVE ||
          it.reason == ApplicationExitInfo.REASON_CRASH ||
          it.reason == ApplicationExitInfo.REASON_ANR
      }
      .filter { it.timestamp > System.currentTimeMillis() - 7L * 24 * 60 * 60 * 1000 }
  }

  private fun fields(info: ApplicationExitInfo): Map<String, Any?> = mapOf(
    "timestamp" to info.timestamp.toDouble(),
    "reason" to when (info.reason) {
      ApplicationExitInfo.REASON_CRASH_NATIVE -> "native"
      ApplicationExitInfo.REASON_CRASH -> "java"
      else -> "anr"
    },
    "status" to info.status,
    "importance" to info.importance,
    "description" to (info.description ?: "").take(500)
  )

  override fun definition() = ModuleDefinition {
    Name("PersaiCrashDiagnostics")

    // Register when the Expo module starts; Java failures after startup are captured.
    OnCreate { appContext.reactContext?.let { context -> PersaiJavaCrashCapture.install(context) } }

    Function("recentCrashes") { limit: Int ->
      recentCrashes().take(limit.coerceIn(1, 10)).map { fields(it) }
    }

    // Called only after the user explicitly selects an exit report to share.
    // On Android 12+ native tombstones are protobuf, not UTF-8 text.
    Function("getCrashReport") { timestamp: Double ->
      require(timestamp.isFinite() && timestamp >= 0 && timestamp < 9_007_199_254_740_991.0) {
        "invalid_crash_timestamp"
      }
      val info = recentCrashes().firstOrNull { it.timestamp == timestamp.toLong() }
        ?: throw IllegalArgumentException("crash_report_not_found")
      val bytes = ByteArrayOutputStream()
      var truncated = false
      try {
        info.traceInputStream?.use { input ->
          val chunk = ByteArray(8192)
          while (true) {
            val count = input.read(chunk)
            if (count < 0) break
            if (count == 0) continue
            val remaining = 262_144 - bytes.size()
            if (count > remaining) {
              if (remaining > 0) bytes.write(chunk, 0, remaining)
              truncated = true
              break
            }
            bytes.write(chunk, 0, count)
          }
        }
      } catch (_: Exception) {
        // Exit metadata remains useful if Android purged the global tombstone.
        truncated = true
      }
      // Java REASON_CRASH rarely includes an Android system trace. For a matching
      // PID and exit timestamp, use our single private, bounded uncaught stack.
      val systemBytes = bytes.toByteArray()
      val fallback = if (systemBytes.isEmpty() && info.reason == ApplicationExitInfo.REASON_CRASH)
        appContext.reactContext?.let { context -> PersaiJavaCrashCapture.readFor(context, info) }
        else null
      val exported = fallback?.bytes ?: systemBytes
      fields(info) + mapOf(
        "format" to when {
          fallback != null -> "java-stack-utf8"
          info.reason == ApplicationExitInfo.REASON_CRASH_NATIVE &&
            Build.VERSION.SDK_INT >= Build.VERSION_CODES.S -> "android-native-tombstone-protobuf"
          else -> "system-trace"
        },
        "traceSource" to if (fallback != null) "persai-java-uncaught" else "android-system",
        "traceBase64" to Base64.encodeToString(exported, Base64.NO_WRAP),
        "traceTruncatedOrUnavailable" to (truncated || exported.isEmpty() || fallback?.truncated == true),
        "traceAvailable" to exported.isNotEmpty()
      )
    }
  }
}
