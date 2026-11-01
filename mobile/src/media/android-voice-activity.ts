import * as IntentLauncher from "expo-intent-launcher";

/**
 * Primary Google/system route on Android: Android resolves a speech Activity
 * and returns recognized text through its result. Avoids direct binding to
 * an OEM RecognitionService that may report ERROR_NO_MATCH.
 *
 * Does not grant any new consent, choose a private package, or use Whisper.
 */
export type AndroidVoiceActivityResult =
  | { status: "recognized"; transcript: string }
  | { status: "canceled" }
  | { status: "empty" };

export function parseAndroidVoiceActivityResult(result: {
  resultCode: number;
  extra?: object;
}): AndroidVoiceActivityResult {
  if (result.resultCode !== -1) return { status: "canceled" };
  const raw = result.extra && "android.speech.extra.RESULTS" in result.extra
    ? result.extra["android.speech.extra.RESULTS"] : undefined;
  const transcript = Array.isArray(raw)
    ? raw.find((item): item is string => typeof item === "string" && item.trim().length > 0)?.trim()
    : undefined;
  return transcript ? { status: "recognized", transcript } : { status: "empty" };
}

/** An explicit user-initiated system dialog; no automatic retry loops. */
export async function launchAndroidVoiceActivity(): Promise<AndroidVoiceActivityResult> {
  const result = await IntentLauncher.startActivityAsync("android.speech.action.RECOGNIZE_SPEECH", {
    extra: {
      "android.speech.extra.LANGUAGE_MODEL": "free_form",
      "android.speech.extra.LANGUAGE": "ru-RU",
      "android.speech.extra.PREFER_OFFLINE": false,
      "android.speech.extra.MAX_RESULTS": 1,
    },
  });
  return parseAndroidVoiceActivityResult(result);
}

