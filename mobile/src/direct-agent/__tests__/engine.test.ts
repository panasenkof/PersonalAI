import { MAX_DIRECT_REQUESTS, runDirectAgent } from "../engine";
import type { DirectAgentSettings } from "../settings";

const base: DirectAgentSettings = {
  apiKey: "test-key-only", model: "gpt-4.1-mini", allowMemory: false, allowWeb: false,
};
const final = (text = "Готово") => ({
  ok: true, status: 200,
  json: async () => ({
    status: "completed", output: [{ type: "message", content: [{ type: "output_text", text }] }],
  }),
});
const toolResponse = (name: string, args: unknown, callId = "tool1") => ({
  ok: true, status: 200, json: async () => ({
    status: "completed", output: [{
      type: "function_call", name, call_id: callId, arguments: JSON.stringify(args),
    }],
  }),
});
function start(overrides: Partial<DirectAgentSettings>, transport: jest.Mock, overrides2: Record<string, unknown> = {}) {
  return runDirectAgent({
    settings: { ...base, ...overrides },
    prompt: "Что ты знаешь обо мне?", history: [],
    transport: transport as unknown as typeof fetch,
    lookup: jest.fn().mockResolvedValue([]),
    propose: jest.fn(),
    ...overrides2,
  });
}

test("serverless OpenAI request does not send memory tools or enable web without permission", async () => {
  const request = jest.fn().mockResolvedValue(final());
  const result = await start({}, request);
  expect(result.text).toBe("Готово");
  expect(result.requests).toBe(1);
  expect(request).toHaveBeenCalledTimes(1);
  expect(request.mock.calls[0][0]).toBe("https://api.openai.com/v1/responses");
  const body = JSON.parse(request.mock.calls[0][1].body);
  expect(body.store).toBe(false);
  expect(body.include).toContain("reasoning.encrypted_content");
  expect(body.tools).toEqual([]);
  expect(request.mock.calls[0][1].headers.Authorization).toBe("Bearer test-key-only");
  expect(JSON.stringify(body)).not.toContain("test-key-only");
});

test("web search is enabled only with explicit toggle and citations returned", async () => {
  const request = jest.fn().mockResolvedValue({
    ok: true, status: 200, json: async () => ({
      status: "completed",
      output: [{ type: "message", content: [{
        type: "output_text", text: "Факт",
        annotations: [{ type: "url_citation", url: "https://example.org/source" }, { type: "url_citation", url: "http://insecure.test" }],
      }] }],
    }),
  });
  const result = await start({ allowWeb: true }, request);
  const tools = JSON.parse(request.mock.calls[0][1].body).tools;
  expect(tools).toContainEqual(expect.objectContaining({ type: "web_search" }));
  expect(result.sources).toEqual(["https://example.org/source"]);
});

test("web search sources are surfaced from provider action metadata", async () => {
  const request = jest.fn().mockResolvedValue({
    ok: true, status: 200, json: async () => ({
      status: "completed",
      output: [
        { type: "web_search_call", action: { sources: [{ url: "https://example.org/web" }] } },
        { type: "message", content: [{ type: "output_text", text: "Ответ" }] },
      ],
    }),
  });
  const result = await start({ allowWeb: true }, request);
  expect(result.sources).toEqual(["https://example.org/web"]);
  const body = JSON.parse(request.mock.calls[0][1].body);
  expect(body.include).toContain("web_search_call.action.sources");
});

test("local-memory tool uses only approved callback and replays tool output", async () => {
  const request = jest.fn().mockResolvedValueOnce(toolResponse("search_local_notes", { query: "кухня" }))
    .mockResolvedValueOnce(final("Вы любите пасту"));
  const lookup = jest.fn().mockResolvedValue([{ id: "1", title: "Вкусы", body: "Люблю пасту" }]);
  const result = await start({ allowMemory: true }, request, { lookup });
  expect(result.requests).toBe(2);
  expect(lookup).toHaveBeenCalledWith("кухня");
  const first = JSON.parse(request.mock.calls[0][1].body);
  expect(first.tools).toContainEqual(expect.objectContaining({ type: "function", name: "search_local_notes" }));
  const second = JSON.parse(request.mock.calls[1][1].body);
  expect(second.input).toContainEqual(expect.objectContaining({
    type: "function_call_output", call_id: "tool1", output: JSON.stringify({ notes: [{ id: "1", title: "Вкусы", body: "Люблю пасту" }] }),
  }));
});

test("unapproved memory tool cannot read device notes even if model invents call", async () => {
  const request = jest.fn().mockResolvedValueOnce(toolResponse("search_local_notes", { query: "secret" }))
    .mockResolvedValueOnce(final());
  const lookup = jest.fn();
  await start({}, request, { lookup });
  expect(lookup).not.toHaveBeenCalled();
  const second = JSON.parse(request.mock.calls[1][1].body);
  expect(second.input).toContainEqual(expect.objectContaining({
    type: "function_call_output", output: JSON.stringify({ error: "tool_not_allowed" }),
  }));
});

test("model can propose a memory note but never writes it directly", async () => {
  const request = jest.fn().mockResolvedValueOnce(toolResponse("draft_local_note", { title: "Вкус", body: "Люблю пасту" }))
    .mockResolvedValueOnce(final());
  const propose = jest.fn();
  await start({ allowMemory: true }, request, { propose });
  expect(propose).toHaveBeenCalledWith({ title: "Вкус", body: "Люблю пасту" });
  const second = JSON.parse(request.mock.calls[1][1].body);
  expect(second.input).toContainEqual(expect.objectContaining({
    type: "function_call_output", output: JSON.stringify({ status: "awaiting_user_confirmation", saved: false }),
  }));
});

test("fails closed for HTTP errors without reflecting third-party error messages", async () => {
  const request = jest.fn().mockResolvedValue({ ok: false, status: 401, text: async () => "test-key-only" });
  await expect(start({}, request)).rejects.toThrow("HTTP 401");
  await expect(start({}, request)).rejects.not.toThrow("test-key-only");
});

test("aborted direct requests never call the provider", async () => {
  const controller = new AbortController();
  controller.abort();
  const request = jest.fn();
  await expect(start({}, request, { signal: controller.signal })).rejects.toThrow("Запрос остановлен");
  expect(request).not.toHaveBeenCalled();
});

test("limits tool cycles to prevent unbounded API spending", async () => {
  const request = jest.fn().mockImplementation(async () =>
    toolResponse("search_local_notes", { query: "тест" }));
  await expect(start({ allowMemory: true }, request)).rejects.toThrow("лимит");
  expect(request).toHaveBeenCalledTimes(MAX_DIRECT_REQUESTS);
});
