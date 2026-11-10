import * as Crypto from "expo-crypto";
import * as SecureStore from "expo-secure-store";
import {
  clearTelegramApiCredentials, inspectTelegramApiCredentials, loadTelegramApiCredentials,
  loadTelegramSyncMode, saveTelegramApiCredentials, saveTelegramSyncMode,
  validateTelegramApiCredentials, validateTelegramSyncMode,
  loadOrCreateTdlibDbKey,tdlibKeyIsValid,hasExistingTdlibDbKey,
} from "../settings";
jest.mock("expo-crypto", () => ({getRandomBytes:jest.fn(() => new Uint8Array(32).fill(42))}));
jest.mock("expo-secure-store", () => ({
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: "device-only",
  getItemAsync: jest.fn(), setItemAsync: jest.fn(), deleteItemAsync: jest.fn(),
}));
const mockStore = new Map<string, string>();
beforeEach(() => {
  jest.clearAllMocks(); mockStore.clear();
  (SecureStore.getItemAsync as jest.Mock).mockImplementation(async (key: string) => mockStore.get(key) ?? null);
  (SecureStore.setItemAsync as jest.Mock).mockImplementation(async (key: string, value: string) => { mockStore.set(key,value); });
  (SecureStore.deleteItemAsync as jest.Mock).mockImplementation(async (key: string) => { mockStore.delete(key); });
});
test("manual by default, fail closed on invalid persisted value; device-only scope", async () => {
  expect(await loadTelegramSyncMode("guest")).toBe("manual");
  mockStore.set("pia.telegram.sync.v1.guest","unexpected");
  expect(await loadTelegramSyncMode("guest")).toBe("manual");
  expect(() => validateTelegramSyncMode("once")).toThrow("invalid_telegram_sync_mode");
  await saveTelegramSyncMode("guest","on_open");
  expect(await loadTelegramSyncMode("guest")).toBe("on_open");
  expect(SecureStore.setItemAsync).toHaveBeenCalledWith("pia.telegram.sync.v1.guest","on_open",
    {keychainAccessible:"device-only"});
});
test("credentials are not exposed in summary or mixed between local profiles", async () => {
  const hash = "ABCDEF0123456789ABCDEF0123456789";
  await saveTelegramApiCredentials("guest","12345",hash);
  expect(await inspectTelegramApiCredentials("guest")).toEqual({apiId:12345,configured:true});
  expect(await inspectTelegramApiCredentials("another")).toEqual({apiId:null,configured:false});
  expect(await loadTelegramApiCredentials("guest")).toEqual({apiId:12345,apiHash:hash.toLowerCase()});
  expect(JSON.stringify(await inspectTelegramApiCredentials("guest"))).not.toContain(hash);
  expect(SecureStore.setItemAsync).toHaveBeenCalledWith("pia.telegram.tdlib.api.v1.guest",
    expect.stringContaining('"apiId":12345'),{keychainAccessible:"device-only"});
  await clearTelegramApiCredentials("guest");
  expect(await loadTelegramApiCredentials("guest")).toBeNull();
});
test("invalid ID/hash/profile and damaged secrets fail closed", async () => {
  expect(() => validateTelegramApiCredentials("0","a".repeat(32))).toThrow();
  expect(() => validateTelegramApiCredentials("2147483648","a".repeat(32))).toThrow();
  expect(() => validateTelegramApiCredentials("123","bad")).toThrow();
  await expect(saveTelegramSyncMode("../x","manual")).rejects.toThrow("invalid_local_profile");
  await expect(saveTelegramApiCredentials("../x","123","a".repeat(32))).rejects.toThrow("invalid_local_profile");
  mockStore.set("pia.telegram.tdlib.api.v1.guest",'{"apiId":123,"apiHash":"bad"}');
  expect(await inspectTelegramApiCredentials("guest")).toEqual({apiId:null,configured:false});
  expect(await loadTelegramApiCredentials("guest")).toBeNull();
});


test("TDLib database has a different 256-bit device-only key from API credentials",async()=>{
  expect(await loadOrCreateTdlibDbKey("guest")).toBe("KioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKio=");
  expect(Crypto.getRandomBytes).toHaveBeenCalledWith(32);
  expect(tdlibKeyIsValid("KioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKio=")).toBe(true);
  expect(SecureStore.setItemAsync).toHaveBeenCalledWith(
    "pia.telegram.tdlib.dbkey.v1.guest",expect.any(String),{keychainAccessible:"device-only"});
  await loadOrCreateTdlibDbKey("guest");
  expect(Crypto.getRandomBytes).toHaveBeenCalledTimes(1);
  expect(await loadOrCreateTdlibDbKey("another")).toBe("KioqKioqKioqKioqKioqKioqKioqKioqKioqKioqKio=");
  expect(Crypto.getRandomBytes).toHaveBeenCalledTimes(2);
});
test("corrupted TDLib encryption key fails closed rather than replacing the session key",async()=>{
  mockStore.set("pia.telegram.tdlib.dbkey.v1.guest","invalid");
  await expect(loadOrCreateTdlibDbKey("guest")).rejects.toThrow("tdlib_device_key_corrupted");
  expect(Crypto.getRandomBytes).not.toHaveBeenCalled();
});

test("on_open only resumes a TDLib account whose device key was previously created",async()=>{
  expect(await hasExistingTdlibDbKey("guest")).toBe(false);
  expect(Crypto.getRandomBytes).not.toHaveBeenCalled();
  await loadOrCreateTdlibDbKey("guest");
  expect(await hasExistingTdlibDbKey("guest")).toBe(true);
  expect(await hasExistingTdlibDbKey("other")).toBe(false);
  mockStore.set("pia.telegram.tdlib.dbkey.v1.guest","invalid");
  await expect(hasExistingTdlibDbKey("guest")).rejects.toThrow("tdlib_device_key_corrupted");
  await expect(hasExistingTdlibDbKey("../other")).rejects.toThrow("invalid_local_profile");
});
