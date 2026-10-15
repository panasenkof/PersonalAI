import React from "react";
import { Text } from "react-native";
import { act, fireEvent, render, waitFor } from "@testing-library/react-native";
import { ExpoSpeechRecognitionModule as Speech } from "expo-speech-recognition";
import { VoiceInput } from "../components/VoiceInput";
import { startWhisperDictation } from "../media/whisper";
jest.mock("@react-navigation/native", () => ({ useFocusEffect: (cb: any) => require("react").useEffect(cb, [cb]) }));
jest.mock("../security/native-interaction", () => ({ withNativeInteraction: (fn: any) => fn(), nativeInteractionActive: () => false }));
jest.mock("@expo/vector-icons/Feather", () => () => null);
jest.mock("expo-speech-recognition", () => ({
  useSpeechRecognitionEvent: () => {},
  ExpoSpeechRecognitionModule: { isRecognitionAvailable: jest.fn(() => true), supportsOnDeviceRecognition: jest.fn(() => true), requestPermissionsAsync: jest.fn(), start: jest.fn(), stop: jest.fn(), abort: jest.fn() },
}));
const mockStatus: { current: any } = { current: { state: "ready", id: "base" } };
const mockSession = { stop: jest.fn(async () => {}) };
const mockCallbacks: { text?: (t: string) => void; end?: () => void } = {};
jest.mock("../media/whisper", () => ({
  useWhisperStatus: () => mockStatus.current,
  startWhisperDictation: jest.fn(async (onText: any, _onError: any, onEnd: any) => { mockCallbacks.text = onText; mockCallbacks.end = onEnd; return mockSession; }),
}));
beforeEach(() => { jest.clearAllMocks(); mockStatus.current = { state: "ready", id: "base" }; });
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
