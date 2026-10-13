import * as SecureStore from "expo-secure-store";
import { loadDirectConnections, loadDirectSettings, newDirectConnection, saveDirectConnections } from "../settings";
jest.mock("expo-secure-store", () => ({ getItemAsync: jest.fn(), setItemAsync: jest.fn(), deleteItemAsync: jest.fn(), WHEN_UNLOCKED_THIS_DEVICE_ONLY: "device" }));
jest.mock("expo-crypto", () => ({ randomUUID: jest.fn(() => "generation-" + Math.random().toString(36).slice(2)) }));
const vault = new Map<string, string>();
beforeEach(() => {
  vault.clear(); jest.clearAllMocks();
  (SecureStore.getItemAsync as jest.Mock).mockImplementation(async k => vault.get(k) || null);
  (SecureStore.setItemAsync as jest.Mock).mockImplementation(async (k, v) => { vault.set(k, v); });
  (SecureStore.deleteItemAsync as jest.Mock).mockImplementation(async k => { vault.delete(k); });
});
test("switching active connection and reloading preserves all credentials, endpoints and models", async () => {
  const a = { ...newDirectConnection("openai", "one"), name: "Cloud", apiKey: "key-a", model: "gpt-4.1" };
  const b = { ...newDirectConnection("anthropic", "two"), name: "Gateway", baseUrl: "https://my.example/v1", apiKey: "key-b", model: "vendor/claude", allowMemory: true };
  await saveDirectConnections("guest", { activeId: "one", connections: [a, b] });
  let saved = await loadDirectConnections("guest");
  expect(saved.connections).toEqual(expect.arrayContaining([expect.objectContaining(a), expect.objectContaining(b)]));
  await saveDirectConnections("guest", { ...saved, activeId: "two" });
  expect(await loadDirectSettings("guest")).toMatchObject(b);
  saved = await loadDirectConnections("guest");
  expect(saved.connections.find(c => c.id === "one")).toMatchObject(a);
  expect((await loadDirectSettings("other-profile")).apiKey).toBe("");
});
test("an interrupted save leaves the whole previous configuration active", async () => {
  const initial = { ...newDirectConnection("openai", "one"), apiKey: "old-key" };
  await saveDirectConnections("guest", { activeId: "one", connections: [initial] });
  (SecureStore.setItemAsync as jest.Mock).mockImplementationOnce(async () => { throw new Error("storage-failure"); });
  await expect(saveDirectConnections("guest", { activeId: "one", connections: [{ ...initial, apiKey: "new-key" }] })).rejects.toThrow("storage-failure");
  expect((await loadDirectSettings("guest")).apiKey).toBe("old-key");
});
test("all profiles validate before any write; removal does not disturb the remaining profile", async () => {
  const a = newDirectConnection("openai", "one"); const b = newDirectConnection("anthropic", "two");
  await expect(saveDirectConnections("guest", { activeId: "one", connections: [a, { ...b, baseUrl: "https://bad.example?key=token" }] })).rejects.toThrow();
  expect(SecureStore.setItemAsync).not.toHaveBeenCalled();
  await saveDirectConnections("guest", { activeId: "two", connections: [a, b] });
  await saveDirectConnections("guest", { activeId: "one", connections: [a] });
  expect((await loadDirectConnections("guest")).connections).toHaveLength(1);
  expect((await loadDirectSettings("guest")).provider).toBe("openai");
});
