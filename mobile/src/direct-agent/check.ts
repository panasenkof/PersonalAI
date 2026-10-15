import { runDirectAgent } from "./engine";
import { fetchWebContext } from "./web-search";
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
      // Streaming tells "cannot connect" apart from "slow model".
      onText: () => {},
      lookup: async () => [], propose: () => {},
    });
    return { ok: true, reply: result.text.replace(/\s+/g, " ").trim().slice(0, 80) };
  } catch (e) {
    // Errors already name the host and the exact cause.
    return { ok: false, message: String((e as Error)?.message || e) };
  }
}

export type SearchCheck = { ok: true; count: number; first?: string } | { ok: false; message: string };

/** One real search with the connection's search settings: shows the exact
 * reason (key not accepted, quota, region, timeout) before a chat needs it. */
export async function checkWebSearch(settings: DirectAgentSettings, transport: typeof fetch = fetch, signal?: AbortSignal): Promise<SearchCheck> {
  if (!settings.allowWeb) return { ok: false, message: "Интернет-поиск выключен: включите «Искать в интернете»." };
  if (settings.searchProvider === "builtin") return { ok: false, message: "Встроенный поиск OpenAI проверяется кнопкой «Проверить связь» и в чате." };
  try {
    const web = await fetchWebContext("курс доллара сегодня", settings, transport, signal);
    return web.sources.length ? { ok: true, count: web.sources.length, first: web.sources[0] } :
      { ok: false, message: "Поиск ответил, но не вернул ни одной ссылки. Повторите позже или выберите другой способ поиска." };
  } catch (e) {
    return { ok: false, message: String((e as Error)?.message || e) };
  }
}
