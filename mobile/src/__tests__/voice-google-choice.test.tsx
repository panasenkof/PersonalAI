import React from "react";
import { Alert } from "react-native";
import { act, fireEvent, render, waitFor } from "@testing-library/react-native";
import { VoiceModelCard } from "../components/VoiceModelCard";
import { grantOnlineSpeechConsent, setVoiceEngine } from "../media/voice-engine";

const mockConsent = { allowed: false };
jest.mock("../media/voice-engine", () => ({
  resolveVoiceEngine: (preference: string) => preference === "whisper" ? "whisper" : "system",
  useVoiceEngine: () => ({ loaded: true, preference: "system", saving: false, error: "" }),
  hasOnlineSpeechConsent: jest.fn(async () => mockConsent.allowed),
  grantOnlineSpeechConsent: jest.fn(async () => { mockConsent.allowed = true; }),
  setVoiceEngine: jest.fn(async () => {}),
}));
jest.mock("../media/whisper", () => ({
  useWhisperStatus: () => ({ state: "ready", id: "base" }),
  downloadWhisper: jest.fn(), deleteWhisper: jest.fn(), cancelWhisperDownload: jest.fn(),
}));
beforeEach(() => { jest.clearAllMocks(); mockConsent.allowed = false; });

test("Google online permission is requested once in settings, not silently granted", async () => {
  const alert = jest.spyOn(Alert, "alert").mockImplementation(() => {});
  const v = render(<VoiceModelCard defaultOpen />);
  await waitFor(() => expect(v.getByText(/Для первого запуска нажмите/)).toBeTruthy());
  fireEvent.press(v.getByLabelText("Google — системное окно"));
  await waitFor(() => expect(alert).toHaveBeenCalledWith(
    "Распознавание Google", expect.stringContaining("передаваться Google"), expect.any(Array),
  ));
  expect(grantOnlineSpeechConsent).not.toHaveBeenCalled();
  expect(setVoiceEngine).not.toHaveBeenCalled();
  const buttons = alert.mock.calls[alert.mock.calls.length - 1][2] || [];
  await act(async () => { buttons.find(button => button.text === "Разрешить")?.onPress?.(); });
  await waitFor(() => expect(grantOnlineSpeechConsent).toHaveBeenCalledTimes(1));
  expect(setVoiceEngine).toHaveBeenCalledWith("system");
  expect(v.queryByText(/Для первого запуска нажмите/)).toBeNull();
  v.unmount();
  alert.mockRestore();
});

test("canceling first Google online approval does not grant consent or switch engines", async () => {
  const alert = jest.spyOn(Alert, "alert").mockImplementation(() => {});
  const v = render(<VoiceModelCard defaultOpen />);
  fireEvent.press(v.getByLabelText("Google — системное окно"));
  await waitFor(() => expect(alert).toHaveBeenCalled());
  const buttons = alert.mock.calls[alert.mock.calls.length - 1][2] || [];
  await act(async () => { buttons.find(button => button.text === "Отмена")?.onPress?.(); });
  expect(grantOnlineSpeechConsent).not.toHaveBeenCalled();
  expect(setVoiceEngine).not.toHaveBeenCalled();
  v.unmount(); alert.mockRestore();
});

test("stored Google approval switches the engine without another prompt", async () => {
  mockConsent.allowed = true;
  const alert = jest.spyOn(Alert, "alert").mockImplementation(() => {});
  const v = render(<VoiceModelCard defaultOpen />);
  fireEvent.press(v.getByLabelText("Google — системное окно"));
  await waitFor(() => expect(setVoiceEngine).toHaveBeenCalledWith("system"));
  expect(alert).not.toHaveBeenCalled();
  expect(grantOnlineSpeechConsent).not.toHaveBeenCalled();
  v.unmount(); alert.mockRestore();
});
