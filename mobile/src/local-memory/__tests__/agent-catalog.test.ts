import { countAllowedNotes, listAllowedNotes } from "../agent-catalog";
const { DatabaseSync } = require("node:sqlite");
const { SCHEMA_SQL } = require("../storage");
class Db {
  sqlite = new DatabaseSync(":memory:");
  constructor() {
    this.sqlite.exec(SCHEMA_SQL);
    for (const [id, sensitivity] of [["c-standard", "standard"], ["c-secret", "secret"]]) {
      this.sqlite.prepare("INSERT INTO memory_collections(id,name,slug,sensitivity,created_at) VALUES (?,?,?,?,?)")
        .run(id, id, id, sensitivity, "2026-01-01");
    }
  }
  add(id: string, col: string, status: string, sensitivity: string, title: string, updated: string) {
    this.sqlite.prepare(`INSERT INTO memory_entities(
      id,collection_id,domain,title,payload_json,record_status,sensitivity,created_at,updated_at,record_version,kind)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
      .run(id, col, "notes", title, JSON.stringify({ body: title }), status, sensitivity,
        "2025-01-01", updated, 1, "note");
    this.sqlite.prepare("INSERT INTO memory_search_fts(entity_id,chunk_id,title,body,terms,aliases) VALUES (?,?,?,?,?,?)")
      .run(id, id + ":0", title, title, "", "");
  }
  async getFirstAsync<T>(sql: string, params: unknown[] = []): Promise<T|null> {
    return (this.sqlite.prepare(sql).get(...params) as T) || null;
  }
  async getAllAsync<T>(sql: string, params: unknown[] = []): Promise<T[]> {
    return this.sqlite.prepare(sql).all(...params) as T[];
  }
}
test("exact filtered count excludes private, secret, archived and trashed data", async () => {
  const db = new Db();
  db.add("a", "c-standard", "active", "standard", "Квитанция январь", "2026-10-05T00:00:00Z");
  db.add("b", "c-standard", "active", "inherit", "Квитанция март", "2026-10-04T00:00:00Z");
  db.add("c", "c-standard", "active", "sensitive", "Квитанция секрет", "2026-10-03T00:00:00Z");
  db.add("d", "c-secret", "active", "standard", "Квитанция тайна", "2026-10-02T00:00:00Z");
  db.add("e", "c-standard", "archived", "standard", "Квитанция архив", "2026-10-01T00:00:00Z");
  expect(await countAllowedNotes(db as never)).toEqual({
    count: 2, scope: "standard_active_notes", matchMode: "all_allowed",
  });
  expect(await countAllowedNotes(db as never, { query: "Квитанция" })).toEqual({
    count: 2, scope: "standard_active_notes", matchMode: "exact_fts_phrase",
  });
  expect((await listAllowedNotes(db as never)).records.map(v => v.id)).toEqual(["a", "b"]);
  expect(await countAllowedNotes(db as never, { collectionId: "c-secret" })).toMatchObject({ count: 0 });
});

test("list is keyset-paged, no bodies leave SQLCipher and count ignores cursor", async () => {
  const db = new Db();
  for (let i = 0; i < 5; i++) db.add(String(i), "c-standard", "active", "standard",
    "Рецепт " + i, "2026-10-0" + (i+1) + "T00:00:00Z");
  const first = await listAllowedNotes(db as never, { limit: 2 });
  expect(first.records.map(x => x.id)).toEqual(["4","3"]);
  expect(first.contentIncluded).toBe(false);
  expect(JSON.stringify(first)).not.toContain("payload_json");
  expect(first.nextCursor).toBeDefined();
  const next = await listAllowedNotes(db as never, { limit: 2, ...first.nextCursor });
  expect(next.records.map(x => x.id)).toEqual(["2","1"]);
  expect((await countAllowedNotes(db as never)).count).toBe(5);
  await expect(listAllowedNotes(db as never, { limit: 100 })).rejects.toThrow("invalid_catalog_limit");
  await expect(listAllowedNotes(db as never, { beforeId: "1" })).rejects.toThrow("invalid_catalog_cursor");
});
