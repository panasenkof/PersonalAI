package expo.modules.persaivoice

import android.app.Activity
import android.content.Intent
import android.speech.RecognizerIntent
import expo.modules.kotlin.Promise
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

/**
 * The single Android Google/system speech Activity bridge used by PersAI.
 *
 * OEMs can return non-serializable values in Intent extras (e.g. a Class
 * object on Vivo/Android 16). Never pass the raw Intent, Bundle or extras
 * through Expo's generic JavaScript converter: extract only a String.
 *
 * The system owns microphone capture, endpointing and UI. No permissions,
 * background service, audio storage or second recognition engine here.
 */
class PersaiVoiceActivityModule : Module() {
  // Deliberately distinct from expo-intent-launcher's request code 12.
  private companion object {
    const val REQUEST_CODE = 0x5A31
    const val MAX_TRANSCRIPT_CHARS = 16_000
  }
  private var pendingPromise: Promise? = null

  override fun definition() = ModuleDefinition {
    Name("PersaiVoiceActivity")

    AsyncFunction("launchAsync") { promise: Promise ->
      if (pendingPromise != null) {
        promise.reject("E_VOICE_BUSY", "Speech recognition is already running", null)
        return@AsyncFunction
      }

      val intent = Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH).apply {
        putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
        putExtra(RecognizerIntent.EXTRA_LANGUAGE, "ru-RU")
        putExtra(RecognizerIntent.EXTRA_PREFER_OFFLINE, false)
        putExtra(RecognizerIntent.EXTRA_MAX_RESULTS, 1)
      }
      pendingPromise = promise
      try {
        appContext.throwingActivity.startActivityForResult(intent, REQUEST_CODE)
      } catch (e: Exception) {
        pendingPromise = null
        promise.reject("E_VOICE_LAUNCH", "Could not open system speech recognition", e)
      }
    }

    OnActivityResult { _, payload ->
      if (payload.requestCode != REQUEST_CODE) return@OnActivityResult
      val promise = pendingPromise ?: return@OnActivityResult
      pendingPromise = null

      if (payload.resultCode != Activity.RESULT_OK) {
        promise.resolve(mapOf("status" to "canceled", "transcript" to ""))
        return@OnActivityResult
      }

      // getStringArrayListExtra accesses one known key. Ignore every other
      // OEM/vendor extra, including non-JS types like ActivityOptionsInjector.
      val transcript = try {
        payload.data?.getStringArrayListExtra(RecognizerIntent.EXTRA_RESULTS)
          ?.firstOrNull { !it.isNullOrBlank() }
          ?.trim()
          ?.take(MAX_TRANSCRIPT_CHARS)
          .orEmpty()
      } catch (e: Exception) {
        promise.reject("E_VOICE_RESULT", "Could not read speech recognition result", e)
        return@OnActivityResult
      }

      promise.resolve(mapOf(
        "status" to if (transcript.isNotEmpty()) "recognized" else "empty",
        "transcript" to transcript
      ))
    }

    OnDestroy {
      pendingPromise?.reject("E_VOICE_DESTROYED", "Speech recognition was interrupted", null)
      pendingPromise = null
    }
  }
}
