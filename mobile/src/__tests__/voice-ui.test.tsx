import React from "react";
import { AppState, Text } from "react-native";
import { act, fireEvent, render, waitFor } from "@testing-library/react-native";
import { ExpoSpeechRecognitionModule as Speech } from "expo-speech-recognition";
import { VoiceInput } from "../components/VoiceInput";
jest.mock("@react-navigation/native", () => ({ useFocusEffect: (cb: any) => require("react").useEffect(cb, [cb]) }));
jest.mock("../security/native-interaction", () => ({ withNativeInteraction: (fn: any) => fn() }));
jest.mock("@expo/vector-icons/Feather", () => () => null);
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
