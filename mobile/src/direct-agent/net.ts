/** Network errors that say exactly what went wrong, and time limits that turn
 * a silent stall into one of them. */

export type FailureKind =
  | "dns" | "refused" | "tls" | "offline" | "cleartext" | "reset"
  | "connect_timeout" | "idle_timeout" | "total_timeout"
  | "http" | "incomplete_stream" | "network";

export class ModelRequestError extends Error {
  constructor(readonly kind: FailureKind, message: string, readonly host: string, readonly status?: number) {
    super(message);
    this.name = "ModelRequestError";
  }
}

export type Timeouts = {
  /** Until the server sends response headers (streaming only). */
  connectMs: number;
  /** Longest silence once the response has started (streaming only). */
  idleMs: number;
  /** The whole call. */
  totalMs: number;
};
export const DEFAULT_TIMEOUTS: Timeouts = { connectMs: 25_000, idleMs: 60_000, totalMs: 240_000 };
/** Reasoning models may stay silent for minutes before the first token. */
export const REASONING_TIMEOUTS: Timeouts = { connectMs: 25_000, idleMs: 180_000, totalMs: 360_000 };
/** Web search and other short helper requests. */
export const SHORT_TIMEOUTS: Timeouts = { connectMs: 12_000, idleMs: 12_000, totalMs: 12_000 };

export const hostOf = (url: string): string => {
  try { return new URL(url).host; } catch { return "сервер"; }
};
const seconds = (ms: number) => Math.round(ms / 1000);

/** Removes the API key and anything that looks like a credential. */
export function redact(text: string, secrets: string[] = []): string {
  let out = text;
  for (const secret of secrets) if (secret && secret.length >= 4) out = out.split(secret).join("***");
  return out.replace(/\b(sk|pk|rk|key|token)[-_][A-Za-z0-9_\-]{6,}/gi, "***")
    .replace(/[A-Za-z0-9_\-]{32,}/g, "***");
}

/** Reads only the provider's error code and a redacted, shortened message. */
export function providerDetail(body: string, secrets: string[] = []): { code?: string; message?: string } {
  let data: any;
  try { data = JSON.parse(body); } catch { return htmlDetail(body); }
  // Tavily and FastAPI services put the error under `detail`.
  const detail = data && !Array.isArray(data) && data.detail !== undefined ? data.detail : undefined;
  const error = detail !== undefined ? (detail?.error ?? (Array.isArray(detail) ? detail[0]?.msg : detail)) :
    Array.isArray(data) ? data[0]?.error ?? data[0] : data?.error ?? data;
  const raw = typeof error === "string" ? { message: error } : error && typeof error === "object" ? error : {};
  const code = [raw.code, raw.type, raw.status].find(v => typeof v === "string" && /^[a-z][a-z0-9_.-]{1,63}$/i.test(v) && !/^(sk|key)[-_]/i.test(v));
  const message = typeof raw.message === "string" ? redact(raw.message, secrets).replace(/\s+/g, " ").trim().slice(0, 180) : undefined;
  return { ...(code ? { code } : {}), ...(message ? { message } : {}) };
}

/** A non-JSON error page: a firewall or CDN answered instead of the API. */
function htmlDetail(body: string): { code?: string; message?: string } {
  // Only an HTML page is interpreted; other raw bodies are never echoed.
  if (!/^\s*<(?:!doctype|html|head|body)/i.test(body)) return {};
  const blocked = /cloudflare|cf-ray|attention required|access denied|request blocked|forbidden|captcha|not available in your (?:country|region)/i.test(body);
  const title = /<title[^>]*>([^<]{1,120})<\/title>/i.exec(body)?.[1]?.replace(/\s+/g, " ").trim();
  return { ...(blocked ? { code: "blocked_by_firewall" } : {}), ...(title ? { message: redact(title) } : {}) };
}

/** Plain-language reason for an HTTP error status. */
export function httpError(status: number, host: string, detail: { code?: string; message?: string } = {}): ModelRequestError {
  const text = `${detail.code || ""} ${detail.message || ""}`;
  const region = /unsupported_country|country|region|territory|not available in your/i.test(text);
  const quota = /insufficient_quota|quota|balance|billing|credit/i.test(text);
  const model = /model/i.test(text);
  const firewall = detail.code === "blocked_by_firewall";
  const reason =
    status === 400 ? (model ? "сервис не принял название модели или её параметры" : "сервис отклонил запрос") :
    status === 401 ? "ключ API не принят — проверьте ключ этого подключения" :
    status === 402 ? "на счёте сервиса нет средств" :
    status === 403 ? (region ? "сервис недоступен в вашей стране или регионе" :
      firewall ? "запрос отклонила защита сервиса, а не сам API — обычно так блокируют страну или сеть (проверьте с VPN или выберите другой способ поиска)" :
      "доступ запрещён — сервис мог заблокировать вашу страну или сеть (проверьте с VPN) или ключ не имеет прав") :
    status === 404 ? (model ? "такая модель не найдена — проверьте её название" : "адрес API не найден — проверьте Base URL") :
    status === 408 || status === 504 ? "сервис не успел ответить" :
    status === 413 ? "запрос слишком большой" :
    status === 432 || status === 433 ? "исчерпан лимит тарифа — бесплатные запросы на этот месяц закончились" :
    status === 429 ? (quota ? "исчерпана квота или баланс" : "превышен лимит запросов — подождите и повторите") :
    status >= 500 ? "ошибка на стороне сервиса — повторите позже" : "сервис вернул ошибку";
  const said = [detail.code, detail.message].filter(Boolean).join(": ");
  return new ModelRequestError("http", `${host}: ${reason} (HTTP ${status}).${said ? ` Ответ сервиса: «${said}».` : ""}`, host, status);
}

/** Classifies the native message that React Native's XMLHttpRequest exposes
 * on a network failure (OkHttp on Android, NSURLError on iOS). */
export function nativeError(native: string, host: string, secrets: string[] = []): ModelRequestError {
  const n = native || "";
  const tail = n ? ` Системное сообщение: «${redact(n, secrets).replace(/\s+/g, " ").slice(0, 140)}».` : "";
  if (/CLEARTEXT|cleartext/i.test(n)) return new ModelRequestError("cleartext",
    `${host}: телефон запретил незашифрованное подключение по http://. Обновите приложение или используйте https://.${tail}`, host);
  if (/UnknownHost|Unable to resolve host|No address associated|hostname could not be found|-1003|EAI_/i.test(n)) return new ModelRequestError("dns",
    `${host}: адрес сервера не найден (ошибка DNS). Проверьте интернет и адрес API.${tail}`, host);
  if (/Network is unreachable|ENETUNREACH|-1009|offline|Internet connection appears/i.test(n)) return new ModelRequestError("offline",
    `${host}: нет подключения к сети.${tail}`, host);
  if (/Failed to connect|ConnectException|ECONNREFUSED|Connection refused|-1004|Could not connect to the server/i.test(n)) return new ModelRequestError("refused",
    `${host}: сервер отклонил подключение. Для локальной модели проверьте, что она запущена и доступна из сети телефона.${tail}`, host);
  if (/SSL|TLS|Trust anchor|CertPath|certificate|-120[0-9]/i.test(n)) return new ModelRequestError("tls",
    `${host}: не удалось установить защищённое соединение — сертификат сервера не принят.${tail}`, host);
  if (/SocketTimeout|timed? ?out|-1001/i.test(n)) return new ModelRequestError("connect_timeout",
    `${host}: соединение не установилось — истекло время ожидания.${tail}`, host);
  if (/reset|ECONNRESET|unexpected end of stream|Broken pipe|-1005|connection was lost|stream was reset|closed/i.test(n)) return new ModelRequestError("reset",
    `${host}: соединение оборвалось во время ответа.${tail}`, host);
  return new ModelRequestError("network", `${host}: сетевая ошибка, сервер не ответил.${tail || " Проверьте интернет и адрес API."}`, host);
}

export const connectTimeoutError = (host: string, t: Timeouts) => new ModelRequestError("connect_timeout",
  `${host}: сервер не ответил за ${seconds(t.connectMs)} с — подключение не установилось. Сервис может быть недоступен из вашей сети (так бывает с OpenAI и Anthropic из России) или нет интернета.`, host);
export const idleTimeoutError = (host: string, t: Timeouts, started: boolean) => new ModelRequestError("idle_timeout",
  `${host}: ${started ? "ответ начался, но" : "соединение установлено, но"} ${seconds(t.idleMs)} с не приходило новых данных. Запрос прерван.`, host);
export const totalTimeoutError = (host: string, t: Timeouts) => new ModelRequestError("total_timeout",
  `${host}: ответ не завершился за ${seconds(t.totalMs)} с. Запрос прерван. Попробуйте короче вопрос или другую модель.`, host);

/** fetch with a hard time limit and precise errors (web search, files, tests).
 * fetch cannot tell connecting from waiting, so only the total limit applies. */
export async function fetchWithTimeout(transport: typeof fetch, url: string, init: RequestInit & { signal?: AbortSignal },
  t: Timeouts = SHORT_TIMEOUTS, secrets: string[] = []): Promise<Response> {
  const host = hostOf(url);
  const aborter = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; aborter.abort(); }, t.totalMs);
  const outer = init.signal;
  const forward = () => aborter.abort();
  if (outer?.aborted) aborter.abort(); else outer?.addEventListener("abort", forward, { once: true });
  try {
    return await transport(url, { ...init, signal: aborter.signal });
  } catch (e) {
    if (timedOut) throw totalTimeoutError(host, t);
    if (outer?.aborted) throw new Error("Запрос остановлен");
    if (e instanceof ModelRequestError) throw e;
    throw nativeError(String((e as Error)?.message || e), host, secrets);
  } finally {
    clearTimeout(timer);
    outer?.removeEventListener("abort", forward);
  }
}
