import React from "react";
import { AppState, Text } from "react-native";
import { act, fireEvent, render, waitFor } from "@testing-library/react-native";
import { ExpoSpeechRecognitionModule as Speech } from "expo-speech-recognition";
import { VoiceInput } from "../components/VoiceInput";
jest.mock("@react-navigation/native", () => ({ useFocusEffect: (cb: any) => require("react").useEffect(cb, [cb]) }));
jest.mock("../security/native-interaction", () => ({ withNativeInteraction: (fn: any) => fn(), nativeInteractionActive: () => false }));
jest.mock("@expo/vector-icons/Feather", () => () => null);
jest.mock("../media/whisper", () => ({ useWhisperStatus: () => ({ state: "absent" }) }));
const mockEvents: Record<string, (v: any) => void> = {};
jest.mock("expo-speech-recognition", () => ({
  useSpeechRecognitionEvent: (name: string, fn: any) => { mockEvents[name] = fn; },
  ExpoSpeechRecognitionModule: { isRecognitionAvailable: jest.fn(), supportsOnDeviceRecognition: jest.fn(), requestPermissionsAsync: jest.fn(), start: jest.fn(), stop: jest.fn(), abort: jest.fn() },
}));
beforeEach(() => {
  jest.clearAllMocks();
  Object.defineProperty(AppState, "currentState", { value: "active", configurable: true });
  (Speech.isRecognitionAvailable as jest.Mock).mockReturnValue(true);
  (Speech.supportsOnDeviceRecognition as jest.Mock).mockReturnValue(true);
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
test("missing permission never starts speech; offline-language failure offers an explicit service choice", async () => {
  const error = jest.fn(); (Speech.requestPermissionsAsync as jest.Mock).mockResolvedValueOnce({ granted: false });
  const v = render(<Draft error={error} />); fireEvent.press(v.getByLabelText("Голосовой ввод"));
  await waitFor(() => expect(error).toHaveBeenCalled()); expect(Speech.start).not.toHaveBeenCalled();
  fireEvent.press(v.getByLabelText("Голосовой ввод")); await waitFor(() => expect(Speech.start).toHaveBeenCalled());
  act(() => mockEvents.error({ error: "language-unavailable" }));
  expect(v.getByLabelText("Использовать системную диктовку")).toBeTruthy();
  expect(Speech.start).toHaveBeenCalledTimes(1);
});

test("native speech endpointing finishes without a tap and preserves the final phrase", async () => {
  const v = render(<Draft error={jest.fn()} />);
  fireEvent.press(v.getByLabelText("Голосовой ввод"));
  await waitFor(() => expect(Speech.start).toHaveBeenCalled());
  expect(Speech.start).toHaveBeenCalledWith(expect.objectContaining({ continuous: false }));
  act(() => mockEvents.start({}));
  act(() => mockEvents.result({ results: [{ transcript: "купить" }], isFinal: false }));
  act(() => mockEvents.speechend({}));
  expect(v.getByLabelText("Завершение диктовки")).toBeTruthy();
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
