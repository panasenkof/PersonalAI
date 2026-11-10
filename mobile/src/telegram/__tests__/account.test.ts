import {Platform} from "react-native";
import {requireOptionalNativeModule} from "expo-modules-core";
import {
  tdlibAvailable,tdlibAccountState,initializeTelegramAccount,
  completeTelegramAuthorization,logOutTelegramAccount,
  safeTelegramAccountState,closeTelegramAccount,
} from "../account";
import {localMemorySessionUnlocked} from "../../local-memory/storage";
import {loadTelegramApiCredentials,loadOrCreateTdlibDbKey} from "../settings";
jest.mock("expo-modules-core",()=>({requireOptionalNativeModule:jest.fn()}));
jest.mock("../../local-memory/storage",()=>({localMemorySessionUnlocked:jest.fn()}));
jest.mock("../settings",()=>({
  loadTelegramApiCredentials:jest.fn(),loadOrCreateTdlibDbKey:jest.fn(),
}));
const native={
  isAvailable:jest.fn(),authorizationState:jest.fn(),initialize:jest.fn(),
  submitPhone:jest.fn(),submitCode:jest.fn(),submitPassword:jest.fn(),
  submitEmail:jest.fn(),submitEmailCode:jest.fn(),logOut:jest.fn(),close:jest.fn(),
};
beforeEach(()=>{
  jest.clearAllMocks();
  (Platform as any).OS="android";
  (requireOptionalNativeModule as jest.Mock).mockReturnValue(native);
  (localMemorySessionUnlocked as jest.Mock).mockReturnValue(true);
  (loadTelegramApiCredentials as jest.Mock).mockResolvedValue({apiId:12345,apiHash:"a".repeat(32)});
  (loadOrCreateTdlibDbKey as jest.Mock).mockResolvedValue("k".repeat(44));
  native.isAvailable.mockReturnValue(true);
  native.authorizationState.mockReturnValue("authorizationStateWaitPhoneNumber");
  native.initialize.mockResolvedValue("authorizationStateWaitPhoneNumber");
  native.submitPhone.mockResolvedValue("authorizationStateWaitCode");
  native.submitCode.mockResolvedValue("authorizationStateReady");
  native.submitPassword.mockResolvedValue("authorizationStateReady");
  native.submitEmail.mockResolvedValue("authorizationStateWaitEmailCode");
  native.submitEmailCode.mockResolvedValue("authorizationStateReady");
  native.logOut.mockResolvedValue("authorizationStateLoggingOut");
  native.close.mockResolvedValue("authorizationStateClosed");
});
test("the missing native binary never reads account API secrets or creates TDLib key",async()=>{
  native.isAvailable.mockReturnValue(false);
  expect(tdlibAvailable()).toBe(false);
  await expect(initializeTelegramAccount("guest")).rejects.toThrow("telegram_tdlib_binary_missing");
  expect(loadTelegramApiCredentials).not.toHaveBeenCalled();
  expect(loadOrCreateTdlibDbKey).not.toHaveBeenCalled();
  expect(native.initialize).not.toHaveBeenCalled();
});
test("AppLock prevents all authorization network and secret handling",async()=>{
  (localMemorySessionUnlocked as jest.Mock).mockReturnValue(false);
  await expect(initializeTelegramAccount("guest")).rejects.toThrow("telegram_app_locked");
  await expect(completeTelegramAuthorization("code","12345")).rejects.toThrow("telegram_app_locked");
  await expect(logOutTelegramAccount()).rejects.toThrow("telegram_app_locked");
  expect(native.initialize).not.toHaveBeenCalled();
  expect(native.submitCode).not.toHaveBeenCalled();
});
test("starts scoped session with per-profile API and device-bound database key",async()=>{
  expect(await initializeTelegramAccount("guest")).toBe("authorizationStateWaitPhoneNumber");
  expect(native.initialize).toHaveBeenCalledWith("guest",12345,"a".repeat(32),"k".repeat(44));
  expect(tdlibAccountState()).toBe("authorizationStateWaitPhoneNumber");
  expect(await completeTelegramAuthorization("phone","+79161234567")).toBe("authorizationStateWaitCode");
  expect(await completeTelegramAuthorization("code","12345")).toBe("authorizationStateReady");
  expect(native.submitCode).toHaveBeenCalledWith("12345");
  expect(await logOutTelegramAccount()).toBe("authorizationStateLoggingOut");
  expect(await closeTelegramAccount()).toBe("authorizationStateClosed");
});
test("arbitrary unknown upstream states are never reported as logged in",()=>{
  native.authorizationState.mockReturnValue("malicious_other_state");
  expect(tdlibAccountState()).toBe("unsupported_state");
  expect(safeTelegramAccountState(undefined)).toBe("unsupported_state");
  expect(safeTelegramAccountState("authorizationStateReady")).toBe("authorizationStateReady");
});
