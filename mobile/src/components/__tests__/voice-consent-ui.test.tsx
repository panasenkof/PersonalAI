import React from "react";
import { Platform } from "react-native";
import { fireEvent, render, waitFor } from "@testing-library/react-native";
import { VoiceModelCard } from "../VoiceModelCard";
import { useWhisperStatus, downloadWhisper, deleteWhisper } from "../../media/whisper";
import { hasOnlineSpeechConsent, grantOnlineSpeechConsent, setVoiceEngine } from "../../media/voice-engine";

jest.mock("@expo/vector-icons/Feather", () => () => null);
jest.mock("../Collapsible", () => ({ Collapsible: ({ children }: any) => children }));
jest.mock("../BottomSheet", () => ({ BottomSheet: ({ visible, children }: any) => visible ? children : null }));
jest.mock("../../theme", () => ({ useTheme: () => ({
  text: "#ffffff", muted: "#abbad8", panel: "#14213d", soft: "#26395c",
  line: "#445574", secondary: "#d1dfff", accent: "#7051db", ok: "#66f1af", err: "#ff9faf",
}) }));
jest.mock("../../media/whisper", () => ({
  useWhisperStatus: jest.fn(), downloadWhisper: jest.fn(), deleteWhisper: jest.fn(),
  cancelWhisperDownload: jest.fn(),
}));
jest.mock("../../media/voice-engine", () => ({
  useVoiceEngine: () => ({ loaded: true, preference: "whisper", saving: false, error: "" }),
  resolveVoiceEngine: (value: string) => value === "whisper" ? "whisper" : "system",
  hasOnlineSpeechConsent: jest.fn(), grantOnlineSpeechConsent: jest.fn(), setVoiceEngine: jest.fn(),
}));
beforeEach(() => {
  jest.clearAllMocks();
  Object.defineProperty(Platform, "OS", { value: "android", configurable: true });
  (useWhisperStatus as jest.Mock).mockReturnValue({ state: "absent" });
  (hasOnlineSpeechConsent as jest.Mock).mockResolvedValue(false);
  (grantOnlineSpeechConsent as jest.Mock).mockResolvedValue(undefined);
  (setVoiceEngine as jest.Mock).mockResolvedValue(undefined);
});

test("Google speech data transfer requires a separate explicit consent; cancel never enables it", async () => {
  const ui = render(<VoiceModelCard defaultOpen />);
  fireEvent.press(ui.getByLabelText("Google — системное окно"));
  await waitFor(() => ui.getByLabelText("Разрешить онлайн-распознавание"));
  expect(grantOnlineSpeechConsent).not.toHaveBeenCalled();
  expect(setVoiceEngine).not.toHaveBeenCalled();
  fireEvent.press(ui.getByLabelText("Отмена"));
  expect(grantOnlineSpeechConsent).not.toHaveBeenCalled();
  expect(setVoiceEngine).not.toHaveBeenCalled();
  fireEvent.press(ui.getByLabelText("Google — системное окно"));
  await waitFor(() => ui.getByLabelText("Разрешить онлайн-распознавание"));
  fireEvent.press(ui.getByLabelText("Разрешить онлайн-распознавание"));
  await waitFor(() => expect(grantOnlineSpeechConsent).toHaveBeenCalledTimes(1));
  await waitFor(() => expect(setVoiceEngine).toHaveBeenCalledWith("system"));
});

test("Whisper download and delete never begin before Nebula confirmation", async () => {
  const absent = render(<VoiceModelCard defaultOpen />);
  fireEvent.press(absent.getByLabelText("Скачать модель распознавания"));
  expect(downloadWhisper).not.toHaveBeenCalled();
  fireEvent.press(absent.getByLabelText("Отмена"));
  expect(downloadWhisper).not.toHaveBeenCalled();
  fireEvent.press(absent.getByLabelText("Скачать модель распознавания"));
  fireEvent.press(absent.getByLabelText("Скачать модель"));
  expect(downloadWhisper).toHaveBeenCalledTimes(1);
  expect(downloadWhisper).toHaveBeenCalledWith("base");
  absent.unmount();
  (useWhisperStatus as jest.Mock).mockReturnValue({ state: "ready", id: "base" });
  const installed = render(<VoiceModelCard defaultOpen />);
  fireEvent.press(installed.getByLabelText("Удалить модель распознавания"));
  expect(deleteWhisper).not.toHaveBeenCalled();
  fireEvent.press(installed.getByLabelText("Отмена"));
  expect(deleteWhisper).not.toHaveBeenCalled();
  fireEvent.press(installed.getByLabelText("Удалить модель распознавания"));
  fireEvent.press(installed.getByLabelText("Удалить модель"));
  expect(deleteWhisper).toHaveBeenCalledTimes(1);
});

test("failure to save Google consent is shown in context and never switches ASR", async () => {
  (grantOnlineSpeechConsent as jest.Mock).mockRejectedValueOnce(new Error("SecureStore unavailable"));
  const ui = render(<VoiceModelCard defaultOpen />);
  fireEvent.press(ui.getByLabelText("Google — системное окно"));
  await waitFor(() => ui.getByLabelText("Разрешить онлайн-распознавание"));
  fireEvent.press(ui.getByLabelText("Разрешить онлайн-распознавание"));
  await waitFor(() => ui.getByText("Не удалось сохранить разрешение. Попробуйте ещё раз."));
  expect(setVoiceEngine).not.toHaveBeenCalled();
});
