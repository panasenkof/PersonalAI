import React from "react";
import {act,render,fireEvent,waitFor} from "@testing-library/react-native";
import {TelegramAccountCard} from "../TelegramAccountCard";
import {
 tdlibAvailable,tdlibAccountState,observeTelegramAccountState,
 initializeTelegramAccount,completeTelegramAuthorization,logOutTelegramAccount,cancelTelegramAuthorization,
} from "../account";
jest.mock("@expo/vector-icons/Feather",()=>()=>null);
jest.mock("../TelegramSavedImportCard",()=>({
 TelegramSavedImportCard:()=>require("react").createElement(
   require("react-native").Text,null,"Импорт Избранного: тест"),
}));
jest.mock("../account",()=>({
 tdlibAvailable:jest.fn(),tdlibAccountState:jest.fn(),
 observeTelegramAccountState:jest.fn(),initializeTelegramAccount:jest.fn(),
 completeTelegramAuthorization:jest.fn(),logOutTelegramAccount:jest.fn(),cancelTelegramAuthorization:jest.fn(),
}));
jest.mock("../settings",()=>({wasTelegramAuthorized:jest.fn(async()=>false),markTelegramAuthorized:jest.fn(async()=>{})}));
jest.mock("../../local-memory/storage",()=>({
 onLocalMemorySessionChange:jest.fn(()=>()=>{}),
}));
let onAuth:(value:string)=>void=()=>{};
beforeEach(()=>{
 jest.clearAllMocks();
 (require("../settings").wasTelegramAuthorized as jest.Mock).mockResolvedValue(false);
 (tdlibAvailable as jest.Mock).mockReturnValue(false);
 (tdlibAccountState as jest.Mock).mockReturnValue("offline");
 (observeTelegramAccountState as jest.Mock).mockImplementation(cb=>{onAuth=cb;return ()=>{};});
 (initializeTelegramAccount as jest.Mock).mockResolvedValue("starting");
 (completeTelegramAuthorization as jest.Mock).mockResolvedValue("authorizationStateReady");
 (logOutTelegramAccount as jest.Mock).mockResolvedValue("authorizationStateLoggingOut");
 (cancelTelegramAuthorization as jest.Mock).mockResolvedValue("authorizationStateLoggingOut");
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

test("native rate limiting is explained without repeated Telegram requests",async()=>{
 (tdlibAvailable as jest.Mock).mockReturnValue(true);
 (tdlibAccountState as jest.Mock).mockReturnValue("authorizationStateWaitCode");
 (completeTelegramAuthorization as jest.Mock).mockRejectedValueOnce(new Error("tdlib_flood_wait_125"));
 const ui=render(<TelegramAccountCard profile="guest" apiConfigured/>);
 fireEvent.changeText(ui.getByLabelText("Код подтверждения Telegram"),"123456");
 fireEvent.press(ui.getByText("Продолжить вход"));
 await waitFor(()=>ui.getByText(/3 мин/));
 expect(completeTelegramAuthorization).toHaveBeenCalledTimes(1);
 expect(ui.queryByText(/Операция Telegram не выполнена/)).toBeNull();
});

test("authorization can be cancelled while waiting for code",async()=>{
 (tdlibAvailable as jest.Mock).mockReturnValue(true);
 (tdlibAccountState as jest.Mock).mockReturnValue("authorizationStateWaitCode");
 const ui=render(<TelegramAccountCard profile="guest" apiConfigured/>);
 fireEvent.press(ui.getByText("Отменить вход"));
 await waitFor(()=>expect(cancelTelegramAuthorization).toHaveBeenCalledWith("guest"));
});
test("previously authorized account offers session resume after AppLock",async()=>{
 const {wasTelegramAuthorized}=require("../settings");
 (wasTelegramAuthorized as jest.Mock).mockResolvedValue(true);
 (tdlibAvailable as jest.Mock).mockReturnValue(true);
 const ui=render(<TelegramAccountCard profile="guest" apiConfigured/>);
 await waitFor(()=>ui.getByText("Возобновить сессию"));
 expect(ui.getByText(/Сессия Telegram приостановлена/)).toBeTruthy();
});


test("2FA field stays writable through repeated native auth updates",()=>{
 (tdlibAvailable as jest.Mock).mockReturnValue(true);
 (tdlibAccountState as jest.Mock).mockReturnValue("authorizationStateWaitPassword");
 const ui=render(<TelegramAccountCard profile="guest" apiConfigured/>);
 const password=()=>ui.getByLabelText("Пароль двухэтапной защиты");
 expect(password().props.secureTextEntry).toBe(true);
 expect(password().props.editable).toBe(true);
 fireEvent.changeText(password(),"s");
 expect(password().props.value).toBe("s");
 act(()=>onAuth("authorizationStateWaitPassword"));
 expect(password().props.value).toBe("s");
 fireEvent.changeText(password(),"secret phrase");
 expect(password().props.value).toBe("secret phrase");
 expect(ui.getByText("Продолжить вход")).toBeTruthy();
});

test("switching from code to password clears only the previous step's draft",()=>{
 (tdlibAvailable as jest.Mock).mockReturnValue(true);
 (tdlibAccountState as jest.Mock).mockReturnValue("authorizationStateWaitCode");
 const ui=render(<TelegramAccountCard profile="guest" apiConfigured/>);
 fireEvent.changeText(ui.getByLabelText("Код подтверждения Telegram"),"123456");
 act(()=>onAuth("authorizationStateWaitPassword"));
 const password=ui.getByLabelText("Пароль двухэтапной защиты");
 expect(password.props.value).toBe("");
 expect(password.props.secureTextEntry).toBe(true);
 fireEvent.changeText(password,"p@ssword");
 act(()=>onAuth("authorizationStateWaitPassword"));
 expect(ui.getByLabelText("Пароль двухэтапной защиты").props.value).toBe("p@ssword");
});

test("timed-out phone submission does not silently erase the entered number",async()=>{
 (tdlibAvailable as jest.Mock).mockReturnValue(true);
 (tdlibAccountState as jest.Mock).mockReturnValue("authorizationStateWaitPhoneNumber");
 (completeTelegramAuthorization as jest.Mock).mockRejectedValueOnce(new Error("tdlib_request_timeout"));
 const ui=render(<TelegramAccountCard profile="guest" apiConfigured/>);
 fireEvent.changeText(ui.getByLabelText("Телефон с кодом страны"),"+79161234567");
 fireEvent.press(ui.getByText("Продолжить вход"));
 await waitFor(()=>ui.getByText(/25 секунд/));
 expect(ui.getByLabelText("Телефон с кодом страны").props.value).toBe("+79161234567");
});


test("successful same-step response does not erase an in-progress 2FA field",async()=>{
 (tdlibAvailable as jest.Mock).mockReturnValue(true);
 (tdlibAccountState as jest.Mock).mockReturnValue("authorizationStateWaitPassword");
 (completeTelegramAuthorization as jest.Mock).mockResolvedValueOnce("authorizationStateWaitPassword");
 const ui=render(<TelegramAccountCard profile="guest" apiConfigured/>);
 fireEvent.changeText(ui.getByLabelText("Пароль двухэтапной защиты"),"sample-password");
 fireEvent.press(ui.getByText("Продолжить вход"));
 await waitFor(()=>expect(completeTelegramAuthorization).toHaveBeenCalledWith("password","sample-password"));
 await waitFor(()=>expect(ui.getByLabelText("Пароль двухэтапной защиты").props.editable).toBe(true));
 expect(ui.getByLabelText("Пароль двухэтапной защиты").props.value).toBe("sample-password");
 act(()=>onAuth("authorizationStateReady"));
 await waitFor(()=>expect(ui.queryByText("Данные отправлены в Telegram.")).toBeNull());
});
