import { createHash, randomUUID } from "node:crypto";
import { SCHEMA_SQL } from "../storage";
import { SqliteMemoryRepository } from "../repository";
import { saveExtractionRun, extractionEvidence, type ExtractionRunInput } from "../extractions";

jest.mock("expo-crypto", () => ({
  CryptoDigestAlgorithm: { SHA256: "SHA-256" },
  randomUUID: () => require("node:crypto").randomUUID(),
  digestStringAsync: async (_kind:string,text:string) =>
    require("node:crypto").createHash("sha256").update(text).digest("hex"),
}));
const { DatabaseSync } = require("node:sqlite");

class TestDb {
  sqlite = new DatabaseSync(":memory:");
  constructor() { this.sqlite.exec("PRAGMA foreign_keys=ON;" + SCHEMA_SQL); }
  async getFirstAsync<T>(sql:string,params:unknown[]=[]):Promise<T|null> {
    return (this.sqlite.prepare(sql).get(...params) as T) ?? null;
  }
  async getAllAsync<T>(sql:string,params:unknown[]=[]):Promise<T[]> {
    return this.sqlite.prepare(sql).all(...params) as T[];
  }
  async runAsync(sql:string,params:unknown[]=[]):Promise<{changes:number}> {
    return { changes:Number(this.sqlite.prepare(sql).run(...params).changes) };
  }
  async execAsync(sql:string):Promise<void> { this.sqlite.exec(sql); }
  close(){ this.sqlite.close(); }
}
async function fixture(){
  const db=new TestDb();
  const repo=new SqliteMemoryRepository(db as never);
  const col=await repo.createCollection({name:"Документы",slug:"documents",sensitivity:"sensitive"});
  const entity=await repo.createEntity({collection_id:col.id,domain:"notes",title:"Полис",payload:{body:"Документ"}});
  await db.runAsync("INSERT INTO memory_attachments(id,entity_id,name,mime,size,created_at) VALUES (?,?,?,?,?,?)",
    ["src-1",entity.id,"insurance.pdf","application/pdf",3,"2026-10-27"]);
  const bytes=Uint8Array.from([1,2,3]);
  const sha=require("node:crypto").createHash("sha256").update(bytes).digest("hex");
  await db.runAsync("INSERT INTO memory_attachment_parts(attachment_id,ord,bytes,sha256) VALUES (?,?,?,?)",
    ["src-1",0,bytes,sha]);
  return {db,repo,entity,sha};
}
const input:ExtractionRunInput={
  attachmentId:"src-1",producerKind:"pdf",producerId:"native-pdf-text",
  producerRevision:"v1",coverage:"partial",status:"partial",language:"ru",
  segments:[
    {text:"Действует до 2031 года",location:{kind:"page",page:3}},
    {text:"Страхователь",location:{kind:"unknown"}},
  ],
};

test("stores explicit source version, provenance and precise page/unknown segment",async()=>{
  const {db,entity}=await fixture();
  try{
    const id=await saveExtractionRun(db as never,input);
    const rows=await extractionEvidence(db as never,entity.id,"src-1");
    expect(rows).toHaveLength(1);
    expect(rows[0].extractionId).toBe(id);
    expect(rows[0]).toMatchObject({
      producerKind:"pdf",producerId:"native-pdf-text",producerRevision:"v1",
      coverage:"partial",status:"partial",
    });
    expect(rows[0].sourceVersion).toMatch(/^[0-9a-f]{64}$/);
    expect(rows[0].segments.map(x=>x.location)).toEqual([{kind:"page",page:3},{kind:"unknown"}]);
    expect(await extractionEvidence(db as never,"wrong-owner","src-1")).toEqual([]);
    expect((await db.getFirstAsync<any>("SELECT text FROM memory_extraction_segments LIMIT 1"))?.text).toBe("Действует до 2031 года");
    expect((await db.getFirstAsync<any>("SELECT body FROM memory_search_fts LIMIT 1"))?.body).not.toContain("Страхователь");
  } finally { db.close(); }
});

test("source fingerprint mismatch refuses stale evidence and does not rewrite user original",async()=>{
  const {db,entity}=await fixture();
  try {
    const saved=await saveExtractionRun(db as never,input);
    await db.runAsync("UPDATE memory_attachment_parts SET sha256=? WHERE attachment_id=?",
      ["f".repeat(64),"src-1"]);
    expect(await extractionEvidence(db as never,entity.id,"src-1")).toEqual([]);
    expect((await db.getFirstAsync<any>("SELECT id FROM memory_extractions WHERE id=?", [saved]))?.id).toBe(saved);
  } finally { db.close(); }
});

test("rejects invented positions, missing original bytes, forbidden producer metadata",async()=>{
  const {db}=await fixture();
  try{
    const bad=[
      {...input,segments:[{text:"A",location:{kind:"page",page:0}}]},
      {...input,segments:[{text:"A",location:{kind:"time",startMs:2000,endMs:1000}}]},
      {...input,segments:[{text:"A",location:{kind:"char",start:-1,end:5}}]},
      {...input,producerId:""},
      {...input,producerKind:"server-instruction"},
      {...input,status:"failed",segments:input.segments},
    ];
    for(const item of bad){
      await expect(saveExtractionRun(db as never,item as never)).rejects.toThrow();
    }
    await expect(saveExtractionRun(db as never,{...input,attachmentId:"missing"}))
      .rejects.toThrow("extraction_original_missing");
    expect((await db.getFirstAsync<any>("SELECT COUNT(*) AS n FROM memory_extractions"))?.n).toBe(0);
    expect((await db.getFirstAsync<any>("SELECT COUNT(*) AS n FROM memory_extraction_segments"))?.n).toBe(0);
  } finally { db.close(); }
});

test("a failed segment insert rolls back both run and earlier segments",async()=>{
  const {db}=await fixture();
  try {
    const base=db.runAsync.bind(db);
    let inserted=0;
    db.runAsync=async(sql:string,params:unknown[]=[])=>
      sql.includes("INSERT INTO memory_extraction_segments") && ++inserted===2
        ? Promise.reject(new Error("disk_full")) : base(sql,params);
    await expect(saveExtractionRun(db as never,input)).rejects.toThrow("disk_full");
    expect((await db.getFirstAsync<any>("SELECT COUNT(*) AS n FROM memory_extractions"))?.n).toBe(0);
    expect((await db.getFirstAsync<any>("SELECT COUNT(*) AS n FROM memory_extraction_segments"))?.n).toBe(0);
  } finally { db.close(); }
});

test("historical OCR/ASR versions coexist and location stays truthful",async()=>{
  const {db,entity}=await fixture();
  try {
    await saveExtractionRun(db as never,{...input,producerKind:"ocr",producerRevision:"v1",
      segments:[{text:"Номер 123",location:{kind:"unknown"}}]});
    await saveExtractionRun(db as never,{...input,producerKind:"ocr",producerRevision:"v2",
      segments:[{text:"Номер 12345",location:{kind:"char",start:5,end:16}}]});
    const rows=await extractionEvidence(db as never,entity.id,"src-1");
    expect(rows).toHaveLength(2);
    expect(rows.map(x=>x.producerRevision).sort()).toEqual(["v1","v2"]);
    expect(rows.flatMap(x=>x.segments.map(y=>y.location.kind)).sort()).toEqual(["char","unknown"]);
  } finally { db.close(); }
});
