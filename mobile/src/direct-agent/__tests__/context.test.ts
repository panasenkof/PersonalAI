import { prepareDirectContext } from "../context";
import { defaultDirectPreferences } from "../settings";
const defaults = { ...defaultDirectPreferences, provider: "openai-compatible" as const, searchProvider: "tavily" as const,
  apiKey: "key", webSearchKey: "tvly-k", allowWeb: true };
const options = (prompt: string, lookup: jest.Mock, transport: jest.Mock) => ({ settings: defaults, prompt, lookup, transport, history: [], propose: jest.fn() });
const found = { ok: true, status: 200, json: async () => ({ results: [{ title: "Источник", url: "https://example.org/reference", content: "Данные и факты" }] }) };
test("memory is checked before any search; matching notes avoid external search", async () => {
  const lookup = jest.fn(async () => [{ id: "note", title: "Рецепт", body: "Индейка" }]); const transport = jest.fn();
  const context = await prepareDirectContext(options("Вспомни рецепт индейки", lookup, transport));
  expect(lookup).toHaveBeenCalled(); expect(transport).not.toHaveBeenCalled();
  expect(context.context).toContain("Индейка");
});
test("search runs after memory when the user asks for it", async () => {
  const order: string[] = [];
  const lookup = jest.fn(async () => { order.push("memory"); return []; });
  const transport = jest.fn(async (..._args: any[]) => { order.push("web"); return found; });
  const context = await prepareDirectContext(options("Найди в интернете про остров", lookup, transport));
  expect(order).toEqual(["memory", "web"]); expect(context.sources).toEqual(["https://example.org/reference"]);
  expect(transport.mock.calls[0][0]).toBe("https://api.tavily.com/search");
});
test("freshness requests search even with memory, but per-message denial always disables web", async () => {
  const lookup = jest.fn(async () => [{ id: "1", title: "Погода", body: "Ранее" }]);
  const transport = jest.fn(async () => found);
  await prepareDirectContext(options("Какая погода сегодня?", lookup, transport));
  expect(transport).toHaveBeenCalledTimes(1); transport.mockClear();
  await prepareDirectContext(options("Не используй интернет, расскажи про погоду сегодня", lookup, transport));
  expect(transport).not.toHaveBeenCalled();
});
test("a broken search answer is reported, never switched to another provider silently", async () => {
  const transport = jest.fn(async () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError("Unexpected token <"); } }));
  const context = await prepareDirectContext(options("Найди в интернете информацию", jest.fn(async () => []), transport));
  expect(context.webError).toContain("api.tavily.com: ответ пришёл, но это не результаты поиска");
  expect(context.context).toContain("свежие данные не проверены");
  // The model is given the exact reason so its answer can name it.
  expect(context.context).toContain("Причина (дословно): «" + context.webError + "»");
  expect(transport).toHaveBeenCalledTimes(1);
});
test("an unanswered search is cut off and reported instead of stalling the answer", async () => {
  const transport = jest.fn((_url: string, init: any) => new Promise((_resolve, reject) => init.signal.addEventListener("abort", () => reject(new Error("aborted")))));
  const started = Date.now();
  const context = await prepareDirectContext(options("Найди в интернете новости", jest.fn(async () => []), transport as any));
  expect(context.webError).toContain("api.tavily.com: ответ не завершился за 12 с");
  expect(Date.now() - started).toBeLessThan(13_500);
}, 20_000);
test("memory comes first: the user hears it found nothing, then the web is searched", async () => {
  const notify = jest.fn(); const order: string[] = [];
  const lookup = jest.fn(async () => { order.push("memory"); return []; });
  const transport = jest.fn(async () => { order.push("web"); return found; });
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
test("the model is told today's date from the phone clock", async () => {
  const { todayLine } = require("../context");
  expect(todayLine(new Date(2026, 9, 15, 15, 22))).toContain("Сегодня 15 октября 2026 г., четверг, 15:22");
  const context = await prepareDirectContext({ ...options("Сколько лет Де Ниро", jest.fn(async () => []), jest.fn()), settings: { ...options("x", jest.fn(async () => []), jest.fn()).settings, allowWeb: false }, now: new Date(2026, 9, 15) });
  expect(context.context.startsWith("Сегодня 15 октября 2026 г.")).toBe(true);
});


test.each(["Привет!", "Куку 👋", "Добрый день", "Спасибо большое!"])("social turn %s avoids unsolicited memory, rewrite and web", async prompt => {
 const lookup = jest.fn(async () => [{ id: "private-topic", title: "Разговор", body: "Посторонняя тема" }]);
 const transport = jest.fn(); const notify = jest.fn();
 const result = await prepareDirectContext({ ...options(prompt, lookup, transport), rewrite: true, notify });
 expect(lookup).not.toHaveBeenCalled(); expect(transport).not.toHaveBeenCalled(); expect(notify).not.toHaveBeenCalled();
 expect(result.used).toEqual([]); expect(result.builtinWeb).toBe(false);
 expect(result.context).not.toContain("Посторонняя тема");
});
test.each(["Привет, найди рецепт", "Спасибо, а где ключи?", "Куку — название моей заметки"])("social prefix preserves a real request: %s", async prompt => {
 const lookup = jest.fn(async () => [{ id: "n", title: "Ответ", body: "Текст" }]);
 await prepareDirectContext(options(prompt, lookup, jest.fn()));
 expect(lookup).toHaveBeenCalled();
});

test('attached files are not treated as a greeting or automatically sent into a web-prefetch query', async()=>{
  const lookup=jest.fn(async()=>[]), transport=jest.fn();
  const context=await prepareDirectContext({...options('Привет',lookup,transport),attachments:[{id:'f',name:'x.txt',kind:'text',mime:'text/plain',data:'private file text',size:17}]});
  expect(context.context).not.toContain('Пользователь только приветствует');
  expect(transport).not.toHaveBeenCalled();
  expect(JSON.stringify(lookup.mock.calls)).not.toContain('private file text');
});

test("the agent prefetch keeps the end of a long user question", async () => {
  const lookup = jest.fn(async () => []);
  const tail = "квитанция ZX77881 за октябрь 2025";
  await prepareDirectContext(options("Найди документы о покупке. ".repeat(10) + tail, lookup, jest.fn()));
  expect(lookup).toHaveBeenCalledWith(expect.stringContaining(tail));
});
