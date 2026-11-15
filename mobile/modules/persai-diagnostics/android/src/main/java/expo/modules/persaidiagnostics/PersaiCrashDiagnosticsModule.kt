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
      fields(info) + mapOf(
        "format" to if (info.reason == ApplicationExitInfo.REASON_CRASH_NATIVE &&
          Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) "android-native-tombstone-protobuf" else "system-trace",
        "traceBase64" to Base64.encodeToString(bytes.toByteArray(), Base64.NO_WRAP),
        "traceTruncatedOrUnavailable" to truncated,
        "traceAvailable" to (bytes.size() > 0)
      )
    }
  }
}
