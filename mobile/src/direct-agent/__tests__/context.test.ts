import { prepareDirectContext } from "../context";
import { defaultDirectPreferences } from "../settings";
const defaults = { ...defaultDirectPreferences, provider: "openai-compatible" as const, searchProvider: "public" as const,
  apiKey: "key", webSearchKey: "", allowWeb: true };
const options = (prompt: string, lookup: jest.Mock, transport: jest.Mock) => ({ settings: defaults, prompt, lookup, transport, history: [], propose: jest.fn() });
const rss = '<rss><channel><item><title>Источник</title><link>https://example.org/reference</link><description>Данные &amp; факты</description></item></channel></rss>';
test("memory is checked before any search; matching notes avoid external search", async () => {
  const lookup = jest.fn(async () => [{ id: "note", title: "Рецепт", body: "Индейка" }]); const transport = jest.fn();
  const context = await prepareDirectContext(options("Вспомни рецепт индейки", lookup, transport));
  expect(lookup).toHaveBeenCalled(); expect(transport).not.toHaveBeenCalled();
  expect(context.context).toContain("Индейка");
});
test("public search needs no key and runs after memory when no matching data exists", async () => {
  const order: string[] = [];
  const lookup = jest.fn(async () => { order.push("memory"); return []; });
  const transport = jest.fn(async (..._args: any[]) => { order.push("web"); return { ok: true, text: async () => rss }; });
  const context = await prepareDirectContext(options("Расскажи про остров", lookup, transport));
  expect(order).toEqual(["memory", "web"]); expect(context.sources).toEqual(["https://example.org/reference"]);
  expect(transport.mock.calls[0][0]).toContain("bing.com/search?format=rss");
  expect(transport.mock.calls[0][1].headers).not.toHaveProperty("Authorization");
});
test("freshness requests search even with memory, but per-message denial always disables web", async () => {
  const lookup = jest.fn(async () => [{ id: "1", title: "Погода", body: "Ранее" }]);
  const transport = jest.fn(async () => ({ ok: true, text: async () => rss }));
  await prepareDirectContext(options("Какая погода сегодня?", lookup, transport));
  expect(transport).toHaveBeenCalledTimes(1); transport.mockClear();
  await prepareDirectContext(options("Не используй интернет, расскажи про погоду сегодня", lookup, transport));
  expect(transport).not.toHaveBeenCalled();
});
test("blocked public feeds fail clearly, never switch to another provider silently", async () => {
  const transport = jest.fn(async () => ({ ok: true, text: async () => '<html>captcha</html>' }));
  await expect(prepareDirectContext(options("Найди информацию", jest.fn(async () => []), transport))).rejects.toThrow("Поисковый сервис");
  expect(transport).toHaveBeenCalledTimes(1);
});
