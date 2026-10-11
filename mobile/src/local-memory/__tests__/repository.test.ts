import { SqliteMemoryRepository } from "../repository";
import { MemoryAccessError, MemoryConflictError } from "../types";

jest.mock("expo-crypto", () => ({
  randomUUID: jest.fn(() => "fixed-" + Math.random().toString(36).slice(2)),
}));

type Row = Record<string, unknown>;
class FakeSqlite {
  collections = new Map<string, Row>();
  entities = new Map<string, Row>();
  revisions: Row[] = [];
  noteIndex = new Map<string, { title: string; body: string }>();
  updates = 0;
  async getFirstAsync<T>(sql: string, params: unknown[]): Promise<T | null> {
    if (sql.includes("FROM memory_collections WHERE id")) return [...this.collections.values()]
      .find(r => r.id === params[0]) as T || null;
    if (sql.includes("FROM memory_collections WHERE slug")) return [...this.collections.values()]
      .find(r => r.slug === params[0]) as T || null;
    if (sql.includes("FROM memory_entities WHERE id")) return this.entities.get(String(params[0])) as T || null;
    return null;
  }
  async getAllAsync<T>(sql: string, params: unknown[]): Promise<T[]> {
    if (sql.includes("FROM memory_revisions")) {
      return this.revisions.filter(r => r.record_type === params[0] &&
        (r.entity_id === params[1] || r.observation_id === params[1])) as T[];
    }
    if (sql.includes("FROM memory_entities")) {
      const records = [...this.entities.values()].filter(r => {
        if (r.domain !== "notes") return false;
        const fts = this.noteIndex.get(String(r.id));
        const phrase = String(params[0]).slice(1, -1);
        return Boolean(fts && (fts.title.includes(phrase) || fts.body.includes(phrase)));
      });
      return records as T[];
    }
    return [];
  }
  async runAsync(sql: string, params: unknown[]): Promise<{ changes: number }> {
    if (sql.includes("INSERT INTO memory_collections")) {
      this.collections.set(String(params[0]), {
        id: params[0], name: params[1], slug: params[2], description: params[3],
        sensitivity: params[4], created_at: params[5],
      }); return { changes: 1 };
    }
    if (sql.includes("INSERT INTO memory_entities")) {
      this.entities.set(String(params[0]), {
        id: params[0], collection_id: params[1], domain: params[2], schema_version: params[3],
        title: params[4], payload_json: params[5], record_status: params[6],
        sensitivity: params[7], source_kind: params[8], source_ref: params[9],
        valid_from: params[10], valid_until: params[11],
        created_at: params[12], updated_at: params[13], record_version: params[14],
      });
      return { changes: 1 };
    }
    if (sql.includes("INSERT INTO memory_revisions")) {
      this.revisions.push({
        id: params[0], record_type: params[1], entity_id: params[2],
        observation_id: params[3], version: params[4], reason: params[5],
        actor_kind: params[6], before_json: params[7], after_json: params[8],
        created_at: params[9],
      });
      return { changes: 1 };
    }
    if (sql.includes("UPDATE memory_entities")) {
      const row = this.entities.get(String(params[3]));
      if (!row || row.record_version !== params[4]) return { changes: 0 };
      row.payload_json = params[0]; row.title = params[1];
      row.updated_at = params[2]; row.record_version = Number(row.record_version) + 1;
      this.updates++;
      return { changes: 1 };
    }
    if (sql.includes("DELETE FROM memory_notes_fts")) {
      this.noteIndex.delete(String(params[0])); return { changes: 1 };
    }
    if (sql.includes("INSERT INTO memory_notes_fts")) {
      this.noteIndex.set(String(params[0]), {
        title: String(params[1]), body: String(params[2]),
      }); return { changes: 1 };
    }
    throw new Error("Unexpected SQL: " + sql);
  }
  readonly transactionStatements: string[] = [];
  async execAsync(sql: string): Promise<void> {
    if (!["BEGIN IMMEDIATE", "COMMIT", "ROLLBACK"].includes(sql)) {
      throw new Error("Unexpected transaction SQL: " + sql);
    }
    this.transactionStatements.push(sql);
  }
}

test("creates offline note, edits with CAS, stores immutable history and updates full-text search", async () => {
  const fake = new FakeSqlite();
  const repo = new SqliteMemoryRepository(fake as never);
  const collection = await repo.createCollection({ name: "Notes", slug: "notes", sensitivity: "standard" });
  const initial = await repo.createEntity({
    collection_id: collection.id, domain: "notes", title: "Car",
    payload: { type: "note", title: "Car", body: "old oil" },
  });
  expect(initial.record_version).toBe(1);
  expect((await repo.searchNotes("old oil"))[0].id).toBe(initial.id);
  const updated = await repo.reviseEntity(
    initial.id, 1, { type: "note", title: "Service", body: "new filter" }, "fix typo",
  );
  expect(updated.record_version).toBe(2);
  expect(fake.updates).toBe(1);
  // Never open a second connection: SQLCipher keys are connection-local.
  expect(fake.transactionStatements).toEqual([
    "BEGIN IMMEDIATE", "COMMIT", "BEGIN IMMEDIATE", "COMMIT",
  ]);
  expect(await repo.searchNotes("old oil")).toHaveLength(0);
  expect((await repo.searchNotes("new filter"))[0].id).toBe(initial.id);
  const history = await repo.revisions("entity", initial.id);
  expect(history).toHaveLength(1);
  expect((history[0].before_state.payload as Record<string, unknown>).body).toBe("old oil");
  expect((history[0].after_state.payload as Record<string, unknown>).body).toBe("new filter");
  history[0].before_state.payload = { body: "tampered" };
  expect((await repo.revisions("entity", initial.id))[0].before_state).toMatchObject({
    payload: { body: "old oil" },
  });
  await expect(repo.reviseEntity(initial.id, 1, { body: "stale" }, "stale"))
    .rejects.toBeInstanceOf(MemoryConflictError);
  expect(fake.updates).toBe(1);
  await expect(repo.createEntity({ collection_id: "not-present", domain: "notes", payload: {} }))
    .rejects.toBeInstanceOf(MemoryAccessError);
});

test("rejects malformed local input before any database mutation", async () => {
  const fake = new FakeSqlite();
  const repo = new SqliteMemoryRepository(fake as never);
  await expect(repo.createCollection({ name: "Note", slug: "bad slug" })).rejects.toThrow("invalid_collection_slug");
  await expect(repo.createCollection({ name: "Note", slug: "notes" })).resolves.toMatchObject({ slug: "notes" });
  await expect(repo.createCollection({ name: "Note", slug: "notes" })).rejects.toBeInstanceOf(MemoryConflictError);
  await expect(repo.reviseEntity("missing", 1, {}, "")).rejects.toThrow("invalid_revision_reason");
  await expect(repo.linkEntities("same", "same", "related_to")).rejects.toThrow("self_relation_not_allowed");
  await expect(repo.linkEntities("x", "y", "bad type")).rejects.toThrow("invalid_relation_kind");
  expect(fake.updates).toBe(0);
});


test("offline creation uses the already-unlocked SQLCipher connection", async () => {
  const fake = new FakeSqlite();
  const repo = new SqliteMemoryRepository(fake as never);
  const col = await repo.createCollection({ name: "Notes", slug: "notes" });
  await repo.createEntity({ collection_id: col.id, domain: "notes", payload: { title: "A" } });
  expect(fake.transactionStatements).toEqual(["BEGIN IMMEDIATE", "COMMIT"]);
});
