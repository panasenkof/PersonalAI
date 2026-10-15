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
test("public search needs no key and runs after memory when the user asks for it", async () => {
  const order: string[] = [];
  const lookup = jest.fn(async () => { order.push("memory"); return []; });
  const transport = jest.fn(async (..._args: any[]) => { order.push("web"); return { ok: true, text: async () => rss }; });
  const context = await prepareDirectContext(options("Найди в интернете про остров", lookup, transport));
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
test("blocked public feeds are reported, never switch to another provider silently", async () => {
  const transport = jest.fn(async () => ({ ok: true, text: async () => '<html>captcha</html>' }));
  const context = await prepareDirectContext(options("Найди в интернете информацию", jest.fn(async () => []), transport));
  expect(context.webError).toContain("Поисковый сервис");
  expect(context.context).toContain("свежие данные не проверены");
  expect(transport).toHaveBeenCalledTimes(1);
});
test("an unanswered search is cut off and reported instead of stalling the answer", async () => {
  const transport = jest.fn((_url: string, init: any) => new Promise((_resolve, reject) => init.signal.addEventListener("abort", () => reject(new Error("aborted")))));
  const started = Date.now();
  const context = await prepareDirectContext(options("Найди в интернете новости", jest.fn(async () => []), transport as any));
  expect(context.webError).toContain("www.bing.com: ответ не завершился за 12 с");
  expect(Date.now() - started).toBeLessThan(13_500);
}, 20_000);
test("memory comes first: the user hears it found nothing, then the web is searched", async () => {
  const notify = jest.fn(); const order: string[] = [];
  const lookup = jest.fn(async () => { order.push("memory"); return []; });
  const transport = jest.fn(async () => { order.push("web"); return { ok: true, text: async () => rss }; });
  await prepareDirectContext({ ...options("Расскажи про остров Пасхи", lookup, transport), notify });
  expect(order).toEqual(["memory", "web"]);
  expect(notify).toHaveBeenCalledWith("В памяти ничего не нашлось. Ищу в интернете.");
});
test("with web search off the user is told memory had nothing and why the web was not used", async () => {
  const notify = jest.fn(); const transport = jest.fn();
  await prepareDirectContext({ ...options("Расскажи про остров", jest.fn(async () => []), transport), settings: { ...defaults, allowWeb: false }, notify });
  expect(transport).not.toHaveBeenCalled();
  expect(notify.mock.calls[0][0]).toContain("Интернет-поиск выключен");
});
test("questions about the user are answered from memory only", async () => {
  const notify = jest.fn(); const transport = jest.fn();
  await prepareDirectContext({ ...options("Что ты помнишь обо мне?", jest.fn(async () => []), transport), notify });
  expect(transport).not.toHaveBeenCalled();
  expect(notify.mock.calls[0][0]).toContain("Расскажите о себе");
});
