import React from "react";
import { Alert, AppState, Platform, Text } from "react-native";
import { act, fireEvent, render, waitFor } from "@testing-library/react-native";
import { ExpoSpeechRecognitionModule as Speech } from "expo-speech-recognition";
import { VoiceInput } from "../components/VoiceInput";
import { hasOnlineSpeechConsent } from "../media/voice-engine";
import { launchAndroidVoiceActivity } from "../media/android-voice-activity";

const mockChoice: { current: "system" | "whisper" } = { current: "system" };
jest.mock("@react-navigation/native", () => ({ useFocusEffect: (cb: any) => require("react").useEffect(cb, [cb]) }));
jest.mock("../security/native-interaction", () => ({ withNativeInteraction: (fn: any) => fn(), nativeInteractionActive: () => false }));
jest.mock("@expo/vector-icons/Feather", () => () => null);
jest.mock("../media/voice-engine", () => ({
  useVoiceEngine: () => ({ loaded: true, preference: mockChoice.current, saving: false, error: "" }),
  resolveVoiceEngine: (preference: string) => preference === "whisper" ? "whisper" : "system",
  hasOnlineSpeechConsent: jest.fn(async () => true),
  grantOnlineSpeechConsent: jest.fn(async () => {}),
}));
jest.mock("../media/whisper", () => ({
  useWhisperStatus: () => ({ state: "absent" }),
  startWhisperDictation: jest.fn(),
}));
jest.mock("../media/android-voice-activity", () => ({
  launchAndroidVoiceActivity: jest.fn(),
}));
const mockEvents: Record<string, (v: any) => void> = {};
jest.mock("expo-speech-recognition", () => ({
  useSpeechRecognitionEvent: (name: string, fn: any) => { mockEvents[name] = fn; },
  ExpoSpeechRecognitionModule: {
    isRecognitionAvailable: jest.fn(), getSpeechRecognitionServices: jest.fn(),
    getDefaultRecognitionService: jest.fn(), getPermissionsAsync: jest.fn(),
    requestPermissionsAsync: jest.fn(), start: jest.fn(), stop: jest.fn(), abort: jest.fn(),
  },
}));
beforeEach(() => {
  jest.clearAllMocks();
  mockChoice.current = "system";
  Object.defineProperty(AppState, "currentState", { value: "active", configurable: true });
  Object.defineProperty(Platform, "OS", { value: "android", configurable: true });
  (hasOnlineSpeechConsent as jest.Mock).mockResolvedValue(true);
  (launchAndroidVoiceActivity as jest.Mock).mockResolvedValue({ status: "canceled" });
});
function Draft({ error }: { error: (s: string) => void }) {
  const [value, setValue] = React.useState("План");
  return <><Text>{value}</Text><VoiceInput value={value} onChange={setValue} onError={error} /></>;
}

test("Google microphone immediately opens Android recognition UI, no extra questions or direct SpeechRecognizer", async () => {
  const modal = jest.spyOn(Alert, "alert").mockImplementation(() => {});
  (launchAndroidVoiceActivity as jest.Mock).mockResolvedValue({ status: "recognized", transcript: "купить продукты" });
  const v = render(<Draft error={jest.fn()} />);
  fireEvent.press(v.getByLabelText("Голосовой ввод"));
  await waitFor(() => expect(v.getByText("План купить продукты")).toBeTruthy());
  expect(launchAndroidVoiceActivity).toHaveBeenCalledTimes(1);
  expect(Speech.start).not.toHaveBeenCalled();
  expect(Speech.requestPermissionsAsync).not.toHaveBeenCalled();
  expect(modal).not.toHaveBeenCalled();
  v.unmount();
  modal.mockRestore();
});

test("Google opens the system window on every press, without learning or asking again", async () => {
  const v = render(<Draft error={jest.fn()} />);
  fireEvent.press(v.getByLabelText("Голосовой ввод"));
  await waitFor(() => expect(launchAndroidVoiceActivity).toHaveBeenCalledTimes(1));
  fireEvent.press(v.getByLabelText("Голосовой ввод"));
  await waitFor(() => expect(launchAndroidVoiceActivity).toHaveBeenCalledTimes(2));
  expect(Speech.start).not.toHaveBeenCalled();
  v.unmount();
});

test("canceled system window preserves the draft and shows no error", async () => {
  const error = jest.fn(), v = render(<Draft error={error} />);
  fireEvent.press(v.getByLabelText("Голосовой ввод"));
  await waitFor(() => expect(launchAndroidVoiceActivity).toHaveBeenCalledTimes(1));
  expect(v.getByText("План")).toBeTruthy();
  expect(error).not.toHaveBeenCalled();
  v.unmount();
});

test("unapproved Google online speech does not open Activity or ask for consent over chat", async () => {
  const alert = jest.spyOn(Alert, "alert").mockImplementation(() => {});
  (hasOnlineSpeechConsent as jest.Mock).mockResolvedValue(false);
  const error = jest.fn(), v = render(<Draft error={error} />);
  fireEvent.press(v.getByLabelText("Голосовой ввод"));
  await waitFor(() => expect(error).toHaveBeenCalledWith(expect.stringContaining("Настройки → Голосовой ввод")));
  expect(launchAndroidVoiceActivity).not.toHaveBeenCalled();
  expect(alert).not.toHaveBeenCalled();
  v.unmount(); alert.mockRestore();
});

test("empty system result shows a short error without replacing text", async () => {
  (launchAndroidVoiceActivity as jest.Mock).mockResolvedValue({ status: "empty" });
  const error = jest.fn(), v = render(<Draft error={error} />);
  fireEvent.press(v.getByLabelText("Голосовой ввод"));
  await waitFor(() => expect(error).toHaveBeenCalledWith(expect.stringContaining("не вернула текст")));
  expect(v.getByText("План")).toBeTruthy();
  v.unmount();
});

test("missing Android recognition Activity reports an error and retains the draft", async () => {
  (launchAndroidVoiceActivity as jest.Mock).mockRejectedValue(new Error("ActivityNotFoundException"));
  const error = jest.fn(), v = render(<Draft error={error} />);
  fireEvent.press(v.getByLabelText("Голосовой ввод"));
  await waitFor(() => expect(error).toHaveBeenCalledWith(expect.stringContaining("Системная диктовка недоступна")));
  expect(v.getByText("План")).toBeTruthy();
  v.unmount();
});

test("late Google activity result is ignored when input unmounts", async () => {
  let complete!: (result: any) => void;
  (launchAndroidVoiceActivity as jest.Mock).mockReturnValue(new Promise(resolve => { complete = resolve; }));
  const changed = jest.fn(), v = render(<VoiceInput value="План" onChange={changed} onError={jest.fn()} />);
  fireEvent.press(v.getByLabelText("Голосовой ввод"));
  await waitFor(() => expect(launchAndroidVoiceActivity).toHaveBeenCalledTimes(1));
  v.unmount();
  await act(async () => { complete({ status: "recognized", transcript: "старый результат" }); });
  expect(changed).not.toHaveBeenCalled();
});

test("changing the engine while OS dictation is open discards its late result", async () => {
  let complete!: (result: any) => void;
  (launchAndroidVoiceActivity as jest.Mock).mockReturnValue(new Promise(resolve => { complete = resolve; }));
  const changed = jest.fn();
  const props = { value: "План", onChange: changed, onError: jest.fn() };
  const v = render(<VoiceInput {...props} />);
  fireEvent.press(v.getByLabelText("Голосовой ввод"));
  await waitFor(() => expect(launchAndroidVoiceActivity).toHaveBeenCalledTimes(1));
  mockChoice.current = "whisper";
  v.rerender(<VoiceInput {...props} />);
  await act(async () => { complete({ status: "recognized", transcript: "старый результат" }); });
  expect(changed).not.toHaveBeenCalled();
  v.unmount();
});

test("non-Android system recognition keeps its native SpeechRecognizer path without chat approval", async () => {
  Object.defineProperty(Platform, "OS", { value: "ios", configurable: true });
  (Speech.isRecognitionAvailable as jest.Mock).mockReturnValue(true);
  (Speech.getPermissionsAsync as jest.Mock).mockResolvedValue({ granted: true });
  const alert = jest.spyOn(Alert, "alert").mockImplementation(() => {});
  const v = render(<Draft error={jest.fn()} />);
  fireEvent.press(v.getByLabelText("Голосовой ввод"));
  await waitFor(() => expect(Speech.start).toHaveBeenCalledWith(expect.objectContaining({
    lang: "ru-RU", requiresOnDeviceRecognition: false,
  })));
  expect(launchAndroidVoiceActivity).not.toHaveBeenCalled();
  expect(alert).not.toHaveBeenCalled();
  act(() => mockEvents.end({}));
  v.unmount(); alert.mockRestore();
});

test("max-length guard does not launch system window or mutate an existing draft", () => {
  const error = jest.fn(), changed = jest.fn();
  const v = render(<VoiceInput value="полный" maxLength={6} onChange={changed} onError={error} />);
  fireEvent.press(v.getByLabelText("Голосовой ввод"));
  expect(error).toHaveBeenCalledWith(expect.stringContaining("Текст слишком длинный"));
  expect(launchAndroidVoiceActivity).not.toHaveBeenCalled();
  expect(changed).not.toHaveBeenCalled();
  v.unmount();
});
