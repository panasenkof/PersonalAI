import React from "react";
import { AppState } from "react-native";
import { act, fireEvent, render, waitFor } from "@testing-library/react-native";
import { ExpoSpeechRecognitionModule as Speech } from "expo-speech-recognition";
import * as SecureStore from "expo-secure-store";
import { VoiceInput } from "../components/VoiceInput";
import { VoiceModelCard } from "../components/VoiceModelCard";
import { setVoiceEngine } from "../media/voice-engine";
import { deleteWhisper, downloadWhisper, startWhisperDictation } from "../media/whisper";
jest.mock("@react-navigation/native", () => ({ useFocusEffect: (cb: any) => require("react").useEffect(cb, [cb]) }));
jest.mock("../security/native-interaction", () => ({ withNativeInteraction: (fn: any) => fn(), nativeInteractionActive: () => false }));
jest.mock("@expo/vector-icons/Feather", () => () => null);
jest.mock("expo-secure-store", () => ({ getItemAsync: jest.fn(async () => null), setItemAsync: jest.fn(async () => {}) }));
const mockStatus: { current: any } = { current: { state: "ready", id: "base" } };
const mockSession = { stop: jest.fn(async () => {}) };
const mockCallbacks: { text?: (t: string) => void; end?: () => void } = {};
const mockEvents: Record<string, (event: any) => void> = {};
jest.mock("../media/whisper", () => ({
  useWhisperStatus: () => mockStatus.current,
  startWhisperDictation: jest.fn(async (text: any, _error: any, end: any) => { mockCallbacks.text = text; mockCallbacks.end = end; return mockSession; }),
  downloadWhisper: jest.fn(), deleteWhisper: jest.fn(), cancelWhisperDownload: jest.fn(),
}));
jest.mock("expo-speech-recognition", () => ({
  useSpeechRecognitionEvent: (event: string, fn: any) => { mockEvents[event] = fn; },
  ExpoSpeechRecognitionModule: { isRecognitionAvailable: jest.fn(() => true), supportsOnDeviceRecognition: jest.fn(() => true), requestPermissionsAsync: jest.fn(async () => ({ granted: true })), start: jest.fn(), stop: jest.fn(), abort: jest.fn() },
}));
beforeEach(async () => {
  Object.defineProperty(AppState, "currentState", { value: "active", configurable: true });
  await setVoiceEngine("whisper"); jest.clearAllMocks(); mockStatus.current = { state: "ready", id: "base" };
});
function Inputs({ onChange = jest.fn(), error = jest.fn() }) {
  return <><VoiceModelCard /><VoiceInput value="План" onChange={onChange} onError={error} /></>;
}
test("the settings switch uses the system service even with Whisper downloaded, then switches back without downloading or deleting", async () => {
  const v = render(<Inputs />);
  fireEvent.press(v.getByLabelText("Системное распознавание"));
  await waitFor(() => expect(v.getByLabelText("Системное распознавание").props.accessibilityState.checked).toBe(true));
  expect(SecureStore.setItemAsync).toHaveBeenLastCalledWith("pia.voice.engine.v1", "system");
  // Whisper settings are hidden for the system engine; the model stays downloaded.
  expect(v.queryByText("Скачано: Whisper base.")).toBeNull();
  expect(v.queryByLabelText("Удалить модель распознавания")).toBeNull();
  fireEvent.press(v.getByRole("button", { name: "Голосовой ввод" }));
  await waitFor(() => expect(Speech.start).toHaveBeenCalledTimes(1));
  expect(startWhisperDictation).not.toHaveBeenCalled();
  act(() => mockEvents.end({}));
  fireEvent.press(v.getByLabelText("Whisper на телефоне"));
  await waitFor(() => expect(v.getByLabelText("Whisper на телефоне").props.accessibilityState.checked).toBe(true));
  expect(v.getByText("Скачано: Whisper base.")).toBeTruthy();
  fireEvent.press(v.getByRole("button", { name: "Голосовой ввод" }));
  await waitFor(() => expect(startWhisperDictation).toHaveBeenCalledTimes(1));
  expect(Speech.start).toHaveBeenCalledTimes(1);
  expect(downloadWhisper).not.toHaveBeenCalled(); expect(deleteWhisper).not.toHaveBeenCalled();
  act(() => mockCallbacks.end!());
});
test("switching during dictation cancels the old engine and ignores its late result", async () => {
  const changed = jest.fn(); const v = render(<Inputs onChange={changed} />);
  fireEvent.press(v.getByRole("button", { name: "Голосовой ввод" }));
  await waitFor(() => expect(startWhisperDictation).toHaveBeenCalled());
  fireEvent.press(v.getByLabelText("Системное распознавание"));
  await waitFor(() => expect(mockSession.stop).toHaveBeenCalledTimes(1));
  act(() => mockCallbacks.text!("Запоздалый текст"));
  expect(changed).not.toHaveBeenCalled();
  expect(v.getByRole("button", { name: "Голосовой ввод" })).toBeTruthy();
  expect(deleteWhisper).not.toHaveBeenCalled();
});
test("an explicitly selected missing Whisper asks for its model without silently starting the system service", async () => {
  mockStatus.current = { state: "absent" };
  const error = jest.fn(); const v = render(<Inputs error={error} />);
  fireEvent.press(v.getByRole("button", { name: "Голосовой ввод" }));
  expect(error).toHaveBeenCalledWith(expect.stringContaining("Скачайте модель"));
  expect(Speech.start).not.toHaveBeenCalled(); expect(startWhisperDictation).not.toHaveBeenCalled();
  expect(v.getByLabelText("Скачать модель распознавания")).toBeTruthy();
});
test("switching away while system permission is pending cancels the old startup", async () => {
  await setVoiceEngine("system");
  let grant!: (p: { granted: boolean }) => void;
  (Speech.requestPermissionsAsync as jest.Mock).mockReturnValueOnce(new Promise(resolve => { grant = resolve; }));
  const v = render(<Inputs />);
  fireEvent.press(v.getByRole("button", { name: "Голосовой ввод" }));
  await waitFor(() => expect(Speech.requestPermissionsAsync).toHaveBeenCalled());
  fireEvent.press(v.getByLabelText("Whisper на телефоне"));
  await waitFor(() => expect(v.getByLabelText("Whisper на телефоне").props.accessibilityState.checked).toBe(true));
  await act(async () => grant({ granted: true }));
  expect(Speech.start).not.toHaveBeenCalled();
});

test("unsupported Whisper explains how to choose the system engine", () => {
  mockStatus.current = { state: "unsupported" };
  const error = jest.fn(); const v = render(<Inputs error={error} />);
  fireEvent.press(v.getByRole("button", { name: "Голосовой ввод" }));
  expect(error).toHaveBeenCalledWith(expect.stringContaining("недоступен на этом телефоне"));
  expect(Speech.start).not.toHaveBeenCalled();
});

test("the new choice shows at once while it is being saved, without flicker back to the old engine", async () => {
  let finish!: () => void;
  (SecureStore.setItemAsync as jest.Mock).mockReturnValueOnce(new Promise<void>(resolve => { finish = resolve; }));
  const v = render(<Inputs />);
  fireEvent.press(v.getByLabelText("Системное распознавание"));
  await waitFor(() => expect(v.getByLabelText("Системное распознавание").props.accessibilityState.checked).toBe(true));
  expect(v.queryByText("Голос без интернета")).toBeNull();
  expect(v.queryByText("Сохраняю выбор…")).toBeNull();
  await act(async () => finish());
  expect(v.getByLabelText("Системное распознавание").props.accessibilityState.checked).toBe(true);
  expect(v.queryByText("Голос без интернета")).toBeNull();
});
