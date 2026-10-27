import { SqliteMemoryRepository } from "../repository";
import { SCHEMA_SQL } from "../storage";
import { saveExtractionRun } from "../extractions";
import { listApprovedSourceSegments, readApprovedSourceSegment } from "../source-retrieval";

jest.mock("expo-crypto", () => ({
  CryptoDigestAlgorithm: { SHA256: "SHA-256" },
  randomUUID: () => require("node:crypto").randomUUID(),
  digestStringAsync: async (_a: string, s: string) =>
    require("node:crypto").createHash("sha256").update(s).digest("hex"),
}));
const { DatabaseSync } = require("node:sqlite");
class TestDb {
  sqlite = new DatabaseSync(":memory:");
  constructor() { this.sqlite.exec("PRAGMA foreign_keys=ON;" + SCHEMA_SQL); }
  async getFirstAsync<T>(sql: string, params: unknown[] = []): Promise<T|null> {
    return this.sqlite.prepare(sql).get(...params) as T ?? null;
  }
  async getAllAsync<T>(sql: string, params: unknown[] = []): Promise<T[]> {
    return this.sqlite.prepare(sql).all(...params) as T[];
  }
  async runAsync(sql: string, params: unknown[] = []): Promise<{changes:number}> {
    return { changes: Number(this.sqlite.prepare(sql).run(...params).changes) };
  }
  async execAsync(sql: string): Promise<void> { this.sqlite.exec(sql); }
  close() { this.sqlite.close(); }
}
async function fixture(sensitivity: "standard"|"sensitive" = "standard",
                       recordSensitivity: "standard"|"sensitive" = "standard") {
  const db = new TestDb(), repo = new SqliteMemoryRepository(db as never);
  const section = await repo.createCollection({
    name: sensitivity === "standard" ? "Notes" : "Documents",
    slug: sensitivity === "standard" ? "notes" : "documents", sensitivity,
  });
  const entity = await repo.createEntity({
    collection_id: section.id, domain:"notes", title:"Письмо",
    payload:{body:"Текст заметки"}, sensitivity:recordSensitivity,
  });
  await db.runAsync("INSERT INTO memory_attachments(id,entity_id,name,mime,size,created_at) VALUES (?,?,?,?,?,?)",
    ["a1",entity.id,"scan.pdf","application/pdf",3,"now"]);
  const bytes=new Uint8Array([1,2,3]);
  const sha=require("node:crypto").createHash("sha256").update(bytes).digest("hex");
  await db.runAsync("INSERT INTO memory_attachment_parts(attachment_id,ord,bytes,sha256) VALUES (?,?,?,?)",
    ["a1",0,bytes,sha]);
  const run=await saveExtractionRun(db as never,{
    attachmentId:"a1",producerKind:"pdf",producerId:"pdf-text-v1",
    producerRevision:"1.0",coverage:"partial",status:"partial",language:"ru",
    segments:[
      {text:"Важная информация со страницы три.",location:{kind:"page",page:3}},
      {text:"Нет координат. ",location:{kind:"unknown"}},
    ],
  });
  return {db,repo,entity,run};
}

test("source list gives small previews, explicit metadata, no original bytes or full document",async()=>{
  const {db,entity}=await fixture();
  try {
    const list=await listApprovedSourceSegments(db as never,entity.id,1);
    expect(list).toMatchObject({scope:"standard_active_notes",metadataOnly:true,
      recordVersion:1,hasMore:false});
    expect(list.segments).toHaveLength(2);
    expect(list.segments[0]).toMatchObject({
      attachmentId:"a1",attachmentName:"scan.pdf",producerKind:"pdf",
      status:"partial",coverage:"partial",location:{kind:"page",page:3},
      locationConfidence:"producer_reported",sourceCheck:"part_manifest_revision",
    });
    expect(list.segments[1].location).toEqual({kind:"unknown"});
    expect(JSON.stringify(list)).not.toContain("010203");
  } finally {db.close();}
});

test("exact scoped segment read has truthful source locator, bounded cursor and rejects wrong IDs",async()=>{
  const {db,entity,run}=await fixture();
  try {
    const list=await listApprovedSourceSegments(db as never,entity.id,1);
    const seg=list.segments[0];
    const first=await readApprovedSourceSegment(db as never,entity.id,1,"a1",run,
      seg.segmentId,0,11);
    expect(first).toMatchObject({recordVersion:1,attachmentId:"a1",
      content:"Важная инфо",offset:0,hasMore:true,
      location:{kind:"page",page:3},locationConfidence:"producer_reported"});
    const second=await readApprovedSourceSegment(db as never,entity.id,1,"a1",run,
      seg.segmentId,first.nextOffset,3000);
    expect(first.content+second.content).toBe("Важная информация со страницы три.");
    expect(second.hasMore).toBe(false);
    await expect(readApprovedSourceSegment(db as never,entity.id,1,"a2",run,seg.segmentId))
      .rejects.toThrow("source_segment_not_found");
    await expect(readApprovedSourceSegment(db as never,"another",1,"a1",run,seg.segmentId))
      .rejects.toThrow("memory_source_not_available_or_stale");
    await expect(readApprovedSourceSegment(db as never,entity.id,1,"a1","wrong",seg.segmentId))
      .rejects.toThrow("source_segment_not_found");
    await expect(readApprovedSourceSegment(db as never,entity.id,1,"a1",run,seg.segmentId,-1))
      .rejects.toThrow("invalid_source_read_range");
    await expect(listApprovedSourceSegments(db as never,entity.id,1,31))
      .rejects.toThrow("invalid_source_list_limit");
  } finally {db.close();}
});

test.each([["sensitive","standard"],["standard","sensitive"]])(
  "protected %s collection / %s record is hidden even when source IDs are known",
  async (collection,recordSensitivity) => {
    const {db,entity,run}=await fixture(collection as "standard"|"sensitive",
      recordSensitivity as "standard"|"sensitive");
    try {
      const segment=(await db.getFirstAsync<{id:string}>(
        "SELECT id FROM memory_extraction_segments WHERE extraction_id=?", [run]))!.id;
      await expect(listApprovedSourceSegments(db as never,entity.id,1))
        .rejects.toThrow("memory_source_not_available_or_stale");
      await expect(readApprovedSourceSegment(db as never,entity.id,1,"a1",run,segment))
        .rejects.toThrow("memory_source_not_available_or_stale");
    } finally {db.close();}
  },
);

test("archive and revision invalidates old source list/read cursors without removing originals",async()=>{
  const {db,repo,entity,run}=await fixture();
  try{
    const id=(await db.getFirstAsync<{id:string}>(
      "SELECT id FROM memory_extraction_segments WHERE extraction_id=?", [run]))!.id;
    const revised=await repo.reviseEntity(entity.id,1,{...entity.payload,body:"Изменили заметку"},"User correction");
    await expect(listApprovedSourceSegments(db as never,entity.id,1))
      .rejects.toThrow("memory_source_not_available_or_stale");
    await expect(readApprovedSourceSegment(db as never,entity.id,1,"a1",run,id))
      .rejects.toThrow("memory_source_not_available_or_stale");
    expect((await listApprovedSourceSegments(db as never,entity.id,revised.record_version)).segments).toHaveLength(2);
    await repo.setEntityStatus(entity.id,revised.record_version,"archived");
    await expect(listApprovedSourceSegments(db as never,entity.id,revised.record_version))
      .rejects.toThrow("memory_source_not_available_or_stale");
    expect((await db.getFirstAsync<{n:number}>("SELECT count(*) AS n FROM memory_attachments"))!.n).toBe(1);
  } finally {db.close();}
});

test("source revision mismatch fails closed, no stale PDF page or source preview is shown",async()=>{
  const {db,entity,run}=await fixture();
  try {
    const id=(await db.getFirstAsync<{id:string}>(
      "SELECT id FROM memory_extraction_segments WHERE extraction_id=?", [run]))!.id;
    await db.runAsync("UPDATE memory_attachment_parts SET sha256=? WHERE attachment_id=?",
      ["f".repeat(64),"a1"]);
    expect((await listApprovedSourceSegments(db as never,entity.id,1)).segments).toEqual([]);
    await expect(readApprovedSourceSegment(db as never,entity.id,1,"a1",run,id))
      .rejects.toThrow("stale_extraction_source_version");
  } finally {db.close();}
});
