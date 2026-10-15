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
  if (options.streamXhr || (!options.transport && streamingAvailable())) {
    const send = (stream: boolean) => postModel(url, headers, payload, {
      protocol, stream, onText, onPhase: options.phase, signal, xhr: options.streamXhr, timeouts, secrets,
    });
    try { return await send(Boolean(onText)); }
    catch (e) {
      // Some compatible servers reject the `stream` parameter itself: ask again once without it.
      if (onText && e instanceof ModelRequestError && e.status === 400 && /stream/i.test(e.message)) return send(false);
      throw e;
    }
  }
  options.phase?.("connecting");
  const response = await fetchWithTimeout(options.transport || fetch, url, { method: "POST", headers, body: JSON.stringify(payload), signal },
    timeouts, secrets);
  if (!response.ok) {
    const body = typeof response.text === "function" ? await response.text().catch(() => "") : "";
    throw httpError(response.status, hostOf(url), providerDetail(body, secrets));
  }
  return response.json();
}
