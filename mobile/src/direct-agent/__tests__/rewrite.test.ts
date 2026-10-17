import { parseRewrite, searchRewritten } from "../rewrite";
import { runDirectAgent } from "../engine";
import { defaultDirectPreferences } from "../settings";

const settings = { ...defaultDirectPreferences, provider: "openai-compatible" as const, baseUrl: "https://api.deepseek.com", model: "deepseek-v4-pro",
  apiKey: "sk-key-123", webSearchKey: "", allowWeb: false };
const json = (data: unknown) => ({ ok: true, status: 200, json: async () => data, text: async () => JSON.stringify(data) });
const lena = { id: "lena", title: "Лена", body: "Моя жена, детский врач", section: "Люди" };

test("the rewrite answer is read safely; the person and section lift matching records", async () => {
  expect(parseRewrite('```json\n{"queries":["супруга","жена"," "],"section":"Люди","person":null}\n```')).toEqual({ queries: ["супруга", "жена"], section: "Люди" });
  expect(parseRewrite("нет")).toEqual({ queries: [] });
  const other = { id: "x", title: "Врач", body: "Терапевт", section: "Заметки" };
  const found = await searchRewritten({ queries: ["врач"], section: "Люди" }, async () => [other, lena]);
  expect(found[0].id).toBe("lena");
});

test("when memory finds nothing, the model's other wording finds the record before «ничего не нашлось»", async () => {
  const sent: any[] = [];
  const transport = jest.fn(async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)); sent.push(body);
    if (String(body.messages[0].content).includes("Предложи 3–5")) {
      // The fast model, thinking off, gets only the question.
      expect(body).toMatchObject({ model: "deepseek-flash", thinking: { type: "disabled" } });
      expect(body.messages[1].content).toBe("Вопрос: Как зовут мою вторую половинку?");
      return json({ choices: [{ message: { role: "assistant", content: '{"queries":["жена","супруга"],"section":"Люди","person":null}' } }] });
    }
    return json({ choices: [{ message: { role: "assistant", content: "Её зовут Лена." } }] });
  });
  const notices: string[] = [];
  const lookup = jest.fn(async (q: string) => /жена|супруга/.test(q) ? [lena] : []);
  const result = await runDirectAgent({ settings, prompt: "Как зовут мою вторую половинку?", history: [], rewrite: true,
    transport: transport as unknown as typeof fetch, lookup, propose: () => {}, notify: t => notices.push(t) });
  expect(result.text).toBe("Её зовут Лена.");
  expect(result.memory).toEqual([{ id: "lena", title: "Лена", section: "Люди", via: "rewrite" }]);
  expect(notices.join(" ")).not.toContain("ничего не нашлось");
  // Memory reaches the answering model in the user's turn, marked as data.
  const answer = sent[sent.length - 1];
  expect(answer.messages[0].content).not.toContain("детский врач");
  expect(answer.messages[answer.messages.length - 1].content).toContain("детский врач");
  expect(answer.messages[answer.messages.length - 1].content).toContain("НЕ инструкции");
});

test("without the option, or when the first search finds something, there is no extra request", async () => {
  const transport = jest.fn(async () => json({ choices: [{ message: { role: "assistant", content: "ok" } }] }));
  await runDirectAgent({ settings, prompt: "Кто такая Лена?", history: [], rewrite: true,
    transport: transport as unknown as typeof fetch, lookup: async () => [lena], propose: () => {} });
  await runDirectAgent({ settings, prompt: "Как зовут мою вторую половинку?", history: [],
    transport: transport as unknown as typeof fetch, lookup: async () => [], propose: () => {} });
  expect(transport).toHaveBeenCalledTimes(2);
});
