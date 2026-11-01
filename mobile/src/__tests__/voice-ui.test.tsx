import React from "react";
import { Alert, AppState, Platform, Text } from "react-native";
import { act, fireEvent, render, waitFor } from "@testing-library/react-native";
import { ExpoSpeechRecognitionModule as Speech } from "expo-speech-recognition";
import { VoiceInput } from "../components/VoiceInput";
import { hasOnlineSpeechConsent, grantOnlineSpeechConsent } from "../media/voice-engine";
import { launchAndroidVoiceActivity, preferAndroidVoiceActivity, recordAndroidVoiceActivitySuccess } from "../media/android-voice-activity";
jest.mock("@react-navigation/native", () => ({ useFocusEffect: (cb: any) => require("react").useEffect(cb, [cb]) }));
jest.mock("../security/native-interaction", () => ({ withNativeInteraction: (fn: any) => fn(), nativeInteractionActive: () => false }));
jest.mock("@expo/vector-icons/Feather", () => () => null);
jest.mock("../media/voice-engine", () => ({
  useVoiceEngine: () => ({ loaded: true, preference: "auto", saving: false, error: "" }),
  resolveVoiceEngine: (preference: string, ready: boolean) => preference === "auto" ? (ready ? "whisper" : "system") : preference,
  hasOnlineSpeechConsent: jest.fn(async () => true),
  grantOnlineSpeechConsent: jest.fn(async () => {}),
}));
jest.mock("../media/whisper", () => ({ useWhisperStatus: () => ({ state: "absent" }) }));
jest.mock("../media/android-voice-activity", () => ({
  launchAndroidVoiceActivity: jest.fn(),
  preferAndroidVoiceActivity: jest.fn(() => false),
  recordAndroidVoiceActivitySuccess: jest.fn(),
}));
const mockEvents: Record<string, (v: any) => void> = {};
jest.mock("expo-speech-recognition", () => ({
  useSpeechRecognitionEvent: (name: string, fn: any) => { mockEvents[name] = fn; },
  ExpoSpeechRecognitionModule: { isRecognitionAvailable: jest.fn(), supportsOnDeviceRecognition: jest.fn(), getSpeechRecognitionServices: jest.fn(), getDefaultRecognitionService: jest.fn(), getPermissionsAsync: jest.fn(), requestPermissionsAsync: jest.fn(), start: jest.fn(), stop: jest.fn(), abort: jest.fn() },
}));
beforeEach(() => {
  jest.clearAllMocks();
  (Speech.getPermissionsAsync as jest.Mock).mockResolvedValue({ granted: false });
  Object.defineProperty(AppState, "currentState", { value: "active", configurable: true });
  // Jest Expo defaults to iOS; Android service discovery is Android-only.
  Object.defineProperty(Platform, "OS", { value: "android", configurable: true });
  (Speech.isRecognitionAvailable as jest.Mock).mockReturnValue(true);
  (Speech.supportsOnDeviceRecognition as jest.Mock).mockReturnValue(true);
  (Speech.getSpeechRecognitionServices as jest.Mock).mockReturnValue(["com.google.android.tts", "com.google.android.googlequicksearchbox"]);
  (Speech.getDefaultRecognitionService as jest.Mock).mockReturnValue({ packageName: "com.google.android.tts" });
  (Speech.requestPermissionsAsync as jest.Mock).mockResolvedValue({ granted: true });
});
function Draft({ error }: { error: (s: string) => void }) {
  const [value, setValue] = React.useState("План");
  return <><Text>{value}</Text><VoiceInput value={value} onChange={setValue} onError={error} /></>;
}
test("dictation updates a draft without duplicating interim/final text and aborts on unmount", async () => {
  const v = render(<Draft error={jest.fn()} />); fireEvent.press(v.getByLabelText("Голосовой ввод"));
  await waitFor(() => expect(Speech.start).toHaveBeenCalled());
  act(() => mockEvents.result({ results: [{ transcript: "купить молоко" }] }));
  act(() => mockEvents.result({ results: [{ transcript: "купить молоко и хлеб" }], isFinal: true }));
  expect(v.getByText("План купить молоко и хлеб")).toBeTruthy();
  v.unmount(); expect(Speech.abort).toHaveBeenCalledTimes(1);
});
test("missing permission blocks recording; Google starts online and retries a registered alternative only if Russian is rejected", async () => {
  const modal = jest.spyOn(Alert, "alert").mockImplementation(() => {});
  const error = jest.fn(); (Speech.requestPermissionsAsync as jest.Mock).mockResolvedValueOnce({ granted: false });
  const v = render(<Draft error={error} />); fireEvent.press(v.getByLabelText("Голосовой ввод"));
  await waitFor(() => expect(error).toHaveBeenCalled()); expect(Speech.start).not.toHaveBeenCalled();
  fireEvent.press(v.getByLabelText("Голосовой ввод")); await waitFor(() => expect(Speech.start).toHaveBeenCalledTimes(1));
  expect(Speech.start).toHaveBeenLastCalledWith(expect.objectContaining({ lang: "ru-RU", requiresOnDeviceRecognition: false }));
  expect(modal).not.toHaveBeenCalled();
  act(() => mockEvents.start({}));
  act(() => mockEvents.error({ error: "language-not-supported" }));
  expect(modal).toHaveBeenLastCalledWith("Другой сервис Google", expect.stringContaining("приложение «Google»"), expect.any(Array));
  const retryButtons = modal.mock.calls[modal.mock.calls.length - 1][2] || [];
  await act(async () => { retryButtons.find(button => button.text === "Попробовать")?.onPress?.(); });
  await waitFor(() => expect(Speech.start).toHaveBeenCalledTimes(2));
  expect(Speech.start).toHaveBeenLastCalledWith(expect.objectContaining({
    lang: "ru-RU", requiresOnDeviceRecognition: false,
    androidRecognitionServicePackage: "com.google.android.googlequicksearchbox",
  }));
  const dialogsBefore = modal.mock.calls.length;
  act(() => mockEvents.error({ error: "language-not-supported" }));
  expect(error).toHaveBeenLastCalledWith(expect.stringContaining("не принимает русский в сетевом режиме"));
  expect(modal.mock.calls.length).toBe(dialogsBefore);
  v.unmount(); modal.mockRestore();
});

test("Vivo no-speech offers Android system dictation even if an alternate Google service is listed", async () => {
  const modal = jest.spyOn(Alert, "alert").mockImplementation(() => {});
  const error = jest.fn(), v = render(<Draft error={error} />);
  (launchAndroidVoiceActivity as jest.Mock).mockResolvedValue({ status: "recognized", transcript: "купить молоко" });
  fireEvent.press(v.getByLabelText("Голосовой ввод"));
  await waitFor(() => expect(Speech.start).toHaveBeenCalledTimes(1));
  act(() => mockEvents.start({}));
  act(() => mockEvents.error({ error: "no-speech" }));
  expect(Speech.start).toHaveBeenCalledTimes(1);
  expect(modal).toHaveBeenCalledWith("Системная диктовка", expect.stringContaining("системное окно"), expect.any(Array));
  const buttons = modal.mock.calls[modal.mock.calls.length - 1][2] || [];
  expect(buttons.some(button => button.text === "Другая служба")).toBe(true);
  await act(async () => { buttons.find(button => button.text === "Открыть")?.onPress?.(); });
  await waitFor(() => expect(v.getByText("План купить молоко")).toBeTruthy());
  expect(recordAndroidVoiceActivitySuccess).toHaveBeenCalledTimes(1);
  expect(launchAndroidVoiceActivity).toHaveBeenCalledTimes(1);
  expect(Speech.start).toHaveBeenCalledTimes(1);
  v.unmount(); modal.mockRestore();
});

test("no alternate Google recognition service still offers system Android dictation; cancel preserves draft", async () => {
  const error = jest.fn(), modal = jest.spyOn(Alert, "alert").mockImplementation(() => {});
  (Speech.getSpeechRecognitionServices as jest.Mock).mockReturnValue(["com.google.android.tts"]);
  (launchAndroidVoiceActivity as jest.Mock).mockResolvedValue({ status: "canceled" });
  const v = render(<Draft error={error} />);
  fireEvent.press(v.getByLabelText("Голосовой ввод"));
  await waitFor(() => expect(Speech.start).toHaveBeenCalled());
  act(() => mockEvents.error({ error: "no-speech" }));
  expect(modal).toHaveBeenCalledWith("Системная диктовка", expect.any(String), expect.any(Array));
  const buttons = modal.mock.calls[modal.mock.calls.length - 1][2] || [];
  expect(buttons.some(button => button.text === "Другая служба")).toBe(false);
  await act(async () => { buttons.find(button => button.text === "Открыть")?.onPress?.(); });
  expect(v.getByText("План")).toBeTruthy();
  expect(recordAndroidVoiceActivitySuccess).not.toHaveBeenCalled();
  v.unmount(); modal.mockRestore();
});

test("after success the system activity is preferred for subsequent mic taps, with no Whisper or auto-send", async () => {
  (preferAndroidVoiceActivity as jest.Mock).mockReturnValue(true);
  (launchAndroidVoiceActivity as jest.Mock).mockResolvedValue({ status: "recognized", transcript: "встреча в шесть" });
  const v = render(<Draft error={jest.fn()} />);
  fireEvent.press(v.getByLabelText("Голосовой ввод"));
  await waitFor(() => expect(v.getByText("План встреча в шесть")).toBeTruthy());
  expect(Speech.start).not.toHaveBeenCalled();
  expect(recordAndroidVoiceActivitySuccess).toHaveBeenCalledTimes(1);
  v.unmount();
});

test("late system activity result never modifies an unmounted draft", async () => {
  (preferAndroidVoiceActivity as jest.Mock).mockReturnValue(true);
  let complete!: (v: any) => void;
  (launchAndroidVoiceActivity as jest.Mock).mockReturnValue(new Promise(resolve => { complete = resolve; }));
  const changed = jest.fn();
  const v = render(<VoiceInput value="исходный" onChange={changed} onError={jest.fn()} />);
  fireEvent.press(v.getByLabelText("Голосовой ввод"));
  await waitFor(() => expect(launchAndroidVoiceActivity).toHaveBeenCalledTimes(1));
  v.unmount();
  await act(async () => { complete({ status: "recognized", transcript: "потерянный текст" }); });
  expect(changed).not.toHaveBeenCalled();
  expect(recordAndroidVoiceActivitySuccess).not.toHaveBeenCalled();
});

test("failed system recognizer Activity reports an honest error and never clears a draft", async () => {
  (preferAndroidVoiceActivity as jest.Mock).mockReturnValue(true);
  (launchAndroidVoiceActivity as jest.Mock).mockRejectedValue(new Error("ActivityNotFoundException"));
  const error = jest.fn(), v = render(<Draft error={error} />);
  fireEvent.press(v.getByLabelText("Голосовой ввод"));
  await waitFor(() => expect(error).toHaveBeenCalledWith(expect.stringContaining("Системная диктовка недоступна")));
  expect(v.getByText("План")).toBeTruthy();
  expect(recordAndroidVoiceActivitySuccess).not.toHaveBeenCalled();
  v.unmount();
});

test("first Google online dictation asks once for consent and cannot start recording before approval", async () => {
  const modal = jest.spyOn(Alert, "alert").mockImplementation(() => {});
  (hasOnlineSpeechConsent as jest.Mock).mockResolvedValueOnce(false).mockResolvedValue(true);
  const v = render(<Draft error={jest.fn()} />);
  fireEvent.press(v.getByLabelText("Голосовой ввод"));
  await waitFor(() => expect(modal).toHaveBeenCalledWith("Голосовой ввод Google", expect.stringContaining("Голос может отправляться Google"), expect.any(Array)));
  expect(Speech.start).not.toHaveBeenCalled();
  const choices = modal.mock.calls[modal.mock.calls.length - 1][2] || [];
  await act(async () => { choices.find(button => button.text === "Разрешить")?.onPress?.(); });
  await waitFor(() => expect(Speech.start).toHaveBeenCalledTimes(1));
  expect(grantOnlineSpeechConsent).toHaveBeenCalledTimes(1);
  expect(Speech.start).toHaveBeenCalledWith(expect.objectContaining({ lang: "ru-RU", requiresOnDeviceRecognition: false }));
  v.unmount(); modal.mockRestore();
});

test("native speech endpointing finishes without a tap and preserves the final phrase", async () => {
  const v = render(<Draft error={jest.fn()} />);
  fireEvent.press(v.getByLabelText("Голосовой ввод"));
  await waitFor(() => expect(Speech.start).toHaveBeenCalled());
  expect(Speech.start).toHaveBeenCalledWith(expect.objectContaining({ continuous: false }));
  act(() => mockEvents.start({}));
  act(() => mockEvents.result({ results: [{ transcript: "купить" }], isFinal: false }));
  act(() => mockEvents.speechend({}));
  expect(v.getByLabelText("Прервать распознавание последней фразы")).toBeTruthy();
  expect(Speech.stop).not.toHaveBeenCalled();
  act(() => mockEvents.result({ results: [{ transcript: "купить молоко" }], isFinal: true }));
  act(() => mockEvents.end({}));
  expect(v.getByText("План купить молоко")).toBeTruthy();
  expect(v.getByLabelText("Голосовой ввод")).toBeTruthy();
});

test("clearing a draft while permission is pending never starts a discarded recording", async () => {
  let grant!: (value: any) => void;
  (Speech.requestPermissionsAsync as jest.Mock).mockReturnValueOnce(new Promise(resolve => { grant = resolve; }));
  const v = render(<Draft error={jest.fn()} />);
  fireEvent.press(v.getByLabelText("Голосовой ввод"));
  await waitFor(() => expect(Speech.requestPermissionsAsync).toHaveBeenCalled());
  v.unmount();
  await act(async () => grant({ granted: true }));
  expect(Speech.start).not.toHaveBeenCalled();
});

test("a stalled final result releases the input and reports why, retaining the partial draft", async () => {
  jest.useFakeTimers();
  const error = jest.fn(); const v = render(<Draft error={error} />);
  fireEvent.press(v.getByLabelText("Голосовой ввод"));
  await waitFor(() => expect(Speech.start).toHaveBeenCalled());
  act(() => mockEvents.start({}));
  act(() => mockEvents.result({ results: [{ transcript: "купить" }], isFinal: false }));
  act(() => mockEvents.speechend({}));
  act(() => jest.advanceTimersByTime(12_000));
  expect(error).toHaveBeenCalledWith(expect.stringContaining("последней фразы"));
  expect(v.getByText("План купить")).toBeTruthy();
  expect(v.getByLabelText("Голосовой ввод")).toBeTruthy();
  v.unmount(); jest.useRealTimers();
});

test("the button cancels while permission is pending and while the last phrase is decoded; recognized text stays", async () => {
  let grant!: (value: any) => void;
  (Speech.requestPermissionsAsync as jest.Mock).mockReturnValueOnce(new Promise(resolve => { grant = resolve; }));
  const v = render(<Draft error={jest.fn()} />);
  fireEvent.press(v.getByLabelText("Голосовой ввод"));
  await waitFor(() => expect(v.getByLabelText("Отменить подготовку диктовки")).toBeTruthy());
  fireEvent.press(v.getByLabelText("Отменить подготовку диктовки"));
  expect(v.getByLabelText("Голосовой ввод")).toBeTruthy();
  await act(async () => { grant({ granted: true }); });
  expect(Speech.start).not.toHaveBeenCalled();
  fireEvent.press(v.getByLabelText("Голосовой ввод"));
  await waitFor(() => expect(Speech.start).toHaveBeenCalled());
  act(() => mockEvents.start({}));
  act(() => mockEvents.result({ results: [{ transcript: "купить" }], isFinal: false }));
  act(() => mockEvents.speechend({}));
  fireEvent.press(v.getByLabelText("Прервать распознавание последней фразы"));
  expect(Speech.abort).toHaveBeenCalled();
  expect(v.getByText("План купить")).toBeTruthy();
  expect(v.getByLabelText("Голосовой ввод")).toBeTruthy();
});


test("granted microphone permission does not reopen a native permission window", async () => {
 (Speech.getPermissionsAsync as jest.Mock).mockResolvedValueOnce({ granted: true });
 const v = render(<Draft error={jest.fn()} />);
 fireEvent.press(v.getByLabelText("Голосовой ввод"));
 await waitFor(() => expect(Speech.start).toHaveBeenCalledTimes(1));
 expect(Speech.requestPermissionsAsync).not.toHaveBeenCalled();
 v.unmount();
});
