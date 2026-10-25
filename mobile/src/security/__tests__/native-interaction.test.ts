import { AppState } from "react-native";
import * as LocalAuthentication from "expo-local-authentication";
import { nativeInteractionActive, withNativeInteraction } from "../native-interaction";
import { applicationModalActive } from "../visibility";
import { APP_SESSION_TIMEOUT_MS } from "../session";
jest.mock("expo-local-authentication", () => ({ authenticateAsync: jest.fn() }));
let state = "active";
let listeners: Array<(state: any) => void> = [];
beforeEach(() => {
  jest.useFakeTimers(); jest.clearAllMocks(); state = "active"; listeners = [];
  Object.defineProperty(AppState, "currentState", { configurable: true, get: () => state });
  jest.spyOn(AppState, "addEventListener").mockImplementation((_event, listener) => { listeners.push(listener); return { remove: () => { listeners = listeners.filter(fn => fn !== listener); } }; });
});
afterEach(() => { jest.useRealTimers(); });
const change = (value: string) => { state = value; listeners.forEach(fn => fn(value)); };
test("returning from a short picker uses the existing app session and never authenticates separately", async () => {
  const result = await withNativeInteraction(async () => {
    expect(nativeInteractionActive()).toBe(true); change("background"); jest.advanceTimersByTime(30000); change("active"); return "file";
  });
  expect(result).toBe("file"); expect(LocalAuthentication.authenticateAsync).not.toHaveBeenCalled(); expect(nativeInteractionActive()).toBe(false);
});
test("an expired picker cannot resume processing before application unlock", async () => {
  await expect(withNativeInteraction(async () => {
    change("background"); jest.advanceTimersByTime(APP_SESSION_TIMEOUT_MS); change("active"); return "file";
  })).rejects.toThrow("Сеанс приложения истёк");
  expect(LocalAuthentication.authenticateAsync).not.toHaveBeenCalled(); expect(nativeInteractionActive()).toBe(false);
});

test("failed permission requests always release their focus exemption", async () => {
 await expect(withNativeInteraction(async () => {
   expect(applicationModalActive()).toBe(true);
   throw new Error("permission cancelled");
 }, { permissionPrompt: true })).rejects.toThrow("permission cancelled");
 expect(applicationModalActive()).toBe(false);
 expect(nativeInteractionActive()).toBe(false);
});
