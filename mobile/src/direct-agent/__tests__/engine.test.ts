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
  // gpt-4.1-mini is not a reasoning model: OpenAI rejects reasoning.encrypted_content for it.
  expect(body.include).not.toContain("reasoning.encrypted_content");
  expect(body.max_output_tokens).toBe(4000);
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
  const result = await start({ allowWeb: true }, request, { prompt: "Найди в интернете свежие новости" });
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
  const result = await start({ allowWeb: true }, request, { prompt: "Найди в интернете свежие новости" });
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
  expect(body).toMatchObject({ model: "vendor/my-model", max_tokens: 4000 });
  expect(body).not.toHaveProperty("include");
  expect(body).not.toHaveProperty("store");
  expect(body.tools).toContainEqual(expect.objectContaining({ type: "function" }));
});

test("a failed web search never costs the answer: the model replies and the user sees why", async () => {
  const response = jest.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ content: [{ type: "text", text: "Отвечаю без интернета" }] }) });
  const result = await start({ provider: "anthropic", baseUrl: "https://api.anthropic.com/v1",
    allowWeb: true, searchProvider: "brave" }, response, { prompt: "Найди в интернете свежие новости" });
  expect(result.text).toBe("Отвечаю без интернета");
  expect(result.notice).toContain("Brave Search API");
  expect(response).toHaveBeenCalledTimes(1);
  expect(JSON.parse(response.mock.calls[0][1].body).system).toContain("свежие данные не проверены");
});

test("when memory has nothing the user is told and the web is searched", async () => {
  const notify = jest.fn();
  const response = jest.fn()
    .mockResolvedValueOnce({ ok: true, status: 200, text: async () => '<rss><channel><item><title>Пасха</title><link>https://example.org/easter</link><description>Остров</description></item></channel></rss>' })
    .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ content: [{ type: "text", text: "Ответ" }] }) });
  await start({ provider: "anthropic", baseUrl: "https://api.anthropic.com/v1", allowWeb: true, searchProvider: "public" }, response, { prompt: "Расскажи про остров Пасхи", notify });
  expect(notify).toHaveBeenCalledWith("В памяти ничего не нашлось. Ищу в интернете.");
  expect(response.mock.calls[0][0]).toContain("bing.com/search");
  expect(response.mock.calls[1][0]).toBe("https://api.anthropic.com/v1/messages");
});

test("an answer found in memory never goes to the web", async () => {
  const notify = jest.fn();
  const response = jest.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ content: [{ type: "text", text: "Ответ" }] }) });
  await start({ provider: "anthropic", baseUrl: "https://api.anthropic.com/v1", allowWeb: true, searchProvider: "public" }, response,
    { prompt: "Где машина сестры?", notify, lookup: jest.fn().mockResolvedValue([{ id: "n", title: "Машина", body: "Продана" }]) });
  expect(response).toHaveBeenCalledTimes(1);
  expect(response.mock.calls[0][0]).toBe("https://api.anthropic.com/v1/messages");
  expect(notify).not.toHaveBeenCalled();
});

test("Tavily search sends its key as a bearer token and supplies citations", async () => {
  const response = jest.fn()
    .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ results: [{ title: "Курс", url: "https://example.org/rate", content: "Курс доллара" }] }) })
    .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ choices: [{ message: { role: "assistant", content: "По данным источника…" } }] }) });
  const result = await start({ provider: "openai-compatible", baseUrl: "https://api.deepseek.com", model: "deepseek-flash",
    allowWeb: true, searchProvider: "tavily", webSearchKey: "tvly-secret" }, response, { prompt: "Какой сегодня курс доллара?" });
  expect(response.mock.calls[0][0]).toBe("https://api.tavily.com/search");
  expect(response.mock.calls[0][1].headers.Authorization).toBe("Bearer tvly-secret");
  expect(JSON.parse(response.mock.calls[0][1].body)).toMatchObject({ query: "Какой сегодня курс доллара?", max_results: 5, search_depth: "basic" });
  expect(result.sources).toEqual(["https://example.org/rate"]);
  expect(JSON.stringify(JSON.parse(response.mock.calls[1][1].body))).not.toContain("tvly-secret");
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
    webSearchKey: "brave-secret-value" }, response, { prompt: "Найди в интернете свежие новости" });
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

test("reasoning models keep encrypted reasoning state and a larger budget", async () => {
  const request = jest.fn().mockResolvedValue(final());
  await start({ model: "gpt-5-mini" }, request);
  const body = JSON.parse(request.mock.calls[0][1].body);
  expect(body.include).toContain("reasoning.encrypted_content");
  expect(body.max_output_tokens).toBe(8000);
});

test("an answer cut by the output limit is kept with a note instead of an error", async () => {
  const request = jest.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({
    status: "incomplete", incomplete_details: { reason: "max_output_tokens" },
    output: [{ type: "message", content: [{ type: "output_text", text: "Начало длинного ответа" }] }],
  }) });
  const result = await start({}, request);
  expect(result.text).toContain("Начало длинного ответа");
  expect(result.text).toContain("обрезан");
});

test("an incomplete reply without any text explains the limit", async () => {
  const request = jest.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({
    status: "incomplete", incomplete_details: { reason: "max_output_tokens" }, output: [{ type: "reasoning", summary: [] }],
  }) });
  await expect(start({ model: "o4-mini" }, request)).rejects.toThrow("лимит ответа");
});

test("non-reasoning models never replay reasoning items", async () => {
  const request = jest.fn()
    .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ status: "completed", output: [
      { type: "reasoning", summary: [] },
      { type: "function_call", name: "search_local_notes", call_id: "c1", arguments: JSON.stringify({ query: "кофе" }) },
    ] }) })
    .mockResolvedValueOnce(final());
  await start({}, request);
  const second = JSON.parse(request.mock.calls[1][1].body);
  expect(second.input.some((item: any) => item.type === "reasoning")).toBe(false);
  expect(second.input.some((item: any) => item.type === "function_call_output")).toBe(true);
});

test("with a live text callback the answer streams through the same tool loop", async () => {
  const texts: string[] = [];
  const replies = [
    ['data: {"type":"response.completed","response":{"status":"completed","output":[{"type":"function_call","name":"search_local_notes","call_id":"s1","arguments":"{\\"query\\":\\"кофе\\"}"}]}}\n\n'],
    ['data: {"type":"response.output_text.delta","delta":"Вы любите "}\n\n', 'data: {"type":"response.output_text.delta","delta":"капучино"}\n\n',
     'data: {"type":"response.completed","response":{"status":"completed","output":[{"type":"message","content":[{"type":"output_text","text":"Вы любите капучино"}]}]}}\n\n'],
  ];
  const bodies: any[] = []; let call = 0;
  const streamXhr = () => {
    const chunks = replies[call++]; const x: any = { status: 0, responseText: "", open: jest.fn(), setRequestHeader: jest.fn(), abort: jest.fn(),
      send(body: string) { bodies.push(JSON.parse(body)); let i = 0; const step = () => { x.status = 200;
        if (i < chunks.length) { x.responseText += chunks[i++]; x.onprogress?.(); setTimeout(step, 0); } else x.onload?.(); }; setTimeout(step, 0); } };
    return x;
  };
  const lookup = jest.fn().mockResolvedValue([{ id: "n", title: "Кофе", body: "Капучино" }]);
  const result = await start({}, jest.fn(), { onText: (t: string) => texts.push(t), streamXhr, lookup });
  expect(result.text).toBe("Вы любите капучино");
  expect(texts).toEqual(["Вы любите ", "Вы любите капучино"]);
  expect(bodies.every(b => b.stream === true)).toBe(true);
  expect(bodies[1].input.some((item: any) => item.type === "function_call_output")).toBe(true);
});

test("a proposed note carries the section the model chose, and the schema lists only allowed sections", async () => {
  const propose = jest.fn();
  const request = jest.fn()
    .mockResolvedValueOnce(toolResponse("draft_local_note", { title: "Аня", body: "Сестра, день рождения 3 мая", section: "people" }))
    .mockResolvedValueOnce(final());
  await start({}, request, { propose });
  expect(propose).toHaveBeenCalledWith({ title: "Аня", body: "Сестра, день рождения 3 мая", section: "people" });
  const tool = JSON.parse(request.mock.calls[0][1].body).tools.find((t: any) => t.name === "draft_local_note");
  expect(tool.parameters.required).toContain("section");
  expect(tool.parameters.properties.section.enum).not.toContain("documents");
  const system = JSON.parse(request.mock.calls[0][1].body).input[0].content;
  expect(system).toContain("people — Люди");
});
