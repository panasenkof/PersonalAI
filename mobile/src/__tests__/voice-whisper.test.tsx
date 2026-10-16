import React from "react";
import { AppState, Text } from "react-native";
import { act, fireEvent, render, waitFor } from "@testing-library/react-native";
import { ExpoSpeechRecognitionModule as Speech } from "expo-speech-recognition";
import { VoiceInput } from "../components/VoiceInput";
import { startWhisperDictation } from "../media/whisper";
jest.mock("@react-navigation/native", () => ({ useFocusEffect: (cb: any) => require("react").useEffect(cb, [cb]) }));
jest.mock("../security/native-interaction", () => ({ withNativeInteraction: (fn: any) => fn(), nativeInteractionActive: () => false }));
jest.mock("@expo/vector-icons/Feather", () => () => null);
jest.mock("../media/voice-engine", () => ({
  useVoiceEngine: () => ({ loaded: true, preference: "auto", saving: false, error: "" }),
  resolveVoiceEngine: (preference: string, ready: boolean) => preference === "auto" ? (ready ? "whisper" : "system") : preference,
}));
jest.mock("expo-speech-recognition", () => ({
  useSpeechRecognitionEvent: () => {},
  ExpoSpeechRecognitionModule: { isRecognitionAvailable: jest.fn(() => true), supportsOnDeviceRecognition: jest.fn(() => true), requestPermissionsAsync: jest.fn(), start: jest.fn(), stop: jest.fn(), abort: jest.fn() },
}));
const mockStatus: { current: any } = { current: { state: "ready", id: "base" } };
const mockSession = { stop: jest.fn(async () => {}) };
const mockCallbacks: { text?: (t: string) => void; end?: () => void; finishing?: () => void } = {};
jest.mock("../media/whisper", () => ({
  useWhisperStatus: () => mockStatus.current,
  startWhisperDictation: jest.fn(async (onText: any, _onError: any, onEnd: any, options: any) => { mockCallbacks.finishing = options.onFinishing; mockCallbacks.text = onText; mockCallbacks.end = onEnd; return mockSession; }),
}));
beforeEach(() => { Object.defineProperty(AppState, "currentState", { value: "active", configurable: true }); jest.clearAllMocks(); mockStatus.current = { state: "ready", id: "base" }; });
function Draft({ error }: { error: (s: string) => void }) {
  const [value, setValue] = React.useState("План");
  return <><Text>{value}</Text><VoiceInput value={value} onChange={setValue} onError={error} /></>;
}
test("with the model downloaded, dictation goes through Whisper on the phone and never the system service", async () => {
  const v = render(<Draft error={jest.fn()} />);
  fireEvent.press(v.getByLabelText("Голосовой ввод"));
  await waitFor(() => expect(startWhisperDictation).toHaveBeenCalled());
  act(() => mockCallbacks.text!("купить молоко"));
  act(() => mockCallbacks.text!("купить молоко и хлеб"));
  expect(v.getByText("План купить молоко и хлеб")).toBeTruthy();
  expect(Speech.start).not.toHaveBeenCalled();
  fireEvent.press(v.getByLabelText("Остановить диктовку"));
  expect(mockSession.stop).toHaveBeenCalledTimes(1);
  act(() => mockCallbacks.end!());
  expect(v.getByLabelText("Голосовой ввод")).toBeTruthy();
});
test("without Google and without the model the error points to the on-device model", async () => {
  mockStatus.current = { state: "absent" };
  (Speech.isRecognitionAvailable as jest.Mock).mockReturnValueOnce(false);
  const error = jest.fn();
  const v = render(<Draft error={error} />);
  fireEvent.press(v.getByLabelText("Голосовой ввод"));
  await waitFor(() => expect(error).toHaveBeenCalled());
  expect(error.mock.calls[0][0]).toContain("Настройки → Голос без интернета");
  expect(startWhisperDictation).not.toHaveBeenCalled();
});

test("Whisper automatically finalizes after silence; clearing the input ignores late transcripts", async () => {
  const changed = jest.fn();
  const v = render(<VoiceInput value="План" onChange={changed} onError={jest.fn()} />);
  fireEvent.press(v.getByLabelText("Голосовой ввод"));
  await waitFor(() => expect(startWhisperDictation).toHaveBeenCalled());
  act(() => mockCallbacks.finishing!());
  expect(v.getByLabelText("Завершение диктовки")).toBeTruthy();
  act(() => mockCallbacks.text!("купить хлеб"));
  expect(changed).toHaveBeenLastCalledWith("План купить хлеб");
  v.unmount();
  act(() => mockCallbacks.text!("старый результат"));
  expect(changed).toHaveBeenCalledTimes(1);
  expect((startWhisperDictation as jest.Mock).mock.calls[0][3].signal.aborted).toBe(true);
});
