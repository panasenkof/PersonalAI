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
const settings = { ...defaultDirectPreferences, provider: "openai-compatible" as const, baseUrl: "https://llm.example.org/v1", model: "some-model", apiKey: "sk-test-key-123", webSearchKey: "" };
const reply = (content: string) => ({ ok: true, status: 200, json: async () => ({ choices: [{ message: { role: "assistant", content } }] }) });

function delayedReply(content = '{"terms":["устаревшее"],"people":["Аня"]}') {
  let started!: () => void, finish!: (response: ReturnType<typeof reply>) => void;
  const waiting = new Promise<void>(resolve => { started = resolve; });
  const response = new Promise<ReturnType<typeof reply>>(resolve => { finish = resolve; });
  const transport = jest.fn(async () => { started(); return response; }) as unknown as typeof fetch;
  return { waiting, transport, finish: () => finish(reply(content)) };
}

async function setup() {
  const db = new FakeSqlite();
  const repo = new SqliteMemoryRepository(db as never);
  const people = await repo.createCollection({ name: "Люди", slug: "people", sensitivity: "standard" });
  const about = await repo.createCollection({ name: "Обо мне", slug: "about", sensitivity: "standard" });
  const docs = await repo.createCollection({ name: "Документы", slug: "documents", sensitivity: "sensitive" });
  const anya = await repo.createEntity({ collection_id: people.id, domain: "notes", title: "Аня", payload: { body: "Младшая сестра" } });
  const likes = await repo.createEntity({ collection_id: people.id, domain: "notes", kind: "preference", title: "Что любит", payload: { body: "Обожает капучино" } });
  const car = await repo.createEntity({ collection_id: about.id, domain: "notes", title: "Машина", payload: { body: "Шкода Октавия" } });
  const osago = await repo.createEntity({ collection_id: docs.id, domain: "notes", title: "ОСАГО", payload: { body: "Полис до мая" }, sensitivity: "sensitive" });
  return { repo, db, people, about, docs, anya, likes, car, osago };
}

test("the answer is read even inside a code block; anything that is not a short string is dropped", () => {
  expect(parseSuggestion('Вот:\n```json\n{"terms":["автомобиль","автомобиль"," шкода ", 5, "' + "x".repeat(50) + '"],"people":["Аня"]}\n```'))
    .toEqual({ terms: ["автомобиль", "шкода"], people: ["Аня"] });
  expect(() => parseSuggestion("не знаю")).toThrow("не списком слов: «не знаю»");
});

test("one request without tools; the key is sent only in the header and the record is marked as data", async () => {
  const transport = jest.fn(async () => reply('{"terms":["автомобиль"],"people":[]}'));
  await suggestIndexTerms(settings, { title: "Машина", body: "Шкода", section: "Обо мне" }, transport as unknown as typeof fetch);
  const [url, init] = (transport.mock.calls[0] as unknown) as [string, RequestInit];
  expect(url).toBe("https://llm.example.org/v1/chat/completions");
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

test.each(["edit", "archive", "trash", "delete", "move", "private", "rename", "section-private"])(
  "a late answer after %s saves neither words nor inferred links", async change => {
    const { repo, db, car, about, docs } = await setup();
    const delayed = delayedReply();
    const work = enrichEntity(repo, car.id, settings, delayed.transport);
    await delayed.waiting;
    if (change === "edit") await repo.reviseEntity(car.id, 1, { body: "Другая машина" }, "Правка");
    if (change === "archive") await repo.setEntityStatus(car.id, 1, "archived");
    if (change === "trash") await repo.changeNotes("trash", [car]);
    if (change === "delete") await db.runAsync("DELETE FROM memory_entities WHERE id=?", [car.id]);
    if (change === "move") await repo.reviseEntity(car.id, 1, car.payload, "Перенос", docs.id);
    if (change === "private") await db.runAsync("UPDATE memory_entities SET sensitivity='secret' WHERE id=?", [car.id]);
    if (change === "rename") await db.runAsync("UPDATE memory_collections SET name='Автопарк' WHERE id=?", [about.id]);
    if (change === "section-private") await db.runAsync("UPDATE memory_collections SET sensitivity='secret' WHERE id=?", [about.id]);
    delayed.finish();
    expect(await work).toBe("skipped");
    expect(await repo.indexTerms(car.id)).toEqual([]);
    expect(await repo.relationsForEntity(car.id)).toEqual([]);
    expect(await repo.searchNotes("устаревшее")).toEqual([]);
    if (["edit", "rename"].includes(change)) {
      expect(await repo.staleIndexTerms(MODEL_TERMS_SOURCE)).toContain(car.id);
      const fresh = jest.fn(async () => reply('{"terms":["актуальное"],"people":[]}'));
      expect(await enrichEntity(repo, car.id, settings, fresh as unknown as typeof fetch)).toBe("enriched");
      expect((await repo.searchNotes("актуальное"))[0].id).toBe(car.id);
    }
  });

test("same-millisecond edits invalidate model terms but preserve user words and names", async () => {
  const { repo, db, car } = await setup();
  const instant = new Date("2026-10-26T12:00:00.000Z");
  const clock = jest.spyOn(Date.prototype, "toISOString").mockReturnValue(instant.toISOString());
  try {
    await repo.setIndexTerms(car.id, ["ручное"], "user");
    await repo.setAliases(car.id, ["Ласточка"]);
    await enrichEntity(repo, car.id, settings, jest.fn(async () => reply('{"terms":["старое"],"people":[]}')) as unknown as typeof fetch);
    await repo.reviseEntity(car.id, 1, { body: "Новая машина" }, "Правка");
    expect(await repo.searchNotes("старое")).toEqual([]);
    expect((await repo.searchNotes("ручное"))[0].id).toBe(car.id);
    expect((await repo.searchNotes("Ласточка"))[0].id).toBe(car.id);
    expect(await repo.staleIndexTerms(MODEL_TERMS_SOURCE)).toContain(car.id);
    expect(await repo.indexTermsStatus(MODEL_TERMS_SOURCE)).toEqual({ done: 0, pending: 3 });
    // A legacy row's future timestamp is not evidence of a matching source.
    await db.runAsync("UPDATE memory_index_terms SET created_at='2099',source_record_version=NULL WHERE entity_id=? AND source=?", [car.id, MODEL_TERMS_SOURCE]);
    expect(await repo.staleIndexTerms(MODEL_TERMS_SOURCE)).toContain(car.id);
  } finally { clock.mockRestore(); }
});

test.each(["abort", "index-failure"])("%s rolls back words and links together, retaining manual data", async mode => {
  const { repo, db, car, likes } = await setup();
  const manual = await repo.linkEntities(car.id, likes.id, "about");
  await repo.setIndexTerms(car.id, ["ручное"], "user");
  const controller = new AbortController();
  const original = db.runAsync.bind(db);
  jest.spyOn(db, "runAsync").mockImplementation(async (sql, params) => {
    const result = await original(sql, params);
    if (sql.startsWith("INSERT INTO memory_search_fts")) {
      if (mode === "abort") controller.abort(); else throw new Error("disk_full");
    }
    return result;
  });
  const transport = jest.fn(async () => reply('{"terms":["модельное"],"people":["Аня"]}')) as unknown as typeof fetch;
  await expect(enrichEntity(repo, car.id, settings, transport, controller.signal)).rejects.toThrow(mode === "abort" ? "Подбор слов остановлен" : "disk_full");
  expect(await repo.indexTerms(car.id)).toEqual([{ source: "user", terms: ["ручное"] }]);
  expect(await repo.relationsForEntity(car.id)).toEqual([manual]);
  expect(await repo.searchNotes("модельное")).toEqual([]);
  expect((await repo.searchNotes("ручное"))[0].id).toBe(car.id);
});

test("late transport ignores abort, but cancelled enrichment still cannot commit", async () => {
  const { repo, car } = await setup();
  const controller = new AbortController(), delayed = delayedReply();
  const work = enrichEntity(repo, car.id, settings, delayed.transport, controller.signal);
  const rejected = expect(work).rejects.toThrow();
  await delayed.waiting; controller.abort(); delayed.finish(); await rejected;
  expect(await repo.indexTerms(car.id)).toEqual([]);
  expect(await repo.relationsForEntity(car.id)).toEqual([]);
});

test.each(["ambiguous", "protected"])("%s person is not an inferred target", async mode => {
  const { repo, db, car, anya, people } = await setup();
  if (mode === "ambiguous") await repo.createEntity({ collection_id: people.id, domain: "notes", title: "Аня", payload: { body: "Другая Аня" } });
  else await db.runAsync("UPDATE memory_entities SET sensitivity='secret' WHERE id=?", [anya.id]);
  const transport = jest.fn(async () => reply('{"terms":["автомобиль"],"people":["Аня"]}')) as unknown as typeof fetch;
  expect(await enrichEntity(repo, car.id, settings, transport)).toBe("enriched");
  expect(await repo.relationsForEntity(car.id)).toEqual([]);
});

test("re-enrichment replaces only its own links; an edited source no longer expands through old people", async () => {
  const { repo, car, likes, anya } = await setup();
  const manual = await repo.linkEntities(car.id, likes.id, "about");
  const answer = jest.fn(async () => reply('{"terms":[],"people":["Аня"]}')) as unknown as typeof fetch;
  await enrichEntity(repo, car.id, settings, answer);
  await enrichEntity(repo, car.id, settings, answer);
  expect(await repo.relationsForEntity(car.id)).toHaveLength(2);
  expect((await repo.searchMemory("Аня")).map(h => h.entity.id)).toContain(car.id);
  await repo.reviseEntity(car.id, 1, { body: "Другая машина" }, "Правка");
  expect(await repo.relationsForEntity(car.id)).toEqual([manual]);
  expect((await repo.searchMemory("Аня")).map(h => h.entity.id)).not.toContain(car.id);
  const empty = jest.fn(async () => reply('{"terms":[],"people":[]}')) as unknown as typeof fetch;
  await enrichEntity(repo, car.id, settings, empty);
  expect(await repo.relationsForEntity(car.id)).toEqual([manual]);
  expect(await repo.relationsForEntity(anya.id)).toEqual([]);
  expect(await repo.staleIndexTerms(MODEL_TERMS_SOURCE)).not.toContain(car.id);
});

const cut = (content: string, reasoning = "") => ({ ok: true, status: 200, json: async () => ({ choices: [{ finish_reason: "length", message: { role: "assistant", content, reasoning_content: reasoning } }] }) });
test("a thinking model that ran out of tokens is asked again with more room", async () => {
  const transport = jest.fn()
    .mockResolvedValueOnce(cut("", "Подумаем, какие слова…"))
    .mockResolvedValueOnce(reply('{"terms":["автомобиль"],"people":[]}'));
  const thinking = { ...settings, model: "deepseek-v4-pro" };
  expect(await suggestIndexTerms(thinking, { title: "Машина", body: "Шкода", section: "Обо мне" }, transport as unknown as typeof fetch))
    .toEqual({ terms: ["автомобиль"], people: [] });
  const limits = transport.mock.calls.map(([, init]: any) => JSON.parse(String(init.body)).max_tokens);
  expect(limits[1]).toBeGreaterThan(limits[0]);
});
test("an answer left only in the reasoning is used; an empty one names the model and what to do", async () => {
  const onlyReasoning = jest.fn(async () => ({ ok: true, status: 200, json: async () => ({ choices: [{ finish_reason: "stop", message: { role: "assistant", content: "", reasoning_content: 'Итог: {"terms":["авто"],"people":[]}' } }] }) }));
  expect((await suggestIndexTerms(settings, { title: "Машина", body: "Шкода", section: "Обо мне" }, onlyReasoning as unknown as typeof fetch)).terms).toEqual(["авто"]);
  const alwaysCut = jest.fn(async () => cut(""));
  await expect(suggestIndexTerms({ ...settings, model: "deepseek-v4-pro" }, { title: "Машина", body: "Шкода", section: "Обо мне" }, alwaysCut as unknown as typeof fetch))
    .rejects.toThrow("Модель deepseek-v4-pro рассуждала дольше лимита");
  expect(alwaysCut).toHaveBeenCalledTimes(2);
});

test("on DeepSeek's own API index words use the fast model with thinking off and JSON output, same key", async () => {
  const transport = jest.fn(async () => reply('{"terms":["автомобиль"],"people":[]}'));
  const deepseek = { ...settings, baseUrl: "https://api.deepseek.com", model: "deepseek-v4-pro" };
  await suggestIndexTerms(deepseek, { title: "Машина", body: "Шкода", section: "Обо мне" }, transport as unknown as typeof fetch);
  const [url, init] = (transport.mock.calls[0] as unknown) as [string, RequestInit];
  expect(url).toBe("https://api.deepseek.com/chat/completions");
  expect(JSON.parse(String(init.body))).toMatchObject({ model: "deepseek-flash", thinking: { type: "disabled" }, response_format: { type: "json_object" } });
  expect((init.headers as Record<string, string>).Authorization).toBe("Bearer sk-test-key-123");
  // Other services keep the model chosen in the connection and get no DeepSeek-only fields.
  await suggestIndexTerms(settings, { title: "Машина", body: "Шкода", section: "Обо мне" }, transport as unknown as typeof fetch);
  const other = JSON.parse(String(((transport.mock.calls[1] as unknown) as [string, RequestInit])[1].body));
  expect(other.model).toBe("some-model"); expect(other.thinking).toBeUndefined(); expect(other.response_format).toBeUndefined();
});
