import { DurableVectorJobs } from "../vector-jobs";
import { SqliteMemoryRepository } from "../repository";
import { SCHEMA_SQL } from "../storage";

jest.mock("expo-crypto", () => ({
  randomUUID: () => "qa-" + Math.random().toString(36).slice(2),
}));

const { DatabaseSync } = require("node:sqlite");
class TestDb {
  sqlite = new DatabaseSync(":memory:");
  constructor() { this.sqlite.exec("PRAGMA foreign_keys=ON;" + SCHEMA_SQL); }
  async getFirstAsync<T>(sql: string, params: unknown[] = []): Promise<T | null> {
    return (this.sqlite.prepare(sql).get(...params) as T) ?? null;
  }
  async getAllAsync<T>(sql: string, params: unknown[] = []): Promise<T[]> {
    return this.sqlite.prepare(sql).all(...params) as T[];
  }
  async runAsync(sql: string, params: unknown[] = []): Promise<{ changes: number }> {
    return { changes: Number(this.sqlite.prepare(sql).run(...params).changes) };
  }
  async execAsync(sql: string): Promise<void> { this.sqlite.exec(sql); }
  close() { this.sqlite.close(); }
}

const vector = () => new Float32Array([1, 0, 0]);
async function setup() {
  const db = new TestDb();
  const repo = new SqliteMemoryRepository(db as never);
  const collection = await repo.createCollection({ name: "Notes", slug: "notes", sensitivity: "standard" });
  const note = await repo.createEntity({
    collection_id: collection.id, domain: "notes", title: "Лиза",
    payload: { body: "Первый разговор" },
  });
  const jobs = new DurableVectorJobs(db as never);
  return { db, repo, note, jobs };
}

test("encrypted-DB job bootstrap, completion, no source change and no duplicate work", async () => {
  const { db, repo, jobs, note } = await setup();
  try {
    const claimed = await jobs.claim("toy", 4);
    expect(claimed).toHaveLength(1);
    expect(claimed[0].text).toContain("Первый разговор");
    expect(await jobs.complete("toy", [{ job: claimed[0], vector: vector() }])).toBe(1);
    expect(await jobs.claim("toy")).toEqual([]);
    expect(await jobs.nextWakeMs("toy")).toBeNull();
    expect(await repo.vectorStatus("toy")).toEqual({ done: 1, total: 1 });
    expect((await repo.entity(note.id))?.payload.body).toBe("Первый разговор");
  } finally { db.close(); }
});

test("lease stays on disk; process restart/expiry reclaims it; old owner cannot commit", async () => {
  const { db, repo, jobs, note } = await setup();
  try {
    const old = (await jobs.claim("toy"))[0];
    expect(await new DurableVectorJobs(db as never).claim("toy")).toEqual([]);
    await db.runAsync("UPDATE memory_vector_jobs SET lease_until='2000-01-01T00:00:00.000Z' WHERE chunk_id=?", [old.chunkId]);
    const reclaimed = (await new DurableVectorJobs(db as never).claim("toy"))[0];
    expect(reclaimed.generation).toBe(old.generation);
    expect(reclaimed.token).not.toBe(old.token);
    expect(await jobs.complete("toy", [{ job: old, vector: vector() }])).toBe(0);
    expect(await jobs.complete("toy", [{ job: reclaimed, vector: vector() }])).toBe(1);
    expect((await repo.entity(note.id))?.payload.body).toBe("Первый разговор");
  } finally { db.close(); }
});

test("concurrent edit invalidates a claimed vector atomically with FTS, CAS and job generation", async () => {
  const { db, repo, jobs, note } = await setup();
  try {
    const old = (await jobs.claim("toy"))[0];
    const revised = await repo.reviseEntity(note.id, 1,
      { title: "Лиза", body: "Другой разговор" }, "User correction");
    expect(revised.record_version).toBe(2);
    expect(await jobs.complete("toy", [{ job: old, vector: vector() }])).toBe(0);
    expect(await repo.vectorStatus("toy")).toEqual({ done: 0, total: 1 });
    const fresh = (await jobs.claim("toy"))[0];
    expect(fresh.hash).not.toBe(old.hash);
    // FTS reindex drops/recreates the chunk, so FK cascade resets generation;
    // an unrelated fresh lease token still prevents the ABA save.
    expect(fresh.token).not.toBe(old.token);
    expect(await jobs.complete("toy", [{ job: fresh, vector: vector() }])).toBe(1);
    expect(await repo.searchNotes("Первый разговор")).toEqual([]);
    expect((await repo.searchNotes("Другой разговор"))[0].id).toBe(note.id);
  } finally { db.close(); }
});

test("native embedding failure waits before retry; graceful release does not lose work", async () => {
  const { db, jobs } = await setup();
  try {
    const first = (await jobs.claim("toy"))[0];
    await jobs.fail("toy", [first]);
    expect(await jobs.claim("toy")).toEqual([]);
    expect(await jobs.nextWakeMs("toy")).toBeGreaterThan(0);
    await db.runAsync("UPDATE memory_vector_jobs SET available_at='2000-01-01T00:00:00.000Z'");
    const retry = (await jobs.claim("toy"))[0];
    expect(retry.token).not.toBe(first.token);
    await jobs.release("toy", [retry]);
    const resumed = (await jobs.claim("toy"))[0];
    expect(resumed.chunkId).toBe(first.chunkId);
    expect(await jobs.complete("toy", [{ job: resumed, vector: vector() }])).toBe(1);
  } finally { db.close(); }
});

test("switching a model and editing while another is active triggers a fresh bounded scan", async () => {
  const { db, repo, jobs, note } = await setup();
  try {
    const a = (await jobs.claim("model-A"))[0];
    await jobs.complete("model-A", [{ job: a, vector: vector() }]);
    const b = (await jobs.claim("model-B"))[0];
    await jobs.complete("model-B", [{ job: b, vector: vector() }]);
    await repo.reviseEntity(note.id, 1, { title: "Лиза", body: "Совсем новая встреча" }, "Updated");
    const aAgain = (await jobs.claim("model-A"))[0];
    expect(aAgain.hash).not.toBe(a.hash);
    expect(await jobs.complete("model-A", [{ job: aAgain, vector: vector() }])).toBe(1);
  } finally { db.close(); }
});

test("unarchived source gets fresh work even after bootstrap cursor is complete", async () => {
  const { db, repo, jobs, note } = await setup();
  try {
    const old = (await jobs.claim("toy"))[0];
    const archived = await repo.setEntityStatus(note.id, 1, "archived");
    expect(await jobs.complete("toy", [{ job: old, vector: vector() }])).toBe(0);
    expect(await jobs.claim("toy")).toEqual([]);
    await repo.setEntityStatus(note.id, archived.record_version, "active");
    const fresh = (await jobs.claim("toy"))[0];
    expect(fresh.chunkId).toBe(old.chunkId);
    expect(fresh.generation).toBeGreaterThan(old.generation);
    expect(await jobs.complete("toy", [{ job: fresh, vector: vector() }])).toBe(1);
  } finally { db.close(); }
});

test("archived pending work does not cause a wake-up spin", async () => {
  const { db, repo, jobs, note } = await setup();
  try {
    const claimed = (await jobs.claim("toy"))[0];
    await jobs.release("toy", [claimed]);
    await repo.setEntityStatus(note.id, 1, "archived");
    expect(await jobs.claim("toy")).toEqual([]);
    expect(await jobs.nextWakeMs("toy")).toBeNull();
  } finally { db.close(); }
});

test("title-only edit keeps chunk id but increments CAS generation", async () => {
  const { db, repo, jobs, note } = await setup();
  try {
    const first = (await jobs.claim("toy"))[0];
    await repo.reviseEntity(note.id, 1,
      { title: "Другой заголовок", body: "Первый разговор" }, "Retitle");
    expect(await jobs.complete("toy", [{ job: first, vector: vector() }])).toBe(0);
    const next = (await jobs.claim("toy"))[0];
    expect(next.chunkId).toBe(first.chunkId);
    expect(next.generation).toBeGreaterThan(first.generation);
    expect(next.hash).not.toBe(first.hash);
  } finally { db.close(); }
});
