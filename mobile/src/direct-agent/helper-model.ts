/** Short helper requests to the user's model (index words, question rewrite):
 * no tools, no memory, a JSON answer. On DeepSeek's own API they go to the
 * fast model with thinking off and JSON output on — same address and key.
 * Official parameters: api-docs.deepseek.com. */
import type { DirectAgentOptions } from "./engine";
import type { DirectAgentSettings } from "./settings";
import { validateBaseUrl, validateModel, yandexFolder } from "./settings";
import { REASONING_TIMEOUTS } from "./net";
import type { Timeouts } from "./net";
import { requestModel } from "./request";

/** DeepSeek's own API (api.deepseek.com): helper answers need no reasoning, so
 * they go to the fast model with thinking switched off and JSON output on —
 * same address and key as the chat. Official parameters, api-docs.deepseek.com. */
export const DEEPSEEK_FAST_MODEL = "deepseek-flash";
export function indexTermsModel(settings: Pick<DirectAgentSettings, "baseUrl" | "model" | "provider">): { model: string; deepseek: boolean } {
  let host = "";
  try { host = new URL(settings.baseUrl).host.toLowerCase(); } catch { /* invalid address is reported by validateBaseUrl */ }
  const deepseek = settings.provider !== "anthropic" && (host === "api.deepseek.com" || host.endsWith(".deepseek.com"));
  return { model: deepseek ? DEEPSEEK_FAST_MODEL : settings.model, deepseek };
}

/** Asks once (and once more with room if a thinking model ran out of tokens);
 * returns the answer text, or the last JSON object containing `jsonKey` from
 * the reasoning when the server put the answer only there. */
export async function askHelperModel(settings: DirectAgentSettings, instructions: string, content: string,
  options: { transport?: typeof fetch; signal?: AbortSignal; jsonKey: string; task: string; timeouts?: Timeouts; maxTokens?: number }): Promise<string> {
  const choice = indexTermsModel(settings);
  const model = validateModel(choice.model);
  const anthropic = settings.provider === "anthropic";
  const url = validateBaseUrl(settings.baseUrl, settings.provider) + (anthropic ? "/messages" : "/chat/completions");
  const headers: Record<string, string> = anthropic
    ? { "Content-Type": "application/json", "x-api-key": settings.apiKey, "anthropic-version": "2023-06-01" }
    : { "Content-Type": "application/json", ...(settings.apiKey ? { Authorization: "Bearer " + settings.apiKey } : {}),
        ...(yandexFolder(model) ? { "OpenAI-Project": yandexFolder(model)! } : {}) };
  // Thinking models (deepseek-v4-pro, o-series…) spend tokens on reasoning
  // before the answer, so the limit is generous; a cut-off answer is asked again with more room.
  const ask = async (maxTokens: number) => {
    const payload = anthropic
      ? { model, system: instructions, max_tokens: maxTokens, messages: [{ role: "user", content }] }
      : { model, max_tokens: maxTokens, messages: [{ role: "system", content: instructions }, { role: "user", content }],
          ...(choice.deepseek ? { thinking: { type: "disabled" }, response_format: { type: "json_object" } } : {}) };
    const request = { settings, transport: options.transport, signal: options.signal, prompt: "", history: [], lookup: async () => [], propose: () => {},
      timeouts: options.timeouts || REASONING_TIMEOUTS } as unknown as DirectAgentOptions;
    const data = await requestModel(request, url, headers, payload, anthropic ? "anthropic" : "chat", true) as any;
    return anthropic
      ? { text: Array.isArray(data?.content) ? data.content.filter((b: any) => b?.type === "text").map((b: any) => String(b.text)).join("\n") : "",
          reasoning: "", cut: data?.stop_reason === "max_tokens" }
      : { text: String(data?.choices?.[0]?.message?.content ?? ""), reasoning: String(data?.choices?.[0]?.message?.reasoning_content ?? ""),
          cut: data?.choices?.[0]?.finish_reason === "length" };
  };
  let answer = await ask(options.maxTokens ?? 1500);
  if (!answer.text.trim() && answer.cut) answer = await ask(6000);
  if (answer.text.trim()) return answer.text;
  const fromReasoning = answer.reasoning.match(new RegExp('\\{[^{}]*"' + options.jsonKey + '"[^{}]*\\}', "g"))?.pop();
  if (fromReasoning) return fromReasoning;
  throw new Error(answer.cut
    ? `Модель ${model} рассуждала дольше лимита и не успела ответить. Выберите для подключения модель без рассуждений или повторите позже.`
    : `Модель ${model} вернула пустой ответ вместо ${options.task}. Повторите позже или выберите другую модель.`);
}
