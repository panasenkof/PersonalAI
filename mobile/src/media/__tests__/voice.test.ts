import { NO_SERVICE_MESSAGE, pickRecognitionService, startTimeoutMessage, voiceErrorMessage } from "../voice";

test("the phone's default recognition service is used when there is one", () => {
  expect(pickRecognitionService(["com.google.android.googlequicksearchbox"], "com.samsung.android.bixby")).toBeUndefined();
});
test("without a default service an installed Google service is chosen", () => {
  expect(pickRecognitionService(["com.xiaomi.mibrain.speech", "com.google.android.as"], "")).toBe("com.google.android.as");
  expect(pickRecognitionService(["com.xiaomi.mibrain.speech"], "")).toBe("com.xiaomi.mibrain.speech");
  expect(pickRecognitionService([], "")).toBeUndefined();
});
test.each(["not-allowed", "network", "language-not-supported", "service-not-allowed", "busy", "client", "audio-capture", "unknown"])(
  "error %s names the service, a reason and the raw code", code => {
    const text = voiceErrorMessage(code, "native detail", "com.google.android.googlequicksearchbox");
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
