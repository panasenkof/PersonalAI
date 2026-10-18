import type { DirectAgentOptions } from "./engine";
import { postModel, streamingAvailable } from "./stream";
import type { Protocol } from "./stream";
import { DEFAULT_TIMEOUTS, ModelRequestError, REASONING_TIMEOUTS, fetchWithTimeout, hostOf, httpError, providerDetail } from "./net";

/** One model call, never longer than its time limits.
 *
 * In the app every call goes through XMLHttpRequest: it streams when the caller
 * shows live text (`onText`), and it exposes the native network error, so a
 * failure says whether DNS, TLS, the connection or the provider was at fault.
 * Tests pass `transport` (fetch) instead. Both return the provider's
 * non-streaming JSON shape. */
export async function requestModel(options: DirectAgentOptions, url: string, headers: Record<string, string>,
  payload: Record<string, unknown>, protocol: Protocol, reasoning = false): Promise<any> {
  const { onText, signal } = options;
  const timeouts = options.timeouts || (reasoning ? REASONING_TIMEOUTS : DEFAULT_TIMEOUTS);
  const secrets = [options.settings.apiKey, options.settings.webSearchKey, ...Object.values(options.settings.searchKeys || {})].filter((v): v is string => Boolean(v));
  const started = Date.now();
  const host = hostOf(url);
  const streaming = Boolean(options.streamXhr || (!options.transport && streamingAvailable()));
  options.diagnostic?.("llm.request_started", { protocol, host, model: payload.model, reasoning,
    inputChars: JSON.stringify(payload).length, streaming, maxOutputTokens: payload.max_output_tokens || payload.max_tokens || null,
    connectTimeoutMs: timeouts.connectMs, idleTimeoutMs: timeouts.idleMs, totalTimeoutMs: timeouts.totalMs });
  try {
    if (streaming) {
      const send = (stream: boolean) => postModel(url, headers, payload, {
        protocol, stream, onText, onPhase: options.phase, signal, xhr: options.streamXhr, timeouts, secrets,
      });
      let result: any;
      try { result = await send(Boolean(onText)); }
      catch (e) {
        // Some compatible servers reject the stream parameter: one retry without it.
        if (onText && e instanceof ModelRequestError && e.status === 400 && /stream/i.test(e.message)) {
          options.diagnostic?.("llm.stream_fallback", { protocol, host, httpStatus: e.status });
          result = await send(false);
        } else throw e;
      }
      options.diagnostic?.("llm.request_completed", { protocol, host, elapsedMs: Date.now() - started, streaming: Boolean(onText) });
      return result;
    }
    options.phase?.("connecting");
    const response = await fetchWithTimeout(options.transport || fetch, url,
      { method: "POST", headers, body: JSON.stringify(payload), signal }, timeouts, secrets);
    if (!response.ok) {
      const body = typeof response.text === "function" ? await response.text().catch(() => "") : "";
      throw httpError(response.status, host, providerDetail(body, secrets));
    }
    const data = await response.json();
    options.diagnostic?.("llm.request_completed", { protocol, host, elapsedMs: Date.now() - started,
      streaming: false, httpStatus: response.status });
    return data;
  } catch (e) {
    options.diagnostic?.("llm.request_failed", { protocol, host, elapsedMs: Date.now() - started,
      httpStatus: e instanceof ModelRequestError ? e.status || null : null,
      errorType: e instanceof ModelRequestError ? e.kind : (e as Error)?.name || "Error",
      aborted: signal?.aborted || false }, { error: String((e as Error)?.message || e) });
    throw e;
  }
}
