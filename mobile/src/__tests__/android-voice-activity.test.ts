import { requireOptionalNativeModule } from "expo-modules-core";
import { launchAndroidVoiceActivity, parseAndroidVoiceActivityResult } from "../media/android-voice-activity";

jest.mock("expo-modules-core", () => ({
  requireOptionalNativeModule: jest.fn(),
}));
const mockModule = { launchAsync: jest.fn() };

beforeEach(() => {
  jest.clearAllMocks();
  (requireOptionalNativeModule as jest.Mock).mockReturnValue(mockModule);
});

test("typed Android RecognizerIntent returns only a recognized Russian phrase", () => {
  expect(parseAndroidVoiceActivityResult({
    status: "recognized", transcript: "  привет  ",
  })).toEqual({ status: "recognized", transcript: "привет" });
});

test("canceled system dialog cannot write to a draft", () => {
  expect(parseAndroidVoiceActivityResult({ status: "canceled", transcript: "ignore" }))
    .toEqual({ status: "canceled" });
});

test("empty recognition does not invent a transcript", () => {
  expect(parseAndroidVoiceActivityResult({ status: "empty", transcript: "" }))
    .toEqual({ status: "empty" });
});

test("malformed or OEM extras cannot inject data into a draft", () => {
  for (const data of [undefined, null, {}, { status: "recognized", transcript: 12 },
    { status: "recognized", transcript: "" }, { status: "other", transcript: "bad" }]) {
    expect(() => parseAndroidVoiceActivityResult(data)).toThrow("invalid_android_voice_activity_result");
  }
});

test("Google system dictation invokes PersAI's typed native result bridge, not generic expo-intent-launcher", async () => {
  mockModule.launchAsync.mockResolvedValue({ status: "recognized", transcript: "Привет" });
  expect(await launchAndroidVoiceActivity()).toEqual({ status: "recognized", transcript: "Привет" });
  expect(requireOptionalNativeModule).toHaveBeenCalledWith("PersaiVoiceActivity");
  expect(mockModule.launchAsync).toHaveBeenCalledTimes(1);
});

test("missing native bridge is a recoverable JS error instead of a silent ASR fallback", async () => {
  (requireOptionalNativeModule as jest.Mock).mockReturnValue(null);
  await expect(launchAndroidVoiceActivity()).rejects.toThrow("persai_voice_activity_module_unavailable");
});

test("native recognition rejection propagates as a recoverable error", async () => {
  mockModule.launchAsync.mockRejectedValue(new Error("E_VOICE_RESULT"));
  await expect(launchAndroidVoiceActivity()).rejects.toThrow("E_VOICE_RESULT");
});
