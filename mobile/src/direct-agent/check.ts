import { runDirectAgent } from "./engine";
import type { DirectAgentSettings } from "./settings";

export type ConnectionCheck = { ok: true; reply: string } | { ok: false; message: string };

/** One short, memory-free request through the same code path as a real chat
 * turn: verifies address, key, model name and tool support before saving. */
export async function checkConnection(settings: DirectAgentSettings, transport?: typeof fetch, signal?: AbortSignal): Promise<ConnectionCheck> {
  try {
    const result = await runDirectAgent({
      settings: { ...settings, allowWeb: false },
      prompt: "Проверка связи. Ответь одним словом: готово.",
      history: [], signal, transport,
      lookup: async () => [], propose: () => {},
    });
    return { ok: true, reply: result.text.replace(/\s+/g, " ").trim().slice(0, 80) };
  } catch (e) {
    const message = String((e as Error)?.message || e);
    return { ok: false, message: /network request failed|failed to fetch|load failed/i.test(message)
      ? "Сервис не отвечает. Проверьте адрес API и интернет; локальная модель должна быть в той же сети."
      : message };
  }
}
