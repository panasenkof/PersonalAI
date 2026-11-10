import React from "react";
import {fireEvent, render, waitFor} from "@testing-library/react-native";
import {TelegramSettingsScreen} from "../../screens/TelegramSettingsScreen";
import {
  inspectTelegramApiCredentials, loadTelegramSyncMode, saveTelegramSyncMode, saveTelegramApiCredentials,
} from "../settings";
jest.mock("@expo/vector-icons/Feather", () => () => null);
jest.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({top:24,bottom:24,left:0,right:0}),
}));
jest.mock("../../profile/ProfileContext", () => ({useProfile: () => "guest"}));
jest.mock("../settings", () => ({
  loadTelegramSyncMode: jest.fn(), inspectTelegramApiCredentials: jest.fn(),
  saveTelegramSyncMode: jest.fn(), saveTelegramApiCredentials: jest.fn(),
  clearTelegramApiCredentials: jest.fn(),
}));
beforeEach(() => {
  jest.clearAllMocks();
  (loadTelegramSyncMode as jest.Mock).mockResolvedValue("manual");
  (inspectTelegramApiCredentials as jest.Mock).mockResolvedValue({apiId:null,configured:false});
  (saveTelegramSyncMode as jest.Mock).mockResolvedValue(undefined);
  (saveTelegramApiCredentials as jest.Mock).mockResolvedValue(undefined);
});
test("mode is separately selectable and does not claim live Telegram access", async () => {
  const ui=render(<TelegramSettingsScreen/>);
  await waitFor(() => ui.getByLabelText("При каждом запуске PersAI"));
  fireEvent.press(ui.getByLabelText("При каждом запуске PersAI"));
  await waitFor(() => expect(saveTelegramSyncMode).toHaveBeenCalledWith("guest","on_open"));
  expect(ui.getByText(/Нативная библиотека и авторизация/)).toBeTruthy();
  expect(ui.getByText(/Бот будет подключён отдельным PR/)).toBeTruthy();
});
test("apiHash stays masked and is saved only on explicit confirmation", async () => {
  const ui=render(<TelegramSettingsScreen/>);
  await waitFor(() => ui.getByLabelText("Telegram API ID"));
  fireEvent.changeText(ui.getByLabelText("Telegram API ID"),"12345");
  fireEvent.changeText(ui.getByLabelText("Telegram API hash"),"f".repeat(32));
  expect(ui.getByLabelText("Telegram API hash").props.secureTextEntry).toBe(true);
  expect(saveTelegramApiCredentials).not.toHaveBeenCalled();
  fireEvent.press(ui.getByText("Сохранить API-параметры"));
  await waitFor(() => expect(saveTelegramApiCredentials).toHaveBeenCalledWith("guest","12345","f".repeat(32)));
  expect(ui.getByLabelText("Telegram API hash").props.value).toBe("");
});
