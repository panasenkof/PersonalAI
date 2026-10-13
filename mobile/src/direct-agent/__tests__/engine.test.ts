import { MAX_DIRECT_REQUESTS, runDirectAgent } from "../engine";
import type { DirectAgentSettings } from "../settings";

const base: DirectAgentSettings = {
  apiKey: "test-key-only", webSearchKey: "", provider: "openai",
  baseUrl: "https://api.openai.com/v1", model: "gpt-4.1-mini", allowWeb: false,
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

test("serverless requests always provide memory tools and keep web off until enabled", async () => {
  const request = jest.fn().mockResolvedValue(final());
  const result = await start({}, request);
  expect(result.text).toBe("Готово");
  expect(result.requests).toBe(1);
  expect(request).toHaveBeenCalledTimes(1);
  expect(request.mock.calls[0][0]).toBe("https://api.openai.com/v1/responses");
  const body = JSON.parse(request.mock.calls[0][1].body);
  expect(body.store).toBe(false);
  expect(body.include).toContain("reasoning.encrypted_content");
  expect(body.tools.map((tool: any) => tool.name)).toEqual(["search_local_notes", "draft_local_note"]);
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
  const result = await start({  }, request, { lookup });
  expect(result.requests).toBe(2);
  expect(lookup).toHaveBeenCalledWith("кухня");
  const first = JSON.parse(request.mock.calls[0][1].body);
  expect(first.tools).toContainEqual(expect.objectContaining({ type: "function", name: "search_local_notes" }));
  const second = JSON.parse(request.mock.calls[1][1].body);
  expect(second.input).toContainEqual(expect.objectContaining({
    type: "function_call_output", call_id: "tool1", output: JSON.stringify({ notes: [{ id: "1", title: "Вкусы", body: "Люблю пасту" }] }),
  }));
});

test("invented tools remain unavailable even with always-on memory", async () => {
  const request = jest.fn().mockResolvedValueOnce(toolResponse("erase_local_memory", { query: "secret" }))
    .mockResolvedValueOnce(final());
  const lookup = jest.fn().mockResolvedValue([]);
  await start({}, request, { lookup });
  expect(lookup).toHaveBeenCalledTimes(1);
  const second = JSON.parse(request.mock.calls[1][1].body);
  expect(second.input).toContainEqual(expect.objectContaining({
    type: "function_call_output", output: JSON.stringify({ error: "tool_not_allowed" }),
  }));
});

test("model can propose a memory note but never writes it directly", async () => {
  const request = jest.fn().mockResolvedValueOnce(toolResponse("draft_local_note", { title: "Вкус", body: "Люблю пасту" }))
    .mockResolvedValueOnce(final());
  const propose = jest.fn();
  await start({  }, request, { propose });
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
  await expect(start({  }, request)).rejects.toThrow("лимит");
  expect(request).toHaveBeenCalledTimes(MAX_DIRECT_REQUESTS);
});

test("OpenAI-compatible API uses Chat Completions, not proprietary Responses tools", async () => {
  const response = jest.fn().mockResolvedValue({
    ok: true, status: 200, json: async () => ({ choices: [{ message: { role: "assistant", content: "Привет" } }] }),
  });
  const result = await start({
    provider: "openai-compatible", baseUrl: "https://llm.example.net/v1",
    model: "vendor/my-model",
  }, response);
  expect(result.text).toBe("Привет");
  expect(response.mock.calls[0][0]).toBe("https://llm.example.net/v1/chat/completions");
  const body = JSON.parse(response.mock.calls[0][1].body);
  expect(body).toMatchObject({ model: "vendor/my-model", max_tokens: 1200 });
  expect(body).not.toHaveProperty("include");
  expect(body).not.toHaveProperty("store");
  expect(body.tools).toContainEqual(expect.objectContaining({ type: "function" }));
});

test("explicit Brave search fails clearly when search key is absent", async () => {
  const response = jest.fn();
  await expect(start({ provider: "anthropic", baseUrl: "https://api.anthropic.com/v1",
    allowWeb: true, searchProvider: "brave" }, response)).rejects.toThrow("Brave Search API");
  expect(response).not.toHaveBeenCalled();
});

test("provider-independent Brave search supplies citations to Anthropic Messages and never leaks search key", async () => {
  const response = jest.fn()
    .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({
      web: { results: [
        { title: "Reference", url: "https://example.net/reference", description: "Relevant information." },
        { title: "Ignore", url: "http://insecure.example", description: "Non-HTTPS." },
      ] },
    }) })
    .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({
      content: [{ type: "text", text: "Согласно источнику..." }],
    }) });
  const result = await start({ provider: "anthropic", model: "claude-sonnet-4-5",
    baseUrl: "https://api.anthropic.com/v1", allowWeb: true,
    webSearchKey: "brave-secret-value" }, response);
  expect(result.sources).toEqual(["https://example.net/reference"]);
  expect(response.mock.calls[0][0]).toContain("api.search.brave.com");
  expect(response.mock.calls[0][1].headers["X-Subscription-Token"]).toBe("brave-secret-value");
  expect(response.mock.calls[1][0]).toBe("https://api.anthropic.com/v1/messages");
  expect(response.mock.calls[1][1].headers["x-api-key"]).toBe("test-key-only");
  const body = JSON.parse(response.mock.calls[1][1].body);
  expect(body.system).toContain("https://example.net/reference");
  expect(JSON.stringify(body)).not.toContain("brave-secret-value");
});

test("Anthropic tool-use loop only accesses approved memory and replays tool_result", async () => {
  const response = jest.fn()
    .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({
      content: [{ type: "tool_use", id: "use_1", name: "search_local_notes", input: { query: "чай" } }],
    }) })
    .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({
      content: [{ type: "text", text: "В памяти есть чай." }],
    }) });
  const lookup = jest.fn().mockResolvedValue([{ id: "a", title: "Чай", body: "Люблю чай" }]);
  const result = await start({ provider: "anthropic", baseUrl: "https://api.anthropic.com/v1",
     }, response, { lookup });
  expect(result.requests).toBe(2);
  expect(lookup).toHaveBeenCalledWith("чай");
  const body = JSON.parse(response.mock.calls[1][1].body);
  expect(body.messages[body.messages.length - 1]).toMatchObject({
    role: "user", content: [expect.objectContaining({ type: "tool_result", tool_use_id: "use_1" })],
  });
});

test("Chat Completions tool call creates a draft but never saves without approval", async () => {
  const response = jest.fn()
    .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({
      choices: [{ message: { role: "assistant", content: null, tool_calls: [{
        id: "call_a", type: "function", function: {
          name: "draft_local_note", arguments: JSON.stringify({ title: "Нравится", body: "Горы" }),
        },
      }] } }],
    }) })
    .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({
      choices: [{ message: { role: "assistant", content: "Черновик готов" } }],
    }) });
  const propose = jest.fn();
  await start({ provider: "openai-compatible", baseUrl: "https://llm.example.org/v1",
     }, response, { propose });
  expect(propose).toHaveBeenCalledWith({ title: "Нравится", body: "Горы" });
  const next = JSON.parse(response.mock.calls[1][1].body);
  expect(next.messages).toContainEqual(expect.objectContaining({
    role: "tool", tool_call_id: "call_a",
    content: JSON.stringify({ status: "awaiting_user_confirmation", saved: false }),
  }));
});

test("Brave search never runs when the web switch is off", async () => {
  const response = jest.fn().mockResolvedValue({
    ok: true, status: 200, json: async () => ({
      choices: [{ message: { role: "assistant", content: "Ответ" } }],
    }),
  });
  await start({ provider: "openai-compatible", baseUrl: "https://llm.example.org/v1",
    allowWeb: false, webSearchKey: "brave-key" }, response);
  expect(response).toHaveBeenCalledTimes(1);
  expect(response.mock.calls[0][0]).toContain("/chat/completions");
});

test("keyless local OpenAI-compatible model works without Authorization header", async () => {
  const response = jest.fn().mockResolvedValue({
    ok: true, status: 200,
    json: async () => ({ choices: [{ message: { role: "assistant", content: "Локально" } }] }),
  });
  const result = await start({
    provider: "openai-compatible", baseUrl: "http://192.168.1.20:11434/v1",
    apiKey: "", model: "qwen3:8b",
  }, response);
  expect(result.text).toBe("Локально");
  expect(response.mock.calls[0][0]).toBe("http://192.168.1.20:11434/v1/chat/completions");
  expect(response.mock.calls[0][1].headers.Authorization).toBeUndefined();
});
test("public HTTPS model server never silently sends an anonymous request", async () => {
  const response = jest.fn();
  await expect(start({ provider: "openai-compatible", baseUrl: "https://public.example/v1",
    apiKey: "" }, response)).rejects.toThrow("API-ключ");
  expect(response).not.toHaveBeenCalled();
});
