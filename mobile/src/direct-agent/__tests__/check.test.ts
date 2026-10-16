import { checkConnection } from "../check";
import { PROVIDER_PRESETS, connectionFromPreset, saveDirectConnections } from "../settings";
import { yandexFolder } from "../compatible";

jest.mock("expo-secure-store", () => ({ getItemAsync: jest.fn(async () => null), setItemAsync: jest.fn(), deleteItemAsync: jest.fn(), WHEN_UNLOCKED_THIS_DEVICE_ONLY: "d" }));
jest.mock("expo-crypto", () => ({ randomUUID: () => "id-" + Math.random().toString(16).slice(2) }));

const chat = (content: string) => ({ ok: true, status: 200, json: async () => ({ choices: [{ message: { role: "assistant", content } }] }) });

test("a working connection answers through the chat code path without web search or memory", async () => {
  const transport = jest.fn().mockResolvedValue(chat("Готово"));
  const result = await checkConnection({ ...connectionFromPreset(PROVIDER_PRESETS.find(p => p.id === "deepseek")!), apiKey: "k", allowWeb: true }, transport as any);
  expect(result).toEqual({ ok: true, reply: "Готово" });
  expect(transport).toHaveBeenCalledTimes(1);
  expect(transport.mock.calls[0][0]).toBe("https://api.deepseek.com/chat/completions");
});

test("a rejected key is reported in plain words and the key is never echoed", async () => {
  const transport = jest.fn().mockResolvedValue({ ok: false, status: 401, json: async () => ({ error: "bad key sk-secret" }) });
  const result = await checkConnection({ ...connectionFromPreset(PROVIDER_PRESETS.find(p => p.id === "openrouter")!), apiKey: "sk-secret" }, transport as any);
  expect(result.ok).toBe(false);
  if (!result.ok) { expect(result.message).toContain("401"); expect(result.message).not.toContain("sk-secret"); }
});

test("an unreachable local model gets a network hint", async () => {
  const transport = jest.fn().mockRejectedValue(new TypeError("Network request failed"));
  const result = await checkConnection(connectionFromPreset(PROVIDER_PRESETS.find(p => p.id === "local")!), transport as any);
  expect(result).toEqual({ ok: false, message: expect.stringContaining("192.168.1.10:11434: сетевая ошибка") });
});

test("Yandex requests carry the folder from the model URI", async () => {
  expect(yandexFolder("gpt://b1gabc/yandexgpt/latest")).toBe("b1gabc");
  expect(yandexFolder("deepseek-flash")).toBeNull();
  const transport = jest.fn().mockResolvedValue(chat("готово"));
  await checkConnection({ ...connectionFromPreset(PROVIDER_PRESETS.find(p => p.id === "yandex")!), model: "gpt://b1gabc/yandexgpt/latest", apiKey: "y" }, transport as any);
  expect(transport.mock.calls[0][1].headers["OpenAI-Project"]).toBe("b1gabc");
});

test("a preset with an unfilled placeholder cannot be saved and says what to replace", async () => {
  const yandex = connectionFromPreset(PROVIDER_PRESETS.find(p => p.id === "yandex")!, "yandex");
  await expect(saveDirectConnections("guest", { activeId: "yandex", connections: [yandex] })).rejects.toThrow("угловых скобках");
});

describe("search check", () => {
  const tavily = { ...connectionFromPreset(PROVIDER_PRESETS.find(p => p.id === "deepseek")!), apiKey: "k", allowWeb: true, searchProvider: "tavily" as const, webSearchKey: "tvly-dev-secret123" };
  test("a working Tavily key reports how many links came back", async () => {
    const transport = jest.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ results: [{ title: "ЦБ", url: "https://cbr.ru/", content: "курс" }] }) });
    const { checkWebSearch } = require("../check");
    await expect(checkWebSearch(tavily, transport as any)).resolves.toMatchObject({ ok: true, count: 1, first: "https://cbr.ru/" });
    expect(transport.mock.calls[0][0]).toBe("https://api.tavily.com/search");
  });
  test("a rejected key is named precisely and the key never appears in the message", async () => {
    const transport = jest.fn().mockResolvedValue({ ok: false, status: 401, text: async () => JSON.stringify({ detail: { error: "Unauthorized: missing or invalid API key tvly-dev-secret123" } }) });
    const { checkWebSearch } = require("../check");
    const result = await checkWebSearch(tavily, transport as any);
    expect(result.ok).toBe(false);
    expect(result.message).toContain("api.tavily.com: ключ API не принят");
    expect(result.message).not.toContain("tvly-dev-secret123");
  });
  test("an exhausted Tavily plan says the monthly limit is spent", async () => {
    const transport = jest.fn().mockResolvedValue({ ok: false, status: 432, text: async () => "{}" });
    const { checkWebSearch } = require("../check");
    expect((await checkWebSearch(tavily, transport as any)).message).toContain("исчерпан лимит тарифа");
  });
  test("an unreachable host names the host and the cause", async () => {
    const transport = jest.fn().mockRejectedValue(new TypeError("Unable to resolve host \"api.tavily.com\""));
    const { checkWebSearch } = require("../check");
    expect((await checkWebSearch(tavily, transport as any)).message).toContain("api.tavily.com: адрес сервера не найден");
  });
  test("search switched off is reported without a request", async () => {
    const transport = jest.fn();
    const { checkWebSearch } = require("../check");
    expect((await checkWebSearch({ ...tavily, allowWeb: false }, transport as any)).message).toContain("выключен");
    expect(transport).toHaveBeenCalledTimes(0);
  });
});

describe("search errors read what the service said", () => {
  const tavily = { ...connectionFromPreset(PROVIDER_PRESETS.find(p => p.id === "deepseek")!), apiKey: "k", allowWeb: true, searchProvider: "tavily" as const, webSearchKey: "tvly-dev-secret123" };
  test("Tavily's detail.error text is shown", async () => {
    const transport = jest.fn().mockResolvedValue({ ok: false, status: 432, text: async () => JSON.stringify({ detail: { error: "This request exceeds your plan's set usage limit" } }) });
    const { checkWebSearch } = require("../check");
    expect((await checkWebSearch(tavily, transport as any)).message).toContain("Ответ сервиса: «This request exceeds your plan's set usage limit»");
  });
  test("a firewall page on 403 is told apart from a key problem and suggests a VPN check", async () => {
    const transport = jest.fn().mockResolvedValue({ ok: false, status: 403, text: async () => "<html><head><title>Attention Required! | Cloudflare</title></head><body>cf-ray</body></html>" });
    const { checkWebSearch } = require("../check");
    const message = (await checkWebSearch(tavily, transport as any)).message;
    expect(message).toContain("защита сервиса");
    expect(message).toContain("VPN");
    expect(message).toContain("Attention Required! | Cloudflare");
  });
  test("a bare 403 mentions both a blocked country and key rights", async () => {
    const transport = jest.fn().mockResolvedValue({ ok: false, status: 403, text: async () => "" });
    const { checkWebSearch } = require("../check");
    const message = (await checkWebSearch(tavily, transport as any)).message;
    expect(message).toContain("страну или сеть");
    expect(message).toContain("HTTP 403");
  });
});

describe("search providers after removing Bing and Brave", () => {
  const { migrateSearchProvider } = require("../settings");
  test("saved Bing or Brave becomes Tavily, and a Brave key is never reused", () => {
    expect(migrateSearchProvider("public")).toEqual({ provider: "tavily", dropKey: false });
    expect(migrateSearchProvider("brave")).toEqual({ provider: "tavily", dropKey: true });
    expect(migrateSearchProvider("yandex")).toEqual({ provider: "yandex", dropKey: false });
  });
  test("Yandex search needs a key and a folder ID before saving", async () => {
    const base = { ...connectionFromPreset(PROVIDER_PRESETS.find(p => p.id === "deepseek")!), apiKey: "k", allowWeb: true, searchProvider: "yandex" as const };
    await expect(saveDirectConnections("guest", { activeId: base.id, connections: [{ ...base, webSearchKey: "" }] })).rejects.toThrow("API-ключ Yandex Cloud");
    await expect(saveDirectConnections("guest", { activeId: base.id, connections: [{ ...base, webSearchKey: "AQVNkey", searchFolderId: "" }] })).rejects.toThrow("идентификатор каталога");
    await expect(saveDirectConnections("guest", { activeId: base.id, connections: [{ ...base, webSearchKey: "AQVNkey", searchFolderId: "b1g/../x" }] })).rejects.toThrow("латинские буквы и цифры");
  });
  test("a Yandex search check reports a rejected key with the host", async () => {
    const transport = jest.fn().mockResolvedValue({ ok: false, status: 401, text: async () => JSON.stringify({ code: 16, message: "Unknown api key 'AQVNkey'" }) });
    const { checkWebSearch } = require("../check");
    const message = (await checkWebSearch({ ...connectionFromPreset(PROVIDER_PRESETS.find(p => p.id === "deepseek")!), allowWeb: true, searchProvider: "yandex", webSearchKey: "AQVNkey", searchFolderId: "b1gfolder" }, transport as any)).message;
    expect(message).toContain("searchapi.api.cloud.yandex.net: ключ API не принят");
    expect(message).not.toContain("AQVNkey");
  });
});

describe("Tavily credits left", () => {
  const { fetchTavilyUsage, formatTavilyUsage } = require("../web-search");
  test("the account plan usage gives what is left this month, the key stays in the header", async () => {
    const transport = jest.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({
      key: { usage: 60, limit: null }, account: { current_plan: "Researcher", plan_usage: 60, plan_limit: 1000, paygo_usage: 0, paygo_limit: null } }) });
    const usage = await fetchTavilyUsage("tvly-dev-secret", transport as any);
    expect(transport.mock.calls[0][0]).toBe("https://api.tavily.com/usage");
    expect(transport.mock.calls[0][1].headers.Authorization).toBe("Bearer tvly-dev-secret");
    expect(formatTavilyUsage(usage)).toBe("Осталось 940 из 1000 запросов в этом месяце (план Researcher).");
  });
  test("an exhausted plan says when search returns", () => {
    expect(formatTavilyUsage({ used: 1000, limit: 1000 })).toContain("Бесплатные запросы закончились");
    expect(formatTavilyUsage({ used: 950, limit: 1000 })).toContain("скоро закончатся");
  });
  test("a blocked request names the reason", async () => {
    const transport = jest.fn().mockResolvedValue({ ok: false, status: 403, text: async () => "" });
    await expect(fetchTavilyUsage("tvly-x", transport as any)).rejects.toThrow("api.tavily.com");
  });
});
