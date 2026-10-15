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
  const b = { ...newDirectConnection("anthropic", "two"), name: "Gateway", baseUrl: "https://my.example/v1", apiKey: "key-b", model: "vendor/claude" };
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

describe("one key per search service", () => {
  const { parseSearchKeys, searchKeyOf, providerFor } = require("../settings");
  test("a key saved before per-service keys belongs to the service that was selected", async () => {
    // What a phone with DeepSeek + Tavily has stored today: metadata and a bare key.
    vault.set("pia.direct.connections.v3.guest", JSON.stringify({ generation: "g1", activeId: "ds", ids: ["ds", "default-anthropic"] }));
    vault.set("pia.direct.connections.v3.guest.g1.ds", JSON.stringify({ name: "DeepSeek", provider: "openai-compatible", baseUrl: "https://api.deepseek.com",
      model: "deepseek-v4-pro", allowWeb: true, searchProvider: "tavily", credentialIdentity: "openai-compatible|https://api.deepseek.com" }));
    vault.set("pia.direct.connections.v3.guest.g1.ds.api", "sk-deepseek");
    vault.set("pia.direct.connections.v3.guest.g1.ds.search", "tvly-dev-123");
    vault.set("pia.direct.connections.v3.guest.g1.default-anthropic", JSON.stringify({ name: "Anthropic", provider: "anthropic", baseUrl: "https://api.anthropic.com/v1", model: "claude-sonnet-4-5" }));
    const saved = await loadDirectConnections("guest");
    // The untouched placeholder the app created by itself is hidden.
    expect(saved.connections.map(c => c.id)).toEqual(["ds"]);
    expect(saved.connections[0]).toMatchObject({ name: "DeepSeek", model: "deepseek-v4-pro", apiKey: "sk-deepseek", allowWeb: true,
      searchProvider: "tavily", webSearchKey: "tvly-dev-123", searchKeys: { tavily: "tvly-dev-123" } });
    // Adding a Yandex key and switching keeps both keys.
    await saveDirectConnections("guest", { activeId: "ds", connections: [{ ...saved.connections[0], searchProvider: "yandex", searchFolderId: "b1gfolder",
      searchKeys: { tavily: "tvly-dev-123", yandex: "AQVN-ya" }, webSearchKey: "AQVN-ya" }] });
    const again = (await loadDirectConnections("guest")).connections[0];
    expect(again).toMatchObject({ searchProvider: "yandex", webSearchKey: "AQVN-ya", searchKeys: { tavily: "tvly-dev-123", yandex: "AQVN-ya" }, apiKey: "sk-deepseek" });
    // Keys never land in the plain metadata record.
    const metadata = [...vault.entries()].filter(([k]) => /\.ds$/.test(k)).map(([, v]) => v).join("");
    expect(metadata).not.toContain("tvly-dev-123"); expect(metadata).not.toContain("AQVN-ya"); expect(metadata).not.toContain("sk-deepseek");
  });
  test("a service never gets another service's key", () => {
    expect(searchKeyOf({ searchKeys: { tavily: "tvly" }, webSearchKey: "tvly" }, "yandex")).toBe("");
    expect(searchKeyOf({ searchKeys: { tavily: "tvly" }, webSearchKey: "" }, "builtin")).toBe("");
    expect(parseSearchKeys('{"tavily":"a","yandex":"b","evil":"c"}', "tavily")).toEqual({ tavily: "a", yandex: "b" });
    expect(parseSearchKeys("bare", "builtin")).toEqual({});
  });
  test("two API types: OpenAI-compatible at api.openai.com uses OpenAI's own protocol", () => {
    expect(providerFor("openai", "https://api.openai.com/v1")).toBe("openai");
    expect(providerFor("openai", "https://openrouter.ai/api/v1")).toBe("openai-compatible");
    expect(providerFor("openai", "https://ai.api.cloud.yandex.net/v1")).toBe("openai-compatible");
    expect(providerFor("anthropic", "https://api.anthropic.com/v1")).toBe("anthropic");
  });
  test("a new connection without address or model says what to fill in", async () => {
    const c = { ...newDirectConnection("openai-compatible", "n"), name: "Новое подключение", baseUrl: "", model: "" };
    await expect(saveDirectConnections("guest", { activeId: "n", connections: [c] })).rejects.toThrow("Укажите адрес API в подключении «Новое подключение»");
    await expect(saveDirectConnections("guest", { activeId: "n", connections: [{ ...c, baseUrl: "https://openrouter.ai/api/v1" }] })).rejects.toThrow("Укажите модель");
  });
});
