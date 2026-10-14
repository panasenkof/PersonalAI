import { postModel } from "../stream";
import { ModelRequestError, httpError, nativeError, providerDetail, redact } from "../net";
import { runDirectAgent } from "../engine";

const tiny = { connectMs: 30, idleMs: 30, totalMs: 200 };
/** A fake XHR driven by a script of [delay ms, action] steps. */
function scripted(steps: Array<[number, "headers" | "data" | "load" | "error", string?]>) {
  return () => {
    const x: any = { status: 0, readyState: 0, responseText: "", open: jest.fn(), setRequestHeader: jest.fn(), abort: jest.fn(),
      send() {
        let at = 0;
        for (const [delay, action, text = ""] of steps) {
          at += delay;
          setTimeout(() => {
            if (action === "headers") { x.status = 200; x.readyState = 2; x.onreadystatechange?.(); }
            if (action === "data") { x.responseText += text; x.readyState = 3; x.onprogress?.(); }
            if (action === "load") { x.readyState = 4; x.onload?.(); }
            if (action === "error") { x.responseText = text; x.onerror?.(); }
          }, at);
        }
      } };
    return x;
  };
}
const call = (xhr: any, timeouts = tiny) => postModel("https://api.example.com/v1/chat/completions", {}, {}, { protocol: "chat", stream: true, onText: () => {}, xhr, timeouts });

test("no response headers in time is reported as a connection that never came up", async () => {
  await expect(call(scripted([]))).rejects.toMatchObject({ kind: "connect_timeout", message: expect.stringContaining("api.example.com: сервер не ответил за") });
});

test("silence after the response started is reported as stalled data, not a slow model", async () => {
  const xhr = scripted([[1, "headers"], [1, "data", 'data: {"choices":[{"delta":{"content":"Нач"}}]}\n\n'], [500, "load"]]);
  await expect(call(xhr)).rejects.toMatchObject({ kind: "idle_timeout", message: expect.stringContaining("ответ начался, но") });
});

test("a reply that keeps trickling past the total limit is cut off", async () => {
  const steps: Array<[number, "headers" | "data"]> = [[1, "headers"]];
  for (let i = 0; i < 30; i++) steps.push([15, "data"]);
  await expect(call(scripted(steps.map(([d, a]) => [d, a, "data: {}\n\n"] as any)))).rejects.toMatchObject({ kind: "total_timeout" });
});

test("native network failures name their cause", () => {
  const host = "api.openai.com";
  expect(nativeError("java.net.UnknownHostException: Unable to resolve host \"api.openai.com\"", host).kind).toBe("dns");
  expect(nativeError("Failed to connect to /192.168.1.10:11434", "192.168.1.10:11434").kind).toBe("refused");
  expect(nativeError("CLEARTEXT communication to 192.168.1.10 not permitted by network security policy", host).kind).toBe("cleartext");
  expect(nativeError("javax.net.ssl.SSLHandshakeException: Trust anchor for certification path not found.", host).kind).toBe("tls");
  expect(nativeError("java.net.SocketTimeoutException: timeout", host).kind).toBe("connect_timeout");
  expect(nativeError("unexpected end of stream on https://api.openai.com/", host).kind).toBe("reset");
  expect(nativeError("", host).message).toContain("сетевая ошибка");
});

test("a mid-stream network error after data is reported as a dropped connection", async () => {
  const xhr = scripted([[1, "headers"], [1, "data", 'data: {"choices":[{"delta":{"content":"Нач"}}]}\n\n'], [1, "error", "Software caused connection abort"]]);
  await expect(call(xhr, { connectMs: 1000, idleMs: 1000, totalMs: 2000 })).rejects.toMatchObject({ kind: "reset" });
});

test("HTTP errors explain the status and quote only the redacted provider message", () => {
  const detail = providerDetail(JSON.stringify({ error: { code: "unsupported_country_region_territory", message: "Country, region, or territory not supported" } }));
  const e = httpError(403, "api.openai.com", detail);
  expect(e.message).toContain("недоступен в вашей стране");
  expect(e.message).toContain("HTTP 403");
  expect(e.message).toContain("unsupported_country_region_territory");
  const key = "sk-proj-abcdefghijklmnopqrstuvwxyz123456";
  const leaked = providerDetail(JSON.stringify({ error: { message: "Incorrect API key provided: " + key } }), [key]);
  expect(leaked.message).not.toContain("abcdefghijklmnop");
  expect(httpError(401, "h", leaked).message).toContain("ключ API не принят");
  expect(httpError(404, "h", { message: "The model `gpt-9` does not exist" }).message).toContain("модель не найдена");
  expect(httpError(429, "h", { code: "insufficient_quota" }).message).toContain("квота");
  expect(redact("token-abcdef123456 and " + "x".repeat(40))).toBe("*** and ***");
});

test("a hanging provider ends the chat turn with the precise error instead of waiting forever", async () => {
  const run = runDirectAgent({
    settings: { provider: "openai", baseUrl: "https://api.openai.com/v1", model: "gpt-4.1-mini", apiKey: "k", webSearchKey: "", allowWeb: false },
    prompt: "Привет", history: [], lookup: async () => [], propose: () => {},
    onText: () => {}, streamXhr: scripted([]), timeouts: tiny,
  });
  await expect(run).rejects.toBeInstanceOf(ModelRequestError);
  await expect(run).rejects.toThrow("api.openai.com: сервер не ответил за 0 с");
});
