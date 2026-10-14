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
