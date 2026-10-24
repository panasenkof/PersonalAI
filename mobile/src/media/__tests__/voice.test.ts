import { NO_SERVICE_MESSAGE, pickRecognitionService, startTimeoutMessage, voiceErrorMessage } from "../voice";

test("the phone's default recognition service is used when there is one", () => {
  expect(pickRecognitionService(["com.google.android.googlequicksearchbox"], "com.samsung.android.bixby").pkg).toBeUndefined();
});
test("without a default service an installed Google service is chosen", () => {
  expect(pickRecognitionService(["com.xiaomi.mibrain.speech", "com.google.android.as"], "").pkg).toBe("com.google.android.as");
});
test("another app's own service is never chosen and the message says what to install", () => {
  const choice = pickRecognitionService(["com.anthropic.claude"], "");
  expect(choice.pkg).toBeUndefined();
  const text = startTimeoutMessage(choice);
  expect(text).toContain("найдены только: com.anthropic.claude");
  expect(text).toContain("Голосовой ввод");
  expect(voiceErrorMessage("client", "", choice)).toContain("нет службы Google");
});
test.each(["not-allowed", "network", "language-not-supported", "service-not-allowed", "busy", "client", "audio-capture", "unknown"])(
  "error %s names the service, a reason and the raw code", code => {
    const text = voiceErrorMessage(code, "native detail", { pkg: "com.google.android.googlequicksearchbox", installed: [], defaultPackage: "" });
    expect(text).toContain("Google (приложение «Google»)");
    expect(text).toContain("Код: «" + code + ": native detail»");
  });
test("missing Russian points to where to install it", () => {
  expect(voiceErrorMessage("language-not-supported")).toContain("русский язык не установлен");
});
test("a service that never starts and a phone without one are explained", () => {
  expect(startTimeoutMessage()).toContain("не начала запись за 6 с");
  expect(NO_SERVICE_MESSAGE).toContain("приложение Google");
});


test("dictation preserves long notes and existing paragraph whitespace", () => {
  const { appendDictation } = require("../voice");
  const original = "Длинная заметка\n" + "а".repeat(5000) + "\n";
  expect(appendDictation(original, "Новый абзац", 60000)).toBe(original + "Новый абзац");
  expect(appendDictation(original, "Новый абзац", 4000)).toBe(original);
  expect(appendDictation("Текст", "ещё", 60000)).toBe("Текст ещё");
});
