import * as IntentLauncher from "expo-intent-launcher";

/**
 * Alternative to a bound SpeechRecognizer service. Android resolves a
 * recognizer Activity itself and returns the text through an Activity result.
 * This can work on OEM builds where the directly bound service reports
 * ERROR_NO_MATCH even though keyboard dictation is available.
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

/** Learn only from a real success; never persist a broken route on the phone. */
let preferredUntilRestart = false;
export function preferAndroidVoiceActivity() { return preferredUntilRestart; }
export function recordAndroidVoiceActivitySuccess() { preferredUntilRestart = true; }
