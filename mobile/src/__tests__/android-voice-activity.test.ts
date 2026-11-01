import * as IntentLauncher from "expo-intent-launcher";
import { launchAndroidVoiceActivity, parseAndroidVoiceActivityResult } from "../media/android-voice-activity";

jest.mock("expo-intent-launcher", () => ({
  startActivityAsync: jest.fn(),
}));

beforeEach(() => { jest.clearAllMocks(); });

test("Android RecognizerIntent returns the first non-empty recognized phrase", () => {
  expect(parseAndroidVoiceActivityResult({
    resultCode: -1,
    extra: { "android.speech.extra.RESULTS": ["  ", "  купить продукты  ", "купить"] },
  })).toEqual({ status: "recognized", transcript: "купить продукты" });
});

test("canceled Activity is not treated as no speech and never reads returned extras", () => {
  expect(parseAndroidVoiceActivityResult({
    resultCode: 0,
    extra: { "android.speech.extra.RESULTS": ["не должен сохраниться"] },
  })).toEqual({ status: "canceled" });
});

test("missing or malformed result cannot inject text into the user's draft", () => {
  for (const extra of [undefined, {}, { "android.speech.extra.RESULTS": "text" },
    { "android.speech.extra.RESULTS": [42, null, " "] }]) {
    expect(parseAndroidVoiceActivityResult({ resultCode: -1, extra })).toEqual({ status: "empty" });
  }
});

test("Google system dictation opens Android implicit recognition Activity with Russian and online mode", async () => {
  (IntentLauncher.startActivityAsync as jest.Mock).mockResolvedValue({
    resultCode: -1, extra: { "android.speech.extra.RESULTS": ["Привет"] },
  });
  expect(await launchAndroidVoiceActivity()).toEqual({ status: "recognized", transcript: "Привет" });
  expect(IntentLauncher.startActivityAsync).toHaveBeenCalledWith("android.speech.action.RECOGNIZE_SPEECH", {
    extra: {
      "android.speech.extra.LANGUAGE_MODEL": "free_form",
      "android.speech.extra.LANGUAGE": "ru-RU",
      "android.speech.extra.PREFER_OFFLINE": false,
      "android.speech.extra.MAX_RESULTS": 1,
    },
  });
});
