/**
 * №83.0: current-release baseline, NOT a synthetic "vision model" benchmark.
 *
 * Run: npm test -- --runInBand src/local-memory/__tests__/photo-baseline.test.ts
 *
 * The opaque byte payload represents a preserved original, not a decoded image.
 * No caption, OCR, vision inference, or fabricated image embeddings are used.
 * This guards existing FTS/ACL behaviour and demonstrates the missing capability
 * that a REAL Android model test must close in №83.1.
 */
import { SqliteMemoryRepository } from "../repository";
import { reindexAll } from "../search-index";
import { SCHEMA_SQL } from "../storage";

jest.mock("expo-crypto", () => ({
  randomUUID: () => "photo-baseline-" + Math.random().toString(36).slice(2),
}));
const { DatabaseSync } = require("node:sqlite");

class SqliteFixture {
  private readonly sqlite = new DatabaseSync(":memory:");
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

test("83.0: photo original without caption is NOT visually searchable; text still works", async () => {
  const db = new SqliteFixture();
  try {
    const repo = new SqliteMemoryRepository(db as never);
    const collection = await repo.createCollection({ name: "Фотографии", slug: "photos", sensitivity: "standard" });
    const unlabelled = await repo.createEntity({
      collection_id: collection.id, domain: "notes", title: "IMG_0001",
      payload: { source_media: "image", source_file: "IMG_0001.jpg", body: "" },
    });
    // Deliberately opaque miniature test data, NOT an image that a model has
    // inspected. Preserving original bytes does not make them visual features.
    const attachment = "photo-baseline-original";
    await db.runAsync(
      "INSERT INTO memory_attachments(id,entity_id,name,mime,size,created_at) VALUES (?,?,?,?,?,?)",
      [attachment, unlabelled.id, "IMG_0001.jpg", "image/jpeg", 4, new Date().toISOString()]);
    await db.runAsync(
      "INSERT INTO memory_attachment_parts(attachment_id,ord,bytes,sha256) VALUES (?,?,?,?)",
      [attachment, 0, Uint8Array.from([255, 216, 255, 217]), "fixture-digest-not-for-materialization"]);
    await reindexAll(db as never);

    const captioned = await repo.createEntity({
      collection_id: collection.id, domain: "notes", title: "Мой красный велосипед",
      payload: { body: "Велосипед стоит у дерева", source_media: "image" },
    });

    // Relevance comes ONLY from the user-supplied text. An opaque image never
    // becomes a positive hit by being saved, backed up or reindexed.
    const found = await repo.searchMemory("велосипед");
    expect(found.map(hit => hit.entity.id)).toContain(captioned.id);
    expect(found.map(hit => hit.entity.id)).not.toContain(unlabelled.id);
    expect(await repo.searchNotes("IMG_0001")).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: unlabelled.id }),
    ]));
    const parts = await db.getFirstAsync<{ n: number }>(
      "SELECT count(*) AS n FROM memory_attachment_parts WHERE attachment_id=?", [attachment]);
    expect(parts?.n).toBe(1);

    // A manual user annotation is indexed (and belongs to the user), but this
    // is still TEXT search, not image-to-image or image-to-text retrieval.
    await repo.setIndexTerms(unlabelled.id, ["велосипед"], "user");
    expect((await repo.searchMemory("велосипед")).map(hit => hit.entity.id)).toContain(unlabelled.id);
    await repo.setIndexTerms(unlabelled.id, [], "user");
    await reindexAll(db as never);
    expect((await repo.searchMemory("велосипед")).map(hit => hit.entity.id)).not.toContain(unlabelled.id);
  } finally { db.close(); }
});

test("83.0: scoped note retrieval cannot become a privacy bypass for future photo search", async () => {
  const db = new SqliteFixture();
  try {
    const repo = new SqliteMemoryRepository(db as never);
    const standard = await repo.createCollection({ name: "Общее", slug: "general", sensitivity: "standard" });
    const privateCollection = await repo.createCollection({ name: "Личное", slug: "private", sensitivity: "secret" });
    const publicItem = await repo.createEntity({
      collection_id: standard.id, domain: "notes", title: "Гараж", payload: { body: "Автомобиль на парковке" },
      sensitivity: "standard",
    });
    const privateItem = await repo.createEntity({
      collection_id: privateCollection.id, domain: "notes", title: "Секретное авто", payload: { body: "Автомобиль на парковке" },
      sensitivity: "secret",
    });
    const approved = await repo.searchMemory("автомобиль", {
      collectionIds: [standard.id], sensitivities: ["standard", "inherit"],
    });
    expect(approved.map(hit => hit.entity.id)).toContain(publicItem.id);
    expect(approved.map(hit => hit.entity.id)).not.toContain(privateItem.id);
    const archived = await repo.setEntityStatus(publicItem.id, publicItem.record_version, "archived");
    expect(archived.record_status).toBe("archived");
    expect((await repo.searchMemory("автомобиль", {
      collectionIds: [standard.id], sensitivities: ["standard", "inherit"],
    })).map(hit => hit.entity.id)).not.toContain(publicItem.id);
  } finally { db.close(); }
});
