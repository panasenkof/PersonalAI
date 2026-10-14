import * as SecureStore from "expo-secure-store";
import {
  clearDirectApiKey, defaultDirectPreferences, loadDirectSettings,
  saveDirectApiKey, saveDirectPreferences, saveWebSearchKey, validateBaseUrl, validateModel,
} from "../settings";
import { resetSavedMemoryProfileForTests } from "../../security/active-profile";

jest.mock("expo-secure-store", () => ({
  getItemAsync: jest.fn(), setItemAsync: jest.fn(), deleteItemAsync: jest.fn(),
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: "this-device",
}));
const vault = new Map<string, string>();
beforeEach(() => {
  vault.clear();
  resetSavedMemoryProfileForTests();
  jest.clearAllMocks();
  (SecureStore.getItemAsync as jest.Mock).mockImplementation(async (key: string) => vault.get(key) ?? null);
  (SecureStore.setItemAsync as jest.Mock).mockImplementation(async (key: string, value: string) => {
    vault.set(key, value);
  });
  (SecureStore.deleteItemAsync as jest.Mock).mockImplementation(async (key: string) => {
    vault.delete(key);
  });
});
test("legacy OpenAI preferences and key remain usable after upgrade", async () => {
  vault.set("pia.direct.openai.key.v1", "legacy-secret");
  const settings = await loadDirectSettings("guest");
  expect(settings).toMatchObject({
    provider: "openai", baseUrl: "https://api.openai.com/v1",
    apiKey: "legacy-secret", allowWeb: false,
  });
});
test("keys are bound to profile, protocol and endpoint, never sent to another model server", async () => {
  const original = { ...defaultDirectPreferences };
  await saveDirectPreferences("guest", original);
  await saveDirectApiKey("guest", "secret-openai", original);
  expect((await loadDirectSettings("guest")).apiKey).toBe("secret-openai");
  expect((await loadDirectSettings("different_user")).apiKey).toBe("");
  const changed = { ...original, provider: "anthropic" as const, baseUrl: "https://api.anthropic.com/v1" };
  await saveDirectPreferences("guest", changed);
  expect((await loadDirectSettings("guest")).apiKey).toBe("");
  await saveDirectApiKey("guest", "secret-anthropic", changed);
  expect((await loadDirectSettings("guest")).apiKey).toBe("secret-anthropic");
  await saveDirectPreferences("guest", { ...changed, baseUrl: "https://gateway.example.com/v1" });
  expect((await loadDirectSettings("guest")).apiKey).toBe("");
  await clearDirectApiKey("guest");
  expect((await loadDirectSettings("guest")).apiKey).toBe("");
});
test("independent Brave web search key persists but web access remains off by default", async () => {
  await saveWebSearchKey("guest", "brave-key");
  const value = await loadDirectSettings("guest");
  expect(value.webSearchKey).toBe("brave-key");
  expect(value.allowWeb).toBe(false);
});
test.each([
  "http://untrusted.example/v1", "https://login:password@example.com/v1",
  "https://example.org/v1?q=x", "javascript:alert(1)", "https://example.org/v1#fragment",
])("rejects unsafe API endpoints: %s", url => {
  expect(() => validateBaseUrl(url, "openai-compatible")).toThrow();
});
test("permits private HTTP model servers without accepting remote HTTP", () => {
  expect(validateBaseUrl("http://192.168.1.12:11434/v1/", "openai-compatible"))
    .toBe("http://192.168.1.12:11434/v1");
  expect(validateModel("anthropic/claude-sonnet-4")).toBe("anthropic/claude-sonnet-4");
});


test("legacy key migrates to the current server owner without leaking to another profile", async () => {
  const owner = "a0b0c0d0-1111-2222-3333-444455556666";
  const subject = Buffer.from(JSON.stringify({ sub: owner })).toString("base64url");
  vault.set("pia.tokens", JSON.stringify({ access_token: "header." + subject + ".signature" }));
  vault.set("pia.direct.openai.key.v1", "old-owner-key");
  expect((await loadDirectSettings("guest")).apiKey).toBe("");
  expect((await loadDirectSettings(owner)).apiKey).toBe("old-owner-key");
  expect((await loadDirectSettings("other-user")).apiKey).toBe("");
  expect(vault.has("pia.direct.openai.key.v1")).toBe(false);
  // The former server account becomes the device profile; server tokens are gone.
  expect(vault.get("pia.profile.v1")).toBe(owner);
  expect(vault.has("pia.tokens")).toBe(false);
});

test("a fresh install and a former offline user both use the guest profile", async () => {
  const { savedMemoryProfile } = jest.requireActual("../../security/active-profile");
  expect(await savedMemoryProfile()).toBe("guest");
  resetSavedMemoryProfileForTests(); vault.clear();
  vault.set("pia.offlineMemoryMode", "yes");
  vault.set("pia.tokens", JSON.stringify({ access_token: "a.b.c" }));
  expect(await savedMemoryProfile()).toBe("guest");
  expect(vault.has("pia.offlineMemoryMode")).toBe(false);
});
