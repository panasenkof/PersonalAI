import React from "react";
import {render,fireEvent,waitFor} from "@testing-library/react-native";
import {TelegramAccountCard} from "../TelegramAccountCard";
import {
 tdlibAvailable,tdlibAccountState,observeTelegramAccountState,
 initializeTelegramAccount,completeTelegramAuthorization,logOutTelegramAccount,
} from "../account";
jest.mock("@expo/vector-icons/Feather",()=>()=>null);
jest.mock("../TelegramSavedImportCard",()=>({
 TelegramSavedImportCard:()=>require("react").createElement(
   require("react-native").Text,null,"Импорт Избранного: тест"),
}));
jest.mock("../account",()=>({
 tdlibAvailable:jest.fn(),tdlibAccountState:jest.fn(),
 observeTelegramAccountState:jest.fn(),initializeTelegramAccount:jest.fn(),
 completeTelegramAuthorization:jest.fn(),logOutTelegramAccount:jest.fn(),
}));
jest.mock("../../local-memory/storage",()=>({
 onLocalMemorySessionChange:jest.fn(()=>()=>{}),
}));
let onAuth:(value:string)=>void=()=>{};
beforeEach(()=>{
 jest.clearAllMocks();
 (tdlibAvailable as jest.Mock).mockReturnValue(false);
 (tdlibAccountState as jest.Mock).mockReturnValue("offline");
 (observeTelegramAccountState as jest.Mock).mockImplementation(cb=>{onAuth=cb;return ()=>{};});
 (initializeTelegramAccount as jest.Mock).mockResolvedValue("starting");
 (completeTelegramAuthorization as jest.Mock).mockResolvedValue("authorizationStateReady");
 (logOutTelegramAccount as jest.Mock).mockResolvedValue("authorizationStateLoggingOut");
});
test("default APK without verified JNI never claims account connected",()=>{
 const ui=render(<TelegramAccountCard profile="guest" apiConfigured />);
 expect(ui.getByText(/TDLib ещё не включена/)).toBeTruthy();
 expect(ui.queryByText("Подключить аккаунт Telegram")).toBeNull();
 expect(initializeTelegramAccount).not.toHaveBeenCalled();
});
test("real native state drives one-step login; secret code uses masked entry",async()=>{
 (tdlibAvailable as jest.Mock).mockReturnValue(true);
 const ui=render(<TelegramAccountCard profile="guest" apiConfigured />);
 fireEvent.press(ui.getByText("Подключить аккаунт Telegram"));
 await waitFor(()=>expect(initializeTelegramAccount).toHaveBeenCalledWith("guest"));
 onAuth("authorizationStateWaitCode");
 await waitFor(()=>ui.getByLabelText("Код подтверждения Telegram"));
 const input=ui.getByLabelText("Код подтверждения Telegram");
 expect(input.props.secureTextEntry).toBe(true);
 fireEvent.changeText(input,"123456");
 fireEvent.press(ui.getByText("Продолжить вход"));
 await waitFor(()=>expect(completeTelegramAuthorization).toHaveBeenCalledWith("code","123456"));
 await waitFor(()=>ui.getByText(/Telegram подтвердил авторизацию/));
 expect(ui.getByText("Импорт Избранного: тест")).toBeTruthy();
 fireEvent.press(ui.getByText("Выйти из аккаунта Telegram"));
 expect(logOutTelegramAccount).not.toHaveBeenCalled();
 fireEvent.press(ui.getByText("Подтвердить выход из Telegram"));
 await waitFor(()=>expect(logOutTelegramAccount).toHaveBeenCalledTimes(1));
});
test("connecting requires configured API credentials",()=>{
 (tdlibAvailable as jest.Mock).mockReturnValue(true);
 const ui=render(<TelegramAccountCard profile="guest" apiConfigured={false}/>);
 expect(ui.getByText(/Сначала сохраните API ID/)).toBeTruthy();
 fireEvent.press(ui.getByText("Подключить аккаунт Telegram"));
 expect(initializeTelegramAccount).not.toHaveBeenCalled();
});

test("Telegram flood limit is explained and failed login is not silently retried",async()=>{
  (tdlibAvailable as jest.Mock).mockReturnValue(true);
  (initializeTelegramAccount as jest.Mock).mockRejectedValueOnce(
    new Error("Native error: tdlib_rate_limited"));
  const ui=render(<TelegramAccountCard profile="guest" apiConfigured />);
  fireEvent.press(ui.getByText("Подключить аккаунт Telegram"));
  await waitFor(()=>ui.getByText(/Telegram временно ограничил попытки входа/));
  expect(initializeTelegramAccount).toHaveBeenCalledTimes(1);
  expect(ui.getByText("Подключить аккаунт Telegram")).toBeTruthy();
});
test("invalid code gets specific feedback without showing the secret",async()=>{
  (tdlibAvailable as jest.Mock).mockReturnValue(true);
  (tdlibAccountState as jest.Mock).mockReturnValue("authorizationStateWaitCode");
  (completeTelegramAuthorization as jest.Mock).mockRejectedValueOnce(
    new Error("tdlib_auth_code_invalid 123456"));
  const ui=render(<TelegramAccountCard profile="guest" apiConfigured />);
  const input=ui.getByLabelText("Код подтверждения Telegram");
  fireEvent.changeText(input,"123456");
  fireEvent.press(ui.getByText("Продолжить вход"));
  await waitFor(()=>ui.getByText(/Код Telegram неверен/));
  expect(ui.queryByText(/tdlib_auth_code_invalid/)).toBeNull();
  expect(completeTelegramAuthorization).toHaveBeenCalledTimes(1);
});
