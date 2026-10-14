/** Streaming model replies over Server-Sent Events.
 *
 * React Native's fetch cannot read a response body incrementally, but its
 * XMLHttpRequest delivers growing `responseText` through `onprogress`. Each
 * protocol's events are folded back into the SAME JSON shape the non-streaming
 * API returns, so the tool loop handles both paths identically.
 */
import { DEFAULT_TIMEOUTS, ModelRequestError, connectTimeoutError, hostOf, httpError, idleTimeoutError, nativeError, providerDetail, totalTimeoutError } from "./net";
import type { Timeouts } from "./net";

export type Protocol = "responses" | "chat" | "anthropic";
export type SseEvent = { event?: string; data: string };
type XhrLike = Pick<XMLHttpRequest, "open" | "setRequestHeader" | "send" | "abort" | "status" | "responseText"> & {
  readyState?: number; onreadystatechange?: ((this: any, ev: any) => any) | null;
  onprogress: ((this: any, ev: any) => any) | null; onload: ((this: any, ev: any) => any) | null;
  onerror: ((this: any, ev: any) => any) | null; onabort: ((this: any, ev: any) => any) | null;
  ontimeout?: ((this: any, ev: any) => any) | null; timeout?: number;
};
export type XhrFactory = () => XhrLike;


/** Splits complete SSE events off the front of `buffer`. */
export function parseSse(buffer: string): { events: SseEvent[]; rest: string } {
  const events: SseEvent[] = [];
  const normalized = buffer.replace(/\r\n?/g, "\n");
  const blocks = normalized.split("\n\n");
  const rest = blocks.pop() ?? "";
  for (const block of blocks) {
    let event: string | undefined; const data: string[] = [];
    for (const line of block.split("\n")) {
      if (line.startsWith(":")) continue;
      const colon = line.indexOf(":");
      const field = colon < 0 ? line : line.slice(0, colon);
      const value = colon < 0 ? "" : line.slice(colon + 1).replace(/^ /, "");
      if (field === "event") event = value;
      else if (field === "data") data.push(value);
    }
    if (data.length) events.push({ event, data: data.join("\n") });
  }
  return { events, rest };
}

/** Accumulates one protocol's stream into its non-streaming response shape. */
export function streamAccumulator(protocol: Protocol, onText: (text: string) => void) {
  let text = "";
  const emit = (piece: unknown) => { if (typeof piece === "string" && piece) { text += piece; onText(text); } };
  if (protocol === "responses") {
    let final: unknown = null;
    return {
      add(event: SseEvent) {
        const data = safeJson(event.data); if (!data) return;
        if (data.type === "response.output_text.delta") emit(data.delta);
        else if (["response.completed", "response.incomplete", "response.failed"].includes(data.type)) final = data.response;
        else if (data.type === "error") final = { error: data.error || { message: "stream_error" }, status: "failed" };
      },
      result: () => final,
    };
  }
  if (protocol === "chat") {
    let content = ""; let finish: string | null = null; let seen = false;
    const tools = new Map<number, { id: string; type: "function"; function: { name: string; arguments: string } }>();
    return {
      add(event: SseEvent) {
        if (event.data.trim() === "[DONE]") return;
        const data = safeJson(event.data); if (!data) return;
        if (data.error) { finish = "error"; seen = true; return; }
        const choice = data.choices?.[0]; if (!choice) return;
        seen = true;
        const delta = choice.delta || {};
        if (typeof delta.content === "string") { content += delta.content; emit(delta.content); }
        for (const call of Array.isArray(delta.tool_calls) ? delta.tool_calls : []) {
          const index = typeof call.index === "number" ? call.index : tools.size;
          const current = tools.get(index) || { id: "", type: "function" as const, function: { name: "", arguments: "" } };
          if (typeof call.id === "string") current.id = call.id;
          if (typeof call.function?.name === "string") current.function.name += call.function.name;
          if (typeof call.function?.arguments === "string") current.function.arguments += call.function.arguments;
          tools.set(index, current);
        }
        if (choice.finish_reason) finish = choice.finish_reason;
      },
      result: () => !seen ? null : finish === "error" ? { error: { message: "stream_error" } } : {
        choices: [{ finish_reason: finish, message: { role: "assistant", content,
          ...(tools.size ? { tool_calls: [...tools.entries()].sort((a, b) => a[0] - b[0]).map(([, call]) => call) } : {}) } }],
      },
    };
  }
  // Anthropic Messages
  const blocks: Array<Record<string, any>> = []; const partialJson = new Map<number, string>();
  let stop: string | null = null; let started = false; let failed = false;
  return {
    add(event: SseEvent) {
      const data = safeJson(event.data); if (!data) return;
      if (data.type === "message_start") started = true;
      else if (data.type === "content_block_start") {
        const block = { ...data.content_block };
        if (block.type === "text") block.text = block.text || "";
        if (block.type === "tool_use") { block.input = {}; partialJson.set(data.index, ""); }
        blocks[data.index] = block;
      } else if (data.type === "content_block_delta") {
        const block = blocks[data.index]; if (!block) return;
        if (data.delta?.type === "text_delta") { block.text += data.delta.text || ""; emit(data.delta.text); }
        else if (data.delta?.type === "input_json_delta") partialJson.set(data.index, (partialJson.get(data.index) || "") + (data.delta.partial_json || ""));
      } else if (data.type === "content_block_stop") {
        const block = blocks[data.index];
        if (block?.type === "tool_use") block.input = safeJson(partialJson.get(data.index) || "{}") ?? {};
      } else if (data.type === "message_delta") stop = data.delta?.stop_reason ?? stop;
      else if (data.type === "error") failed = true;
    },
    result: () => failed ? { error: { message: "stream_error" } } : started ? { content: blocks.filter(Boolean), stop_reason: stop } : null,
  };
}

function safeJson(text: string): any {
  try { return JSON.parse(text); } catch { return null; }
}

const defaultXhr: XhrFactory = () => new XMLHttpRequest() as unknown as XhrLike;
/** True where XMLHttpRequest exists (the app); Jest's node environment uses fetch. */
export const streamingAvailable = () => typeof XMLHttpRequest !== "undefined";

export type Phase = "connecting" | "waiting" | "writing";
export type PostOptions = {
  protocol: Protocol;
  /** Stream with Server-Sent Events; otherwise one JSON reply. */
  stream: boolean;
  onText?: (text: string) => void;
  onPhase?: (phase: Phase) => void;
  signal?: AbortSignal;
  xhr?: XhrFactory;
  timeouts?: Timeouts;
  /** Redacted from any error text shown to the user. */
  secrets?: string[];
};

/** POSTs `body` and resolves with the provider's non-streaming JSON shape.
 * Every way this can stall ends in a ModelRequestError naming the cause:
 * no headers within `connectMs`, silence longer than `idleMs` while
 * streaming, or the whole call exceeding `totalMs`. A server that ignores
 * `stream: true` and answers with plain JSON still works. */
export function postModel(url: string, headers: Record<string, string>, body: Record<string, unknown>, options: PostOptions): Promise<any> {
  const { protocol, stream, onText = () => {}, onPhase, signal, xhr = defaultXhr, timeouts = DEFAULT_TIMEOUTS, secrets = [] } = options;
  const host = hostOf(url);
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new Error("Запрос остановлен")); return; }
    const request = xhr(); const accumulator = streamAccumulator(protocol, text => { if (!wrote) { wrote = true; onPhase?.("writing"); } onText(text); });
    let consumed = 0; let buffer = ""; let settled = false; let headersSeen = false; let bytes = 0; let wrote = false;
    const timers: Array<ReturnType<typeof setTimeout>> = [];
    let idle: ReturnType<typeof setTimeout> | null = null;
    const clear = () => { for (const t of timers) clearTimeout(t); if (idle) clearTimeout(idle); };
    const finish = (fn: () => void) => {
      if (settled) return; settled = true; clear(); signal?.removeEventListener("abort", abort); fn();
    };
    // Settle BEFORE aborting: abort() may synchronously fire onabort again.
    const fail = (error: Error) => finish(() => { try { request.abort(); } catch { /* already closed */ } reject(error); });
    const abort = () => fail(new Error("Запрос остановлен"));
    const armIdle = () => {
      if (!stream) return;
      if (idle) clearTimeout(idle);
      idle = setTimeout(() => fail(idleTimeoutError(host, timeouts, wrote)), timeouts.idleMs);
    };
    const sawHeaders = () => {
      if (headersSeen || !request.status) return;
      headersSeen = true; onPhase?.("waiting"); armIdle();
    };
    const drain = () => {
      sawHeaders();
      if (request.status && (request.status < 200 || request.status >= 300)) return;
      const text = request.responseText || "";
      if (text.length > consumed) { bytes += text.length - consumed; armIdle(); }
      buffer += text.slice(consumed); consumed = text.length;
      if (!stream) return;
      const { events, rest } = parseSse(buffer); buffer = rest;
      for (const event of events) accumulator.add(event);
    };
    request.onreadystatechange = () => { if ((request.readyState ?? 0) >= 2) sawHeaders(); };
    request.onprogress = drain;
    request.onload = () => {
      if (request.status < 200 || request.status >= 300) {
        fail(httpError(request.status, host, providerDetail(request.responseText || "", secrets))); return;
      }
      drain();
      if (stream && buffer.trim()) { for (const event of parseSse(buffer + "\n\n").events) accumulator.add(event); buffer = ""; }
      const result = (stream ? accumulator.result() : null) ?? safeJson(request.responseText || "");
      if (result) finish(() => resolve(result));
      else fail(new ModelRequestError("incomplete_stream", bytes
        ? `${host}: сервер закрыл соединение, не завершив ответ (получено ${bytes} байт).`
        : `${host}: сервер ответил пустым сообщением.`, host));
    };
    // On a network failure React Native puts the native message in responseText.
    request.onerror = () => fail(nativeError(bytes ? "connection reset" : String(request.responseText || ""), host, secrets));
    request.ontimeout = () => fail(totalTimeoutError(host, timeouts));
    request.onabort = () => fail(new Error("Запрос остановлен"));
    signal?.addEventListener("abort", abort, { once: true });
    if (stream) timers.push(setTimeout(() => { if (!headersSeen) fail(connectTimeoutError(host, timeouts)); }, timeouts.connectMs));
    timers.push(setTimeout(() => fail(totalTimeoutError(host, timeouts)), timeouts.totalMs));
    onPhase?.("connecting");
    request.open("POST", url);
    for (const [name, value] of Object.entries(headers)) request.setRequestHeader(name, value);
    request.setRequestHeader("Accept", stream ? "text/event-stream" : "application/json");
    request.send(JSON.stringify(stream ? { ...body, stream: true } : body));
  });
}
