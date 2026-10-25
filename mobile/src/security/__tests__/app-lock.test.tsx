import React from "react";
import { AppState, Pressable, Text } from "react-native";
import { act, fireEvent, render, waitFor } from "@testing-library/react-native";
import * as LocalAuthentication from "expo-local-authentication";
import { withNativeInteraction } from "../native-interaction";
import { AppLock } from "../AppLock";
import { BottomSheet } from "../../components/BottomSheet";
import { authenticateExistingMemory, authorizeLocalMemorySession, closeLocalMemory, revokeLocalMemorySession } from "../../local-memory/storage";
jest.mock("expo-local-authentication", () => ({ getEnrolledLevelAsync: jest.fn(), authenticateAsync: jest.fn(),
  SecurityLevel: { NONE: 0, SECRET: 1, BIOMETRIC_WEAK: 2, BIOMETRIC_STRONG: 3 } }));
jest.mock("../active-profile", () => ({ savedMemoryProfile: async () => "guest" }));
jest.mock("../../local-memory/storage", () => ({ authenticateExistingMemory: jest.fn(), authorizeLocalMemorySession: jest.fn(), revokeLocalMemorySession: jest.fn(), closeLocalMemory: jest.fn() }));
jest.mock("../../components/FloatingBrand", () => ({ FloatingBrand: () => null }));
jest.mock("@expo/vector-icons/Feather", () => () => null);
jest.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 24, bottom: 48, left: 0, right: 0 }),
  SafeAreaProvider: ({ children }: any) => children,
}));
let state = "active";
const listeners = new Map<string, ((v: any) => void)[]>();
beforeEach(() => {
  jest.useFakeTimers(); jest.clearAllMocks(); state = "active"; listeners.clear();
  Object.defineProperty(AppState, "currentState", { get: () => state, configurable: true });
  jest.spyOn(AppState, "addEventListener").mockImplementation((event: any, cb: any) => {
    listeners.set(event, [...(listeners.get(event) || []), cb]); return { remove: jest.fn() };
  });
  (LocalAuthentication.getEnrolledLevelAsync as jest.Mock).mockResolvedValue(3);
  (LocalAuthentication.authenticateAsync as jest.Mock).mockResolvedValue({ success: true });
  (authenticateExistingMemory as jest.Mock).mockResolvedValue(false);
  (closeLocalMemory as jest.Mock).mockResolvedValue(undefined);
});
afterEach(() => { jest.useRealTimers(); });
const change = async (next: string) => act(async () => { state = next; listeners.get("change")?.forEach(cb => cb(next)); });
test("short switches hide the app without a new biometric challenge or unmount", async () => {
  const mounted = jest.fn(); const removed = jest.fn();
  function Child() { React.useEffect(() => { mounted(); return removed; }, []); return <Text>Моя память открыта</Text>; }
  const v = render(<AppLock><Child /></AppLock>);
  await waitFor(() => v.getByText("Моя память открыта"));
  expect(LocalAuthentication.authenticateAsync).toHaveBeenCalledTimes(1);
  expect(authorizeLocalMemorySession).toHaveBeenCalledTimes(1);
  await change("inactive"); expect(closeLocalMemory).not.toHaveBeenCalled();
  await change("active");
  for (let i = 0; i < 3; i++) {
    await change("background");
    expect(v.queryByText("Моя память открыта")).toBeNull();
    expect(v.queryByLabelText("Разблокировать приложение")).toBeNull();
    await act(async () => { jest.advanceTimersByTime(30000); });
    await change("active"); expect(v.getByText("Моя память открыта")).toBeTruthy();
  }
  expect(LocalAuthentication.authenticateAsync).toHaveBeenCalledTimes(1);
  expect(closeLocalMemory).not.toHaveBeenCalled(); expect(removed).not.toHaveBeenCalled(); expect(mounted).toHaveBeenCalledTimes(1);
});
test("five minutes in background expires the whole session but preserves the mounted job owner", async () => {
  const mounted = jest.fn();
  function Child() { React.useEffect(mounted, []); return <Text>Сохранённый диалог</Text>; }
  const v = render(<AppLock><Child /></AppLock>);
  await waitFor(() => v.getByText("Сохранённый диалог"));
  await change("background");
  await act(async () => { jest.advanceTimersByTime(5 * 60 * 1000); });
  expect(closeLocalMemory).toHaveBeenCalledTimes(1);
  expect(v.queryByText("Сохранённый диалог")).toBeNull();
  await change("active"); fireEvent.press(v.getByLabelText("Разблокировать приложение"));
  await waitFor(() => v.getByText("Сохранённый диалог"));
  expect(LocalAuthentication.authenticateAsync).toHaveBeenCalledTimes(2); expect(mounted).toHaveBeenCalledTimes(1);
});

test("legacy-key migration itself is the single unlock and never opens a second biometric sheet", async () => {
  (authenticateExistingMemory as jest.Mock).mockResolvedValue(true);
  const v = render(<AppLock><Text>Заметки сохранены</Text></AppLock>);
  await waitFor(() => v.getByText("Заметки сохранены"));
  expect(LocalAuthentication.authenticateAsync).not.toHaveBeenCalled(); expect(authorizeLocalMemorySession).toHaveBeenCalledTimes(1);
});
test("cancelled app authentication cannot expose any child or grant memory access", async () => {
  (LocalAuthentication.authenticateAsync as jest.Mock).mockResolvedValue({ success: false });
  const v = render(<AppLock><Text>Закрытые данные</Text></AppLock>);
  await waitFor(() => v.getByText(/Вход не подтверждён/));
  expect(v.queryByText("Закрытые данные")).toBeNull(); expect(authorizeLocalMemorySession).not.toHaveBeenCalled();
});

test.each(["Мои диалоги", "Новый раздел"])("Android focus loss from opening '%s' does not remove and reopen the app's own modal", async title => {
  function Screen() {
    const [open, setOpen] = React.useState(false);
    return <><Pressable accessibilityLabel="Открыть панель" onPress={() => setOpen(true)}><Text>Открыть</Text></Pressable>
      <BottomSheet visible={open} title={title} onClose={() => setOpen(false)}><Text>Содержимое панели</Text></BottomSheet></>;
  }
  const v = render(<AppLock><Screen /></AppLock>);
  await waitFor(() => v.getByLabelText("Открыть панель"));
  fireEvent.press(v.getByLabelText("Открыть панель"));
  expect(v.getByText("Содержимое панели")).toBeTruthy();
  // A Dialog takes focus from Android's Activity, without backgrounding it.
  await act(async () => { listeners.get("blur")?.forEach(cb => cb(undefined)); });
  expect(v.getByText("Содержимое панели")).toBeTruthy();
  expect(v.queryByText("PersAI · Защищено")).toBeNull();
  await change("background");
  expect(v.queryByText("Содержимое панели", { includeHiddenElements: true })).toBeNull();
  await change("active");
  expect(v.getByText("Содержимое панели")).toBeTruthy();
  fireEvent.press(v.getByLabelText("Закрыть панель " + title));
  // Without an internal Dialog, the notification shade must still cover data.
  await act(async () => { listeners.get("blur")?.forEach(cb => cb(undefined)); });
  expect(v.getByText("PersAI · Защищено")).toBeTruthy();
  await act(async () => { listeners.get("focus")?.forEach(cb => cb(undefined)); });
  expect(v.getByLabelText("Открыть панель")).toBeTruthy();
  expect(LocalAuthentication.authenticateAsync).toHaveBeenCalledTimes(1);
  expect(closeLocalMemory).not.toHaveBeenCalled();
});

test("a phone protected only by a PIN unlocks through the device passcode", async () => {
  (LocalAuthentication.getEnrolledLevelAsync as jest.Mock).mockResolvedValue(1);
  const v = render(<AppLock><Text>Память по PIN</Text></AppLock>);
  await waitFor(() => v.getByText("Память по PIN"));
  expect(LocalAuthentication.authenticateAsync).toHaveBeenCalledWith(expect.objectContaining({ disableDeviceFallback: false }));
  expect(authorizeLocalMemorySession).toHaveBeenCalledTimes(1);
});
test("a phone without any screen lock is told to enable one and stays locked", async () => {
  (LocalAuthentication.getEnrolledLevelAsync as jest.Mock).mockResolvedValue(0);
  const v = render(<AppLock><Text>Закрытая память</Text></AppLock>);
  await waitFor(() => v.getByText(/Включите блокировку экрана/));
  expect(v.queryByText("Закрытая память")).toBeNull();
  expect(LocalAuthentication.authenticateAsync).not.toHaveBeenCalled();
  expect(authorizeLocalMemorySession).not.toHaveBeenCalled();
});


test("microphone permission focus loss does not flash the cover, but background and later notification shade still hide data", async () => {
 const v = render(<AppLock><Text>Диктовка</Text></AppLock>);
 await waitFor(() => v.getByText("Диктовка"));
 await act(async () => {
   await withNativeInteraction(async () => {
     listeners.get("blur")?.forEach(cb => cb(undefined));
     return true;
   }, { permissionPrompt: true });
 });
 expect(v.queryByText("PersAI · Защищено")).toBeNull();
 let finish!: () => void; let pending!: Promise<void>;
 await act(async () => { pending = withNativeInteraction(() => new Promise<void>(resolve => { finish = resolve; }), { permissionPrompt: true }); });
 await act(async () => { listeners.get("blur")?.forEach(cb => cb(undefined)); });
 expect(v.queryByText("PersAI · Защищено")).toBeNull();
 await change("background"); expect(v.getByText("PersAI · Защищено")).toBeTruthy();
 await change("active"); expect(v.getByText("Диктовка")).toBeTruthy();
 await act(async () => { finish(); await pending; });
 await act(async () => { listeners.get("blur")?.forEach(cb => cb(undefined)); });
 expect(v.getByText("PersAI · Защищено")).toBeTruthy();
 expect(LocalAuthentication.authenticateAsync).toHaveBeenCalledTimes(1);
});
