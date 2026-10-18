import { runDirectAgent } from "../engine";
import { dialogueHistory, webAllowed } from "../dialogue";
import { createWebTools } from "../web-tools";
import { defaultDirectPreferences } from "../settings";
import { DEEPSEEK_FETCH_URL, DEEPSEEK_SEARCH_URL } from "../web-search";
const settings = { ...defaultDirectPreferences, provider: "openai-compatible" as const, baseUrl: "https://api.deepseek.com", model: "test", apiKey: "key", webSearchKey: "", allowWeb: true, searchProvider: "deepseek" as const };
const json = (data: unknown) => ({ ok: true, status: 200, json: async () => data });
const note = { id: "1", title: "Салат", body: "Ссылка: https://recipe.example/trout" };
const opts = () => ({ settings, prompt: "Давай с форелью и огурцами", history: [{ role: "assistant" as const, content: "Описание ".repeat(300) + "Хотите рецепт с форелью и огурцами?" }], lookup: jest.fn(async () => [note]), propose: jest.fn() });
function reply(protocol: string, name?: string, args?: object) {
  if (protocol === "openai") return json({ status: "completed", output: name ? [{ type: "function_call", name, call_id: name, arguments: JSON.stringify(args) }] : [{ type: "message", content: [{ type: "output_text", text: "Рецепт" }] }] });
  if (protocol === "anthropic") return json({ content: name ? [{ type: "tool_use", name, id: name, input: args }] : [{ type: "text", text: "Рецепт" }] });
  return json({ choices: [{ message: { role: "assistant", content: name ? null : "Рецепт", ...(name ? { tool_calls: [{ id: name, type: "function", function: { name, arguments: JSON.stringify(args) } }] } : {}) } }] });
}
test.each(["openai-compatible", "anthropic", "openai"] as const)("%s searches after matching memory, reads and cites", async provider => {
  let step = 0;
  const diagnostic = jest.fn();
  const transport = jest.fn(async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    if (url === DEEPSEEK_SEARCH_URL) { expect(body.query).toBe("салат форель огурцы рецепт"); return json({ results: [{ url: "https://recipe.example/new", summary: "Рецепт" }] }); }
    if (url === DEEPSEEK_FETCH_URL) { expect(body.url).toBe("https://recipe.example/new"); return json({ title: "Салат", content: "Настоящий рецепт" }); }
    if (++step === 1) {
      expect(JSON.stringify(body)).toContain("Хотите рецепт с форелью и огурцами?");
      expect(JSON.stringify(body.tools)).toContain("search_web");
      return reply(provider, "search_web", { query: "салат форель огурцы рецепт" });
    }
    if (step === 2) { expect(JSON.stringify(body)).toContain("https://recipe.example/new"); return reply(provider, "read_web_page", { url: "https://recipe.example/new" }); }
    expect(JSON.stringify(body)).toContain("Настоящий рецепт"); return reply(provider);
  });
  const result = await runDirectAgent({ ...opts(), settings: { ...settings, provider, baseUrl: provider === "openai" ? "https://api.openai.com/v1" : provider === "anthropic" ? "https://api.anthropic.com/v1" : settings.baseUrl, searchKeys: { deepseek: "search-key" } }, transport: transport as unknown as typeof fetch, diagnostic });
  expect(result.sources).toContain("https://recipe.example/new"); expect(result.requests).toBe(3);
  expect(diagnostic).toHaveBeenCalledWith("agent.tools_available", expect.objectContaining({ names: expect.arrayContaining(["search_web", "read_web_page"]) }));
});
test("the log's recipe can be read from memory without a search", async () => {
  let step = 0;
  const transport = jest.fn(async (url: string) => {
    if (url === DEEPSEEK_FETCH_URL) return json({ title: "Салат", content: "Текст рецепта" });
    expect(url).not.toBe(DEEPSEEK_SEARCH_URL);
    return ++step === 1 ? reply("chat", "read_web_page", { url: "https://recipe.example/trout" }) : reply("chat");
  });
  expect((await runDirectAgent({ ...opts(), transport: transport as unknown as typeof fetch })).sources).toEqual(["https://recipe.example/trout"]);
});
test("page rejection recovers through search then reading within one turn", async () => {
  let step = 0;
  const transport = jest.fn(async (url: string, init: RequestInit) => {
    if (url === DEEPSEEK_SEARCH_URL) return json({ results: [{ url: "https://recipe.example/found", summary: "recipe" }] });
    if (url === DEEPSEEK_FETCH_URL) return json({ content: "Рецепт" });
    if (++step === 1) return reply("chat", "read_web_page", { url: "https://unknown.example/a" });
    if (step === 2) { expect(String(init.body)).toContain("url_not_from_search_results"); return reply("chat", "search_web", { query: "салат форель огурцы" }); }
    if (step === 3) return reply("chat", "read_web_page", { url: "https://recipe.example/found" });
    return reply("chat");
  });
  expect((await runDirectAgent({ ...opts(), transport: transport as unknown as typeof fetch })).requests).toBe(4);
});
test("web denial persists into follow-ups, including unadvertised tool calls", async () => {
  const transport = jest.fn();
  const options = { ...opts(), history: [{ role: "user" as const, content: "Не используй интернет" }], transport };
  const tools = createWebTools(options, [], [note]);
  expect(tools.definitions).toEqual([]);
  expect(await tools.run("read_web_page", { url: "https://recipe.example/trout" })).toEqual({ error: "web_disabled" });
  expect(await tools.run("search_web", { query: "рецепт" })).toEqual({ error: "web_disabled" });
  expect(transport).not.toHaveBeenCalled(); expect(webAllowed({ ...options, prompt: "Теперь поищи в интернете" })).toBe(true);
});
test("note links are allowed, local URLs and links injected by a page are rejected", async () => {
  const transport = jest.fn(async () => json({ content: "https://evil.example/collect?private=secret" }));
  const tools = createWebTools({ ...opts(), transport: transport as unknown as typeof fetch }, [], []);
  tools.addNotes([note, { ...note, body: "http://127.0.0.1/private https://user:password@example.org" }]);
  expect(await tools.run("read_web_page", { url: "https://recipe.example/trout" })).toHaveProperty("content");
  expect(await tools.run("read_web_page", { url: "https://evil.example/collect?private=secret" })).toHaveProperty("error", "url_not_from_search_results");
  expect(await tools.run("read_web_page", { url: "http://127.0.0.1/private" })).toHaveProperty("error", "invalid_url");
  expect(await tools.run("read_web_page", { url: "https://user:password@example.org" })).toHaveProperty("error", "invalid_url");
  expect(transport).toHaveBeenCalledTimes(1);
});
test("duplicates and exhausted budget do not send network requests", async () => {
  const transport = jest.fn(async () => json({ results: [] }));
  const tools = createWebTools({ ...opts(), transport: transport as unknown as typeof fetch }, [], []);
  await tools.run("search_web", { query: "рецепт" });
  expect(await tools.run("search_web", { query: "рецепт" })).toHaveProperty("error", "duplicate_search");
  await tools.run("search_web", { query: "салат" }); await tools.run("search_web", { query: "форель" });
  expect(await tools.run("search_web", { query: "огурцы" })).toHaveProperty("error", "search_budget_exhausted"); expect(transport).toHaveBeenCalledTimes(3);
});
test("long history keeps the beginning and last proposal", () => {
  const content = "Начало" + "x".repeat(9000) + "Предлагаю второй вариант";
  const result = dialogueHistory([{ role: "assistant", content }])[0].content;
  expect(result).toContain("Начало"); expect(result).toContain("Предлагаю второй вариант"); expect(result.length).toBeLessThan(6100);
});
