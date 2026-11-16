package expo.modules.persaidiagnostics

import android.app.ApplicationExitInfo
import android.content.Context
import android.os.Process
import java.io.File
import java.io.FileOutputStream
import java.io.PrintWriter
import java.io.StringWriter
import kotlin.system.exitProcess

/**
 * One pending, bounded Java stack for the already-existing Android exit report UI.
 * ApplicationExitInfo does not normally provide a stack for REASON_CRASH.
 *
 * No analytics, uploader, permission, profile database or secondary log archive.
 * The file is private, excluded from backup, replaced on the next Java crash
 * and expires after seven days. All failures defer to Android's original handler.
 */
internal object PersaiJavaCrashCapture {
  private const val VERSION = "persai-java-crash-v1"
  private const val FILENAME = "persai-pending-java-crash.txt"
  private const val TEMP_FILENAME = "persai-pending-java-crash.tmp"
  private const val MAX_STACK_CHARS = 32_768
  private const val MAX_FILE_BYTES = 80_000
  private const val RETENTION_MS = 7L * 24 * 60 * 60 * 1000
  private const val MATCH_WINDOW_MS = 120_000L

  internal data class CapturedStack(val bytes: ByteArray, val truncated: Boolean)
  private var installed = false

  @Synchronized
  fun install(context: Context) {
    if (installed) return
    val current = Thread.getDefaultUncaughtExceptionHandler()
    if (current is RecordingHandler) {
      installed = true
      return
    }
    Thread.setDefaultUncaughtExceptionHandler(RecordingHandler(context.applicationContext, current))
    installed = true
  }

  private class RecordingHandler(
    private val context: Context,
    private val previous: Thread.UncaughtExceptionHandler?
  ) : Thread.UncaughtExceptionHandler {
    override fun uncaughtException(thread: Thread, error: Throwable) {
      // Never turn diagnostics failures into a different crash or swallow the original.
      try {
        val timestamp = System.currentTimeMillis()
        val writer = StringWriter()
        error.printStackTrace(PrintWriter(writer))
        val stack = writer.toString()
        val wasTruncated = stack.length > MAX_STACK_CHARS
        val body = buildString {
          append(VERSION).append('|').append(timestamp).append('|').append(Process.myPid())
            .append('|').append(if (wasTruncated) "1" else "0").append('\n')
          append("thread: ").append(thread.name.replace('\n', ' ').replace('\r', ' ').take(120))
            .append('\n')
          append(stack.take(MAX_STACK_CHARS))
        }
        val pending = File(context.noBackupFilesDir, FILENAME)
        val temporary = File(context.noBackupFilesDir, TEMP_FILENAME)
        FileOutputStream(temporary).use { stream ->
          stream.write(body.toByteArray(Charsets.UTF_8))
          stream.fd.sync()
        }
        if (!temporary.renameTo(pending)) temporary.delete()
      } catch (_: Throwable) {
        // Out-of-memory and file system errors must not hide the actual exception.
      } finally {
        if (previous != null && previous !== this) {
          previous.uncaughtException(thread, error)
        } else {
          Process.killProcess(Process.myPid())
          exitProcess(10)
        }
      }
    }
  }

  /** Match both PID and exit time to prevent attaching the wrong crash stack. */
  fun readFor(context: Context, info: ApplicationExitInfo): CapturedStack? {
    if (info.reason != ApplicationExitInfo.REASON_CRASH) return null
    val pending = File(context.noBackupFilesDir, FILENAME)
    try {
      if (!pending.isFile) return null
      val age = System.currentTimeMillis() - pending.lastModified()
      if (age > RETENTION_MS || age < -MATCH_WINDOW_MS) {
        pending.delete()
        return null
      }
      if (pending.length() < 20 || pending.length() > MAX_FILE_BYTES) return null
      val content = pending.readText(Charsets.UTF_8)
      val headerEnd = content.indexOf('\n')
      if (headerEnd < 0) return null
      val fields = content.substring(0, headerEnd).split('|')
      if (fields.size != 4 || fields[0] != VERSION) return null
      val timestamp = fields[1].toLongOrNull() ?: return null
      val pid = fields[2].toIntOrNull() ?: return null
      if (pid != info.pid || timestamp > info.timestamp + 5_000 ||
        info.timestamp - timestamp > MATCH_WINDOW_MS) return null
      val bytes = content.substring(headerEnd + 1).toByteArray(Charsets.UTF_8)
      if (bytes.isEmpty()) return null
      return CapturedStack(bytes, fields[3] == "1")
    } catch (_: Exception) {
      return null
    }
  }
}
