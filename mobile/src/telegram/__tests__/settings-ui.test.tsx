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
jest.mock("../TelegramAccountCard", () => ({TelegramAccountCard: () => require("react").createElement(require("react-native").Text,null,"TDLib: тест")}));
jest.mock("../TelegramBotCard", () => ({TelegramBotCard: () => require("react").createElement(require("react-native").Text,null,"Резервный бот: тест")}));
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
  expect(ui.getByText(/APK со встроенной TDLib/)).toBeTruthy();
  expect(ui.queryByText(/эта версия не читает Telegram/)).toBeNull();
  expect(ui.getByText(/резервный бот работает независимо/)).toBeTruthy();
  expect(ui.getByText("Резервный бот: тест")).toBeTruthy();
  expect(ui.getByText("TDLib: тест")).toBeTruthy();
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

test("saved API credentials do not falsely claim the account is disconnected",async()=>{
  (inspectTelegramApiCredentials as jest.Mock).mockResolvedValueOnce({
    apiId:12345,configured:true,
  });
  const ui=render(<TelegramSettingsScreen/>);
  await waitFor(()=>ui.getByText(/API-параметры сохранены локально/));
  expect(ui.getByText(/Статус подключения показан ниже/)).toBeTruthy();
  expect(ui.queryByText(/Аккаунт не авторизован/)).toBeNull();
});
