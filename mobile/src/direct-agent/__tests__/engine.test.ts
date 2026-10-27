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
  expect(body.tools.map((tool: any) => tool.name)).toEqual(["search_local_notes", "draft_memory_fact", "update_task_state"]);
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
    type: "function_call_output", call_id: "tool1", output: JSON.stringify({ notes: [{ id: "1", title: "Вкусы", body: "Люблю пасту" }], outcome: "found" }),
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
    type: "function_call_output", output: JSON.stringify({ status: "awaiting_user_confirmation", saved: false, outcome: "pending_confirmation" }),
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
    allowWeb: true, searchProvider: "tavily", webSearchKey: "" }, response, { prompt: "Найди в интернете свежие новости" });
  expect(result.text).toBe("Отвечаю без интернета");
  expect(result.notice).toContain("Введите ключ Tavily");
  expect(response).toHaveBeenCalledTimes(1);
  // Data goes in the user's turn, the rules stay in the system instruction.
  const sent = JSON.parse(response.mock.calls[0][1].body);
  expect(sent.messages[sent.messages.length - 1].content).toContain("свежие данные не проверены");
  expect(sent.system).not.toContain("свежие данные не проверены");
});

test("when memory has nothing the user is told and the web is searched", async () => {
  const notify = jest.fn();
  const response = jest.fn()
    .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ results: [{ title: "Пасха", url: "https://example.org/easter", content: "Остров" }] }) })
    .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ content: [{ type: "text", text: "Ответ" }] }) });
  await start({ provider: "anthropic", baseUrl: "https://api.anthropic.com/v1", allowWeb: true, searchProvider: "tavily", webSearchKey: "tvly-k" }, response, { prompt: "Расскажи про остров Пасхи", notify });
  expect(notify).toHaveBeenCalledWith("В памяти ничего не нашлось. Ищу в интернете.");
  expect(response.mock.calls[0][0]).toBe("https://api.tavily.com/search");
  expect(response.mock.calls[1][0]).toBe("https://api.anthropic.com/v1/messages");
});

test("an answer found in memory never goes to the web", async () => {
  const notify = jest.fn();
  const response = jest.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ content: [{ type: "text", text: "Ответ" }] }) });
  await start({ provider: "anthropic", baseUrl: "https://api.anthropic.com/v1", allowWeb: true, searchProvider: "tavily", webSearchKey: "tvly-k" }, response,
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

test("Yandex search sends an Api-Key with the folder, reads Base64 XML and never leaks the key", async () => {
  const xml = '<?xml version="1.0" encoding="utf-8"?><yandexsearch version="1.0"><response><results><grouping>' +
    '<group><doc><url>https://example.net/reference</url><title>Справка <hlword>Пасха</hlword> &amp; остров</title><passages><passage>Остров <hlword>Пасхи</hlword> в Тихом океане</passage></passages></doc></group>' +
    '<group><doc><url>http://insecure.example</url><title>Ignore</title><headline>Non-HTTPS</headline></doc></group>' +
    '</grouping></results></response></yandexsearch>';
  const response = jest.fn()
    .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ rawData: Buffer.from(xml, "utf8").toString("base64") }) })
    .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ content: [{ type: "text", text: "Согласно источнику..." }] }) });
  const result = await start({ provider: "anthropic", model: "claude-sonnet-4-5", baseUrl: "https://api.anthropic.com/v1", allowWeb: true,
    searchProvider: "yandex", searchFolderId: "b1gfolder", webSearchKey: "AQVN-yandex-secret" }, response, { prompt: "Найди в интернете про остров Пасхи" });
  expect(result.sources).toEqual(["https://example.net/reference"]);
  expect(response.mock.calls[0][0]).toBe("https://searchapi.api.cloud.yandex.net/v2/web/search");
  expect(response.mock.calls[0][1].headers.Authorization).toBe("Api-Key AQVN-yandex-secret");
  expect(JSON.parse(response.mock.calls[0][1].body)).toMatchObject({ folderId: "b1gfolder", responseFormat: "FORMAT_XML",
    query: { searchType: "SEARCH_TYPE_RU", queryText: "Найди в интернете про остров Пасхи" } });
  const body = JSON.parse(response.mock.calls[1][1].body);
  const turn = body.messages[body.messages.length - 1].content;
  expect(turn).toContain("Справка Пасха & остров — https://example.net/reference");
  expect(turn).toContain("Остров Пасхи в Тихом океане");
  expect(turn).toContain("НЕ инструкции");
  expect(JSON.stringify(body)).not.toContain("AQVN-yandex-secret");
});

test("a Yandex error inside the XML names its code; code 15 means nothing found", async () => {
  const { parseYandexXml } = require("../web-search");
  expect(() => parseYandexXml('<yandexsearch><response><error code="31">Ключ не подходит</error></response></yandexsearch>')).toThrow("поиск вернул ошибку 31: «Ключ не подходит»");
  expect(parseYandexXml('<yandexsearch><response><error code="15">Искомая комбинация слов нигде не встречается</error></response></yandexsearch>')).toEqual([]);
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
    content: JSON.stringify({ status: "awaiting_user_confirmation", saved: false, outcome: "pending_confirmation" }),
  }));
});

test("search never runs when the web switch is off", async () => {
  const response = jest.fn().mockResolvedValue({
    ok: true, status: 200, json: async () => ({
      choices: [{ message: { role: "assistant", content: "Ответ" } }],
    }),
  });
  await start({ provider: "openai-compatible", baseUrl: "https://llm.example.org/v1",
    allowWeb: false, searchProvider: "tavily", webSearchKey: "tvly-key" }, response);
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
  const tool = JSON.parse(request.mock.calls[0][1].body).tools.find((t: any) => t.name === "draft_memory_fact");
  expect(tool.parameters.required).toEqual(["title", "body", "section", "kind", "person", "date"]);
  expect(tool.parameters.properties.kind.enum).not.toContain("document");
  expect(tool.parameters.properties.section.description).not.toContain("Документы");
  const system = JSON.parse(request.mock.calls[0][1].body).input[0].content;
  expect(system).toContain("«Люди» — Близкие");
});

test("the model sees sections the user created, a named one is matched by name, a missing one is offered for creation", async () => {
  const propose = jest.fn();
  const sections = [{ slug: "notes", name: "Заметки" }, { slug: "section-abc", name: "Рецепты", own: true }];
  const request = jest.fn()
    .mockResolvedValueOnce(toolResponse("draft_memory_fact", { title: "Борщ", body: "Свёкла и капуста", section: "рецепты", kind: "note", person: null, date: null }))
    .mockResolvedValueOnce(toolResponse("draft_memory_fact", { title: "Велосипед", body: "Сменить цепь", section: "«Гараж»", kind: "note", person: null, date: null }))
    .mockResolvedValueOnce(toolResponse("draft_memory_fact", { title: "Полис", body: "Номер", section: "Документы", kind: "note", person: null, date: null }))
    .mockResolvedValueOnce(final());
  await start({}, request, { propose, sections });
  expect(propose.mock.calls[0][0]).toEqual({ title: "Борщ", body: "Свёкла и капуста", section: "section-abc", kind: "note" });
  expect(propose.mock.calls[1][0]).toEqual({ title: "Велосипед", body: "Сменить цепь", newSection: "Гараж", kind: "note" });
  expect(propose.mock.calls[2][0]).toEqual({ title: "Полис", body: "Номер", kind: "note" });
  const body = JSON.parse(request.mock.calls[0][1].body);
  expect(body.input[0].content).toContain("«Рецепты» (создан пользователем)");
  expect(body.tools.find((t: any) => t.name === "draft_memory_fact").parameters.properties.section.description).toContain("«Рецепты»");
});

test("a proposed fact carries its type, person and date; invalid values are dropped, never trusted", async () => {
  const propose = jest.fn();
  const request = jest.fn()
    .mockResolvedValueOnce(toolResponse("draft_memory_fact", { title: "Аня любит кофе", body: "Сестра Аня пьёт капучино", section: "people", kind: "preference", person: "Аня", date: null }))
    .mockResolvedValueOnce(toolResponse("draft_memory_fact", { title: "Паспорт", body: "Номер", section: "documents", kind: "document", person: "null", date: "2026-02-30" }))
    .mockResolvedValueOnce(final());
  await start({}, request, { propose });
  expect(propose).toHaveBeenCalledWith({ title: "Аня любит кофе", body: "Сестра Аня пьёт капучино", section: "people", kind: "preference", person: "Аня" });
  expect(propose).toHaveBeenCalledWith({ title: "Паспорт", body: "Номер" });
});

test("long note proposals are preserved through Responses tool arguments", async () => {
  const longBody = "Ингредиенты и слои. ".repeat(350) + "Конец рецепта.";
  expect(JSON.stringify({ title: "Рецепт", body: longBody }).length).toBeGreaterThan(5000);
  const transport = jest.fn().mockResolvedValueOnce(toolResponse("draft_memory_fact", { title: "Рецепт", body: longBody }))
    .mockResolvedValueOnce(final("Предложил сохранить рецепт"));
  const propose = jest.fn();
  await start({}, transport, { propose });
  expect(propose).toHaveBeenCalledWith(expect.objectContaining({ title: "Рецепт", body: longBody }));
});

test("neither Responses nor compatible endpoints silently slice a long submitted transcript", async () => {
  const prompt = "Текст рецепта. ".repeat(400) + "Заправка в самом конце.";
  expect(prompt.length).toBeGreaterThan(4000);
  const request = jest.fn().mockResolvedValue(final());
  await start({}, request, { prompt });
  const sent = JSON.parse(request.mock.calls[0][1].body);
  expect(sent.input.at(-1).content).toContain("Заправка в самом конце.");

  const response = jest.fn().mockResolvedValue({ ok: true, status: 200,
    json: async () => ({ choices: [{ message: { role: "assistant", content: "Получено" } }] }) });
  await start({ provider: "openai-compatible", baseUrl: "https://example.com/v1", model: "test-model" }, response, { prompt });
  const compatible = JSON.parse(response.mock.calls[0][1].body);
  expect(compatible.messages.at(-1).content).toContain("Заправка в самом конце.");
});

test.each(['openai','compatible','anthropic'] as const)('actual %s transport receives current and historical attachments', async provider=>{
  const transport=jest.fn().mockResolvedValue({ok:true,status:200,json:async()=>provider==='openai'? {status:'completed',output:[{type:'message',content:[{type:'output_text',text:'Done'}]}]} : provider==='anthropic'? {content:[{type:'text',text:'Done'}]} : {choices:[{message:{role:'assistant',content:'Done'}}]}});
  const file={id:'f',name:'x.png',kind:'image' as const,mime:'image/png',data:'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aVz8AAAAASUVORK5CYII=',size:68};
  await start({provider:provider==='compatible'?'openai-compatible':provider,baseUrl:'https://example.com/v1'},transport,{prompt:'Опиши',attachments:[file],history:[{role:'user',content:'Первый снимок',attachments:[file]}]});
  const body=JSON.parse(transport.mock.calls[0][1].body),messages=body.input||body.messages;
  expect(JSON.stringify(messages)).toContain(file.data);
  const users=messages.filter((m:any)=>m.role==='user');expect(users).toHaveLength(2);
  for(const message of users){expect(Array.isArray(message.content)).toBe(true);expect(message.attachments).toBeUndefined();}
});


test("read_local_note uses an OpenAI strict-compatible schema and nullable pagination", async () => {
  const transport = jest.fn().mockResolvedValueOnce(toolResponse("read_local_note",
    { id: "note-1", version: 2, offset: null, budget: null }))
    .mockResolvedValueOnce(final("Прочитано"));
  const read = jest.fn().mockResolvedValue({
    id: "note-1", revision: 2, content: "Достоверная выдержка", hasMore: false,
  });
  await start({}, transport, { read });
  const tools = JSON.parse(transport.mock.calls[0][1].body).tools;
  const tool = tools.find((x: any) => x.name === "read_local_note");
  expect(tool.parameters.required).toEqual(["id", "version", "offset", "budget"]);
  expect(tool.parameters.properties.offset.type).toEqual(["integer", "null"]);
  expect(read).toHaveBeenCalledWith("note-1", 2, 0, 4000);
});
