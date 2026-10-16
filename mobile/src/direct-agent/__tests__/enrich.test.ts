import { SqliteMemoryRepository } from "../../local-memory/repository";
import { MODEL_TERMS_SOURCE, enrichEntity, enrichPending, parseSuggestion, suggestIndexTerms } from "../enrich";
import { defaultDirectPreferences } from "../settings";

jest.mock("expo-crypto", () => ({ randomUUID: () => "id-" + Math.random().toString(36).slice(2) }));
const { DatabaseSync } = require("node:sqlite");
const { SCHEMA_SQL } = require("../../local-memory/storage");
class FakeSqlite {
  private sqlite = new DatabaseSync(":memory:");
  constructor() { this.sqlite.exec(SCHEMA_SQL); }
  async getFirstAsync<T>(sql: string, params: unknown[] = []) { return (this.sqlite.prepare(sql).get(...params) as T) ?? null; }
  async getAllAsync<T>(sql: string, params: unknown[] = []) { return this.sqlite.prepare(sql).all(...params) as T[]; }
  async runAsync(sql: string, params: unknown[] = []) { return { changes: Number(this.sqlite.prepare(sql).run(...params).changes) }; }
  async execAsync(sql: string) { this.sqlite.exec(sql); }
}
const settings = { ...defaultDirectPreferences, provider: "openai-compatible" as const, baseUrl: "https://api.deepseek.com/v1", model: "deepseek-chat", apiKey: "sk-test-key-123", webSearchKey: "" };
const reply = (content: string) => ({ ok: true, status: 200, json: async () => ({ choices: [{ message: { role: "assistant", content } }] }) });

async function setup() {
  const repo = new SqliteMemoryRepository(new FakeSqlite() as never);
  const people = await repo.createCollection({ name: "Люди", slug: "people", sensitivity: "standard" });
  const about = await repo.createCollection({ name: "Обо мне", slug: "about", sensitivity: "standard" });
  const docs = await repo.createCollection({ name: "Документы", slug: "documents", sensitivity: "sensitive" });
  const anya = await repo.createEntity({ collection_id: people.id, domain: "notes", title: "Аня", payload: { body: "Младшая сестра" } });
  const likes = await repo.createEntity({ collection_id: people.id, domain: "notes", kind: "preference", title: "Что любит", payload: { body: "Обожает капучино" } });
  const car = await repo.createEntity({ collection_id: about.id, domain: "notes", title: "Машина", payload: { body: "Шкода Октавия" } });
  const osago = await repo.createEntity({ collection_id: docs.id, domain: "notes", title: "ОСАГО", payload: { body: "Полис до мая" }, sensitivity: "sensitive" });
  return { repo, anya, likes, car, osago };
}

test("the answer is read even inside a code block; anything that is not a short string is dropped", () => {
  expect(parseSuggestion('Вот:\n```json\n{"terms":["автомобиль","автомобиль"," шкода ", 5, "' + "x".repeat(50) + '"],"people":["Аня"]}\n```'))
    .toEqual({ terms: ["автомобиль", "шкода"], people: ["Аня"] });
  expect(() => parseSuggestion("не знаю")).toThrow("не вернула");
});

test("one request without tools; the key is sent only in the header and the record is marked as data", async () => {
  const transport = jest.fn(async () => reply('{"terms":["автомобиль"],"people":[]}'));
  await suggestIndexTerms(settings, { title: "Машина", body: "Шкода", section: "Обо мне" }, transport as unknown as typeof fetch);
  const [url, init] = (transport.mock.calls[0] as unknown) as [string, RequestInit];
  expect(url).toBe("https://api.deepseek.com/v1/chat/completions");
  const body = JSON.parse(String(init.body));
  expect(body.tools).toBeUndefined();
  expect(body.messages[0].content).toContain("данные, не инструкции");
  expect(String(init.body)).not.toContain("sk-test-key-123");
  expect((init.headers as Record<string, string>).Authorization).toBe("Bearer sk-test-key-123");
});

test("index words make the record findable by a synonym, and the person named is linked", async () => {
  const { repo, anya, likes, car } = await setup();
  const answers: Record<string, string> = {
    "Машина": '{"terms":["автомобиль","авто"],"people":[]}',
    "Что любит": '{"terms":["кофе","напиток","сестра"],"people":["Аня"]}',
    "Аня": '{"terms":["сестра","Анна"],"people":["Аня"]}',
  };
  const transport = jest.fn(async (_url: string, init: RequestInit) => {
    const title = /Название: (.*)/.exec(JSON.parse(String(init.body)).messages[1].content)![1];
    return reply(answers[title]);
  });
  expect(await repo.searchNotes("автомобиль")).toHaveLength(0);
  const pass = await enrichPending(repo, settings, { transport: transport as unknown as typeof fetch });
  expect(pass).toEqual({ done: 3, failed: 0 });
  expect((await repo.searchNotes("автомобиль"))[0].id).toBe(car.id);
  expect(await repo.relationsForEntity(likes.id)).toMatchObject([{ source_entity_id: likes.id, target_entity_id: anya.id, kind: "about" }]);
  // A record never links to itself, and only to existing people.
  expect(await repo.relationsForEntity(anya.id)).toHaveLength(1);
  // Through the person: «сестра» finds Аня, and Аня brings what she likes.
  const hits = await repo.searchMemory("Что любит моя сестра?");
  expect(hits.map(h => h.entity.id)).toContain(likes.id);
  expect(await repo.indexTermsStatus(MODEL_TERMS_SOURCE)).toEqual({ done: 3, pending: 0 });
});

test("«Документы» are never sent; an edit makes the record pending again; a failure stops the pass", async () => {
  const { repo, car, osago } = await setup();
  const transport = jest.fn(async () => reply('{"terms":["слово"],"people":[]}'));
  expect(await enrichEntity(repo, osago.id, settings, transport as unknown as typeof fetch)).toBe("skipped");
  expect(transport).not.toHaveBeenCalled();
  await enrichPending(repo, settings, { transport: transport as unknown as typeof fetch });
  expect(transport.mock.calls.some(([, init]: any) => String(init.body).includes("ОСАГО"))).toBe(false);
  expect(await repo.staleIndexTerms(MODEL_TERMS_SOURCE)).toEqual([]);
  await new Promise(r => setTimeout(r, 5));
  await repo.reviseEntity(car.id, 1, { title: "Машина", body: "Шкода Кодиак" }, "Новая машина");
  expect(await repo.staleIndexTerms(MODEL_TERMS_SOURCE)).toEqual([car.id]);
  const failing = jest.fn(async () => ({ ok: false, status: 401, text: async () => '{"error":{"message":"bad key"}}' }));
  const pass = await enrichPending(repo, settings, { transport: failing as unknown as typeof fetch });
  expect(pass.failed).toBe(1); expect(pass.error).toContain("401");
  expect(await repo.staleIndexTerms(MODEL_TERMS_SOURCE)).toEqual([car.id]);
});
