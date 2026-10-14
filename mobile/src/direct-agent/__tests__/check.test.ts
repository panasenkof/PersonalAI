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
