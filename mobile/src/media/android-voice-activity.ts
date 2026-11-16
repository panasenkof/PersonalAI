import { requireOptionalNativeModule } from "expo-modules-core";

/**
 * The Google/system Android dialog remains the only Android online ASR route.
 * A typed PersAI Expo native bridge extracts the recognized string before
 * crossing into JS. Generic expo-intent-launcher serializes all OEM extras,
 * including android.app.ActivityOptions classes on Vivo/Android 16, and can
 * throw fatally on the main thread even if JS wraps it in try/catch.
 */
export type AndroidVoiceActivityResult =
  | { status: "recognized"; transcript: string }
  | { status: "canceled" }
  | { status: "empty" };

type NativeVoiceActivity = {
  launchAsync(): Promise<unknown>;
};

export function parseAndroidVoiceActivityResult(result: unknown): AndroidVoiceActivityResult {
  if (!result || typeof result !== "object") throw new Error("invalid_android_voice_activity_result");
  const row = result as Record<string, unknown>;
  if (row.status === "canceled") return { status: "canceled" };
  if (row.status === "empty") return { status: "empty" };
  if (row.status === "recognized" && typeof row.transcript === "string" &&
    row.transcript.trim().length > 0) {
    return { status: "recognized", transcript: row.transcript.trim().slice(0, 16000) };
  }
  throw new Error("invalid_android_voice_activity_result");
}

/** Explicit tap -> Android system speech dialog -> one native String result. */
export async function launchAndroidVoiceActivity(): Promise<AndroidVoiceActivityResult> {
  const bridge = requireOptionalNativeModule<NativeVoiceActivity>("PersaiVoiceActivity");
  if (!bridge) throw new Error("persai_voice_activity_module_unavailable");
  return parseAndroidVoiceActivityResult(await bridge.launchAsync());
}
