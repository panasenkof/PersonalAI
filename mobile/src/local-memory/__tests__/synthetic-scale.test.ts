/** Disposable in-memory synthetic corpus. No patient/user data, files or UI
 * hooks. CI runs 1k on PRs; a separate main workflow runs 10k and publishes
 * aggregate metrics. Database is closed immediately after the test. */
import { SqliteMemoryRepository } from "../repository";
import { VECTOR_MODEL } from "../vectors";
const { DatabaseSync } = require("node:sqlite");
const { SCHEMA_SQL } = require("../storage");

type RecordRow = Record<string, unknown>;
class DB {
  sqlite = new DatabaseSync(":memory:");
  constructor() { this.sqlite.exec(SCHEMA_SQL); }
  async getFirstAsync<T>(sql: string, args: unknown[] = []): Promise<T | null> {
    return (this.sqlite.prepare(sql).get(...args) as T) || null;
  }
  async getAllAsync<T>(sql: string, args: unknown[] = []): Promise<T[]> {
    return this.sqlite.prepare(sql).all(...args) as T[];
  }
  async runAsync(sql: string, args: unknown[] = []) {
    return this.sqlite.prepare(sql).run(...args);
  }
  async execAsync(sql: string) { this.sqlite.exec(sql); }
  createRecords(count: number) {
    const now = "2026-10-27T00:00:00Z";
    this.sqlite.prepare("INSERT INTO memory_collections(id,name,slug,sensitivity,created_at) VALUES (?,?,?,?,?)")
      .run("visible", "Заметки", "notes", "standard", now);
    this.sqlite.prepare("INSERT INTO memory_collections(id,name,slug,sensitivity,created_at) VALUES (?,?,?,?,?)")
      .run("private", "Секретные", "private", "secret", now);
    const ent = this.sqlite.prepare(`INSERT INTO memory_entities
      (id,collection_id,domain,title,payload_json,record_status,sensitivity,created_at,updated_at,record_version,kind)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`);
    const chunk = this.sqlite.prepare(`INSERT INTO memory_chunks(id,entity_id,ord,text,content_hash,created_at)
      VALUES (?,?,?,?,?,?)`);
    const fts = this.sqlite.prepare(`INSERT INTO memory_search_fts(entity_id,chunk_id,title,body,terms,aliases)
      VALUES (?,?,?,?,?,?)`);
    this.sqlite.exec("BEGIN");
    try {
      for (let i = 0; i < count; i++) {
        const id = "synthetic-" + i, title = "Проверка записи " + i;
        const body = "масштабный контроль чтения память " + i;
        const col = i % 20 === 0 ? "private" : "visible";
        ent.run(id, col, "notes", title, JSON.stringify({ body }), "active",
          col === "private" ? "secret" : "standard", now, now, 1, "note");
        chunk.run(id + ":0", id, 0, body, "synthetic:" + i, now);
        fts.run(id, id + ":0", title, body, "", "");
      }
      this.sqlite.exec("COMMIT");
    } catch (e) { this.sqlite.exec("ROLLBACK"); throw e; }
  }
}
test("synthetic 1k/10k: bounded vector inputs, accurate counts, private records excluded", async () => {
  const scale = process.env.PIA_MEMORY_SCALE_10000 === "1" ? 10000 : 1000;
  const db = new DB();
  const start = process.hrtime.bigint();
  try {
    db.createRecords(scale);
    const repo = new SqliteMemoryRepository(db as never);
    const pendingStart = process.hrtime.bigint();
    const pending = await repo.pendingVectorChunks(VECTOR_MODEL, 24);
    const pendingMs = Number(process.hrtime.bigint() - pendingStart) / 1e6;
    const statusStart = process.hrtime.bigint();
    const status = await repo.vectorStatus(VECTOR_MODEL);
    const statusMs = Number(process.hrtime.bigint() - statusStart) / 1e6;
    const queryStart = process.hrtime.bigint();
    const visible = await repo.searchMemory("масштабный", {
      collectionIds: ["visible"], sensitivities: ["standard"], limit: 10,
    });
    const searchMs = Number(process.hrtime.bigint() - queryStart) / 1e6;
    expect(status).toEqual({ done: 0, total: scale });
    expect(pending).toHaveLength(24);
    expect(visible.length).toBeGreaterThan(0);
    expect(visible.every(h => h.entity.collection_id === "visible" && h.entity.sensitivity === "standard")).toBe(true);
    // Only anonymized aggregate metrics. No personal data, content, original
    // files, or durable benchmark profiles are created.
    console.log("MEMORY_SCALE_METRICS " + JSON.stringify({
      rows: scale, pendingMs: Math.round(pendingMs), statusMs: Math.round(statusMs),
      searchMs: Math.round(searchMs),
      totalMs: Math.round(Number(process.hrtime.bigint() - start) / 1e6),
      queueCount: pending.length, vectorCount: status.total, visibleHits: visible.length,
    }));
  } finally { db.sqlite.close(); }
}, 120000);
