import { parseSse, postModel } from "../stream";
import { ModelRequestError } from "../net";

/** Delivers `chunks` as growing responseText, like React Native's XHR. */
function fakeXhr(chunks: string[], status = 200) {
  return () => {
    const x: any = { status: 0, responseText: "", headers: {} as Record<string, string>, open: jest.fn(),
      setRequestHeader(k: string, v: string) { x.headers[k] = v; }, abort() { x.onabort?.(); },
      send(body: string) { x.body = body; let i = 0; const step = () => { x.status = status;
        if (i < chunks.length) { x.responseText += chunks[i++]; x.onprogress?.(); setTimeout(step, 0); } else x.onload?.(); }; setTimeout(step, 0); } };
    return x;
  };
}

test("SSE events split across chunks and CRLF line ends are reassembled", () => {
  const parsed = parseSse('event: a\r\ndata: {"x":1}\r\n\r\ndata: par');
  expect(parsed.events).toEqual([{ event: "a", data: '{"x":1}' }]);
  expect(parsed.rest).toBe("data: par");
});

test("Responses stream shows growing text and returns the final response object", async () => {
  const texts: string[] = [];
  const result = await postModel("u", {}, { model: "m" }, { protocol: "responses", stream: true, onText: t => texts.push(t), signal: undefined, xhr: fakeXhr([
    'event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"Пр', 'ивет"}\n\n',
    'data: {"type":"response.output_text.delta","delta":", мир"}\n\n',
    'data: {"type":"response.completed","response":{"status":"completed","output":[{"type":"message","content":[{"type":"output_text","text":"Привет, мир"}]}]}}\n\n']) });
  expect(texts).toEqual(["Привет", "Привет, мир"]);
  expect(result.status).toBe("completed");
});

test("Chat Completions stream rebuilds tool calls from argument fragments", async () => {
  const result = await postModel("u", {}, {}, { protocol: "chat", stream: true, onText: () => {}, signal: undefined, xhr: fakeXhr([
    'data: {"choices":[{"delta":{"role":"assistant","tool_calls":[{"index":0,"id":"c1","function":{"name":"search_local_notes","arguments":"{\\"qu"}}]}}]}\n\n',
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"ery\\":\\"кофе\\"}"}}]},"finish_reason":"tool_calls"}]}\n\ndata: [DONE]\n\n']) });
  expect(result.choices[0].message.tool_calls).toEqual([{ id: "c1", type: "function", function: { name: "search_local_notes", arguments: '{"query":"кофе"}' } }]);
});

test("Anthropic stream rebuilds text and tool input blocks", async () => {
  const result = await postModel("u", {}, {}, { protocol: "anthropic", stream: true, onText: () => {}, signal: undefined, xhr: fakeXhr([
    'event: message_start\ndata: {"type":"message_start","message":{}}\n\n',
    'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Ищу"}}\n\n',
    'data: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"t1","name":"search_local_notes"}}\n\ndata: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"query\\":"}}\n\n',
    'data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"\\"чай\\"}"}}\n\ndata: {"type":"content_block_stop","index":1}\n\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use"}}\n\n']) });
  expect(result.content[0].text).toBe("Ищу");
  expect(result.content[1]).toMatchObject({ type: "tool_use", id: "t1", input: { query: "чай" } });
  expect(result.stop_reason).toBe("tool_use");
});

test("a server that ignores streaming still works, and errors never read the body", async () => {
  const plain = await postModel("u", {}, {}, { protocol: "chat", stream: true, onText: () => {}, signal: undefined, xhr: fakeXhr(['{"choices":[{"message":{"role":"assistant","content":"ok"}}]}']) });
  expect(plain.choices[0].message.content).toBe("ok");
  await expect(postModel("u", {}, {}, { protocol: "chat", stream: true, onText: () => {}, signal: undefined, xhr: fakeXhr(['{"error":"sk-secret"}'], 401) }))
    .rejects.toEqual(expect.objectContaining({ status: 401 }));
  await expect(postModel("u", {}, {}, { protocol: "chat", stream: true, onText: () => {}, signal: undefined, xhr: fakeXhr([], 500) })).rejects.toBeInstanceOf(ModelRequestError);
});

test("Stop aborts a running stream", async () => {
  const stop = new AbortController();
  const running = postModel("u", {}, {}, { protocol: "chat", stream: true, onText: () => {}, signal: stop.signal, xhr: fakeXhr(["data: {}\n\n", "x", "y"]) });
  stop.abort();
  await expect(running).rejects.toThrow("остановлен");
});
