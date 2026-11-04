import React from "react";
import { Alert, Platform } from "react-native";
import { fireEvent, render, waitFor } from "@testing-library/react-native";
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
// React Native Modal is native-owned; render the app sheet inline for button assertions.
jest.mock("../components/BottomSheet", () => ({ BottomSheet: ({ visible, children }: any) => visible ? children : null }));
jest.mock("../media/whisper", () => ({
  useWhisperStatus: () => ({ state: "ready", id: "base" }),
  downloadWhisper: jest.fn(), deleteWhisper: jest.fn(), cancelWhisperDownload: jest.fn(),
}));
beforeEach(() => {
  Object.defineProperty(Platform, "OS", { value: "android", configurable: true });
  jest.clearAllMocks(); mockConsent.allowed = false;
});

test("Google online permission is requested once in Nebula settings, not silently granted", async () => {
  const alert = jest.spyOn(Alert, "alert").mockImplementation(() => {});
  const v = render(<VoiceModelCard defaultOpen />);
  await waitFor(() => expect(v.getByText(/Для первого запуска нажмите/)).toBeTruthy());
  fireEvent.press(v.getByLabelText("Google — системное окно"));
  await waitFor(() => expect(v.getByLabelText("Разрешить онлайн-распознавание")).toBeTruthy());
  expect(v.getByText(/Речь может передаваться Google через интернет/)).toBeTruthy();
  expect(alert).not.toHaveBeenCalled();
  expect(grantOnlineSpeechConsent).not.toHaveBeenCalled();
  expect(setVoiceEngine).not.toHaveBeenCalled();
  fireEvent.press(v.getByLabelText("Разрешить онлайн-распознавание"));
  await waitFor(() => expect(grantOnlineSpeechConsent).toHaveBeenCalledTimes(1));
  await waitFor(() => expect(setVoiceEngine).toHaveBeenCalledWith("system"));
  await waitFor(() => expect(v.queryByText(/Для первого запуска нажмите/)).toBeNull());
  expect(v.queryByLabelText("Разрешить онлайн-распознавание")).toBeNull();
  expect(alert).not.toHaveBeenCalled();
  v.unmount();
  alert.mockRestore();
});

test("canceling first Google online approval does not grant consent or switch engines", async () => {
  const alert = jest.spyOn(Alert, "alert").mockImplementation(() => {});
  const v = render(<VoiceModelCard defaultOpen />);
  fireEvent.press(v.getByLabelText("Google — системное окно"));
  await waitFor(() => expect(v.getByLabelText("Разрешить онлайн-распознавание")).toBeTruthy());
  fireEvent.press(v.getByLabelText("Отмена"));
  expect(v.queryByLabelText("Разрешить онлайн-распознавание")).toBeNull();
  expect(grantOnlineSpeechConsent).not.toHaveBeenCalled();
  expect(setVoiceEngine).not.toHaveBeenCalled();
  expect(alert).not.toHaveBeenCalled();
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

test("on iOS the settings name the system recognizer without claiming it is Google Android", () => {
  Object.defineProperty(Platform, "OS", { value: "ios", configurable: true });
  const v = render(<VoiceModelCard defaultOpen />);
  expect(v.getByLabelText("Системное распознавание")).toBeTruthy();
  expect(v.queryByLabelText("Google — системное окно")).toBeNull();
  v.unmount();
});
