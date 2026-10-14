import type { DirectAgentOptions } from "./engine";
import { postStream, StreamHttpError, streamingAvailable } from "./stream";
import type { Protocol } from "./stream";

/** One model call. Streams when the caller shows live text (`onText`) and the
 * platform supports incremental XHR; otherwise a plain JSON request. Both paths
 * return the provider's non-streaming JSON shape. */
export async function requestModel(options: DirectAgentOptions, url: string, headers: Record<string, string>,
  payload: Record<string, unknown>, protocol: Protocol, httpError: (status: number) => Error): Promise<any> {
  const { onText, signal } = options;
  if (onText && (options.streamXhr || (!options.transport && streamingAvailable()))) {
    try { return await postStream(url, headers, payload, protocol, onText, signal, options.streamXhr); }
    catch (e) { if (e instanceof StreamHttpError) throw httpError(e.status); throw e; }
  }
  const response = await (options.transport || fetch)(url, { method: "POST", headers, body: JSON.stringify(payload), signal });
  // Never include third-party error response bodies: they may echo API keys.
  if (!response.ok) throw httpError(response.status);
  return response.json();
}
