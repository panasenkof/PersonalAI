/** Real SQLite v18 fixture, no fake embeddings passed as real model output.
 * These vectors are synthetic coordinates for database contract tests only.
 */
import { SqliteMemoryRepository } from "../repository";
import { SCHEMA_SQL, LOCAL_MEMORY_SCHEMA_VERSION } from "../storage";
import { IMAGE_VECTOR_DIM } from "../attachment-vectors";
import { fingerprintExtractionSource } from "../extractions";

jest.mock("expo-crypto", () => ({
  randomUUID: () => require("node:crypto").randomUUID(),
  CryptoDigestAlgorithm: { SHA256: "sha256" },
  digestStringAsync: async (_: string, value: string) =>
    require("node:crypto").createHash("sha256").update(value).digest("hex"),
}));
const { DatabaseSync } = require("node:sqlite");
const MODEL = "eg2|vision|768|sha256:" + "a".repeat(64);
const MODEL2 = "eg2|vision|768|sha256:" + "b".repeat(64);
function vector(x: number, y: number): Float32Array {
  const v = new Float32Array(IMAGE_VECTOR_DIM);
  v[0] = x; v[1] = y; return v;
}
class DB {
  private readonly sqlite = new DatabaseSync(":memory:");
  constructor() {
    this.sqlite.exec("PRAGMA foreign_keys=ON;" + SCHEMA_SQL);
  }
  async getFirstAsync<T>(sql:string,p:unknown[]=[]):Promise<T|null> {
    return (this.sqlite.prepare(sql).get(...p) as T)??null;
  }
  async getAllAsync<T>(sql:string,p:unknown[]=[]):Promise<T[]> {
    return this.sqlite.prepare(sql).all(...p) as T[];
  }
  async runAsync(sql:string,p:unknown[]=[]):Promise<{changes:number}> {
    return {changes:Number(this.sqlite.prepare(sql).run(...p).changes)};
  }
  async execAsync(sql:string):Promise<void> {this.sqlite.exec(sql);}
  close(){this.sqlite.close();}
}
async function attachment(db:DB,repo:SqliteMemoryRepository,collectionId:string,name:string,mime="image/jpeg"){
  const e=await repo.createEntity({
    collection_id:collectionId,domain:"notes",title:name,payload:{body:""},
  });
  const id="att-"+name;
  const raw=Uint8Array.from([1,2,3,4]);
  const sha=require("node:crypto").createHash("sha256").update(raw).digest("hex");
  await db.runAsync("INSERT INTO memory_attachments(id,entity_id,name,mime,size,created_at) VALUES(?,?,?,?,?,?)",
    [id,e.id,name,mime,raw.length,"2026-10-30"]);
  await db.runAsync("INSERT INTO memory_attachment_parts(attachment_id,ord,bytes,sha256) VALUES(?,?,?,?)",
    [id,0,raw,sha]);
  return {attachmentId:id,entityId:e.id};
}
async function save(db: DB, repo: SqliteMemoryRepository, attachmentId: string, model: string, values: Float32Array) {
  return repo.saveImageVector(attachmentId,model,values,
    await fingerprintExtractionSource(db as never,attachmentId));
}
test("v18 index is derived, encrypted and lives with attachment foreign keys",async()=>{
  const db=new DB();
  try{
    expect(LOCAL_MEMORY_SCHEMA_VERSION).toBe(18);
    const schema=await db.getFirstAsync<{sql:string}>("SELECT sql FROM sqlite_master WHERE name='memory_attachment_vectors'");
    expect(schema?.sql).toContain("REFERENCES memory_attachments(id) ON DELETE CASCADE");
    expect(schema?.sql).not.toContain("path");
  } finally{db.close();}
});
test("searchMemory merges photo rank with text without creating a second unscoped search",async()=>{
  const db=new DB();
  try{
    const repo=new SqliteMemoryRepository(db as never);
    const c=await repo.createCollection({name:"Фото",slug:"photos",sensitivity:"standard"});
    const x=await attachment(db,repo,c.id,"red-bike.jpg");
    const y=await attachment(db,repo,c.id,"blue-car.jpg");
    expect(await save(db,repo,x.attachmentId,MODEL,vector(1,0))).toBe(true);
    expect(await save(db,repo,y.attachmentId,MODEL,vector(0,1))).toBe(true);
    const hits=await repo.searchMemory("",{imageVector:{model:MODEL,values:vector(1,0)}});
    expect(hits.map(h=>h.entity.id)).toEqual([x.entityId,y.entityId]);
    expect(hits[0].originals).toEqual([expect.objectContaining({
      attachmentId:x.attachmentId,recordId:x.entityId,metadataOnly:true,
      kind:"image",originalPage:null,originalTime:null,
    })]);
    expect((await repo.searchMemory("несуществующий велосипед")).some(h=>h.entity.id===x.entityId)).toBe(false);
    // A vector was not inserted into the existing *text* MiniLM space.
    expect((await db.getFirstAsync<{n:number}>("SELECT count(*) AS n FROM memory_vectors"))?.n).toBe(0);
    expect((await repo.searchMemory("",{imageVector:{model:MODEL2,values:vector(1,0)}}))).toEqual([]);
  }finally{db.close();}
});
test("same model vector is hidden after source edit, archive, collection filter and delete",async()=>{
  const db=new DB();
  try {
    const repo=new SqliteMemoryRepository(db as never);
    const c=await repo.createCollection({name:"Фото",slug:"photos",sensitivity:"standard"});
    const x=await attachment(db,repo,c.id,"tree.jpg");
    const opts={imageVector:{model:MODEL,values:vector(1,0)}};
    await save(db,repo,x.attachmentId,MODEL,vector(1,0));
    expect((await repo.searchMemory("",opts))).toHaveLength(1);
    expect(await repo.searchMemory("",{...opts,collectionIds:["unrelated"]})).toEqual([]);
    expect(await repo.searchMemory("",{...opts,sensitivities:[]})).toEqual([]);
    const before=await fingerprintExtractionSource(db as never,x.attachmentId);
    await db.runAsync("UPDATE memory_attachment_parts SET sha256=? WHERE attachment_id=?",
      ["c".repeat(64),x.attachmentId]);
    expect(await repo.searchMemory("",opts)).toEqual([]);
    // A model result computed before the edit MUST NOT receive a new source
    // fingerprint and silently become current.
    expect(await repo.saveImageVector(x.attachmentId,MODEL,vector(1,0),before)).toBe(false);
    const actual=require("node:crypto").createHash("sha256").update(Uint8Array.from([1,2,3,4])).digest("hex");
    await db.runAsync("UPDATE memory_attachment_parts SET sha256=? WHERE attachment_id=?",
      [actual,x.attachmentId]);
    await save(db,repo,x.attachmentId,MODEL,vector(1,0));
    await db.runAsync("UPDATE memory_entities SET record_status='archived' WHERE id=?",[x.entityId]);
    expect(await repo.searchMemory("",opts)).toEqual([]);
    await db.runAsync("DELETE FROM memory_attachments WHERE id=?",[x.attachmentId]);
    expect((await db.getFirstAsync<{n:number}>(
      "SELECT count(*) AS n FROM memory_attachment_vectors"))?.n).toBe(0);
  }finally{db.close();}
});
test("reject unsupported dimensions, model-space crossover, or non-image originals",async()=>{
  const db=new DB();
  try{
    const repo=new SqliteMemoryRepository(db as never);
    const c=await repo.createCollection({name:"Файлы",slug:"files",sensitivity:"standard"});
    const x=await attachment(db,repo,c.id,"scan.pdf","application/pdf");
    expect(await save(db,repo,x.attachmentId,MODEL,vector(1,0))).toBe(false);
    await expect(save(db,repo,x.attachmentId,"minilm",vector(1,0)))
      .rejects.toThrow("invalid_vision_vector_space");
    await expect(save(db,repo,x.attachmentId,MODEL,new Float32Array(384)))
      .rejects.toThrow("invalid_vision_vector_space");
    const bad=vector(1,0);bad[5]=NaN;
    await expect(save(db,repo,x.attachmentId,MODEL,bad))
      .rejects.toThrow("invalid_vision_vector_space");
  }finally{db.close();}
});

test("visual vector writer refuses secret note and secret collection even if inference completed",async()=>{
  const db=new DB();
  try {
    const repo=new SqliteMemoryRepository(db as never);
    const c=await repo.createCollection({name:"Оригиналы",slug:"secure-photo-writer",sensitivity:"standard"});
    const x=await attachment(db,repo,c.id,"confidential.jpg");
    await db.runAsync("UPDATE memory_entities SET sensitivity='secret' WHERE id=?",[x.entityId]);
    expect(await save(db,repo,x.attachmentId,MODEL,vector(1,0))).toBe(false);
    await db.runAsync("UPDATE memory_entities SET sensitivity='inherit' WHERE id=?",[x.entityId]);
    await db.runAsync("UPDATE memory_collections SET sensitivity='secret' WHERE id=?",[c.id]);
    expect(await save(db,repo,x.attachmentId,MODEL,vector(1,0))).toBe(false);
    expect((await db.getFirstAsync<{n:number}>(
      "SELECT count(*) AS n FROM memory_attachment_vectors"))?.n).toBe(0);
  } finally {db.close();}
});
