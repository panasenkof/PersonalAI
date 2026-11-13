/** Shared opt-in evaluation transport. Jest-Expo replaces global fetch with a
 * stub, so paid acceptance must use Node HTTPS explicitly. Never used by the
 * production app or by unattended CI. The caller validates its provider URL
 * and enforces its own paid-call / input / output budgets.
 */
import { request as httpsRequest } from "node:https";
import { Buffer } from "node:buffer";

export function realHttpsTransport(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const target = new URL(String(input));
  if (target.protocol !== "https:") throw Error("LIVE_EVAL_REQUIRES_HTTPS");
  const body = init?.body;
  if (typeof body !== "string") throw Error("LIVE_EVAL_INVALID_JSON_BODY");
  const method = init?.method || "POST", headers = init?.headers as Record<string, string>;
  const signal = init?.signal || undefined;
  return new Promise<Response>((resolve, reject) => {
    const request = httpsRequest(target, {
      method, headers: { ...headers, "Content-Length": Buffer.byteLength(body) }, signal,
    }, response => {
      const chunks: Buffer[] = [];
      let bytes = 0;
      response.on("data", (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > 2_000_000) {
          request.destroy(new Error("LIVE_EVAL_RESPONSE_TOO_LARGE"));
          return;
        }
        chunks.push(chunk);
      });
      response.on("error", reject);
      response.on("end", () => {
        const status = response.statusCode;
        if (!status) { reject(new Error("LIVE_EVAL_MISSING_HTTP_STATUS")); return; }
        const data = Buffer.concat(chunks).toString("utf8");
        resolve({
          ok: status >= 200 && status < 300,
          status, text: async () => data, json: async () => JSON.parse(data),
        } as Response);
      });
    });
    request.on("error", reject);
    request.end(body);
  });
}
