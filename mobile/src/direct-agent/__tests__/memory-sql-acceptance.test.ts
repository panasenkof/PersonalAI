/**
 * Bounded real-SQL user-journey acceptance slices for DOC-02/04/08,
 * SEARCH-06, SEC-01/08, SAVE-03 and source provenance.
 *
 * The native connection alone is replaced with node:sqlite. Everything else
 * uses the production SQL schema, same repository, approved save, canonical
 * FTS search and the version/ACL guarded evidence reader.
 *
 * This is not the whole 96-case assistant E2E or physical Android C2.
 */
import { saveApprovedNote, searchApprovedNotes, readApprovedNote } from "../memory";
import { SqliteMemoryRepository } from "../../local-memory/repository";
import { SCHEMA_SQL } from "../../local-memory/storage";
import { MemoryConflictError } from "../../local-memory/types";

jest.mock("expo-crypto",()=>({
  randomUUID:()=>require("node:crypto").randomUUID(),
  CryptoDigestAlgorithm:{SHA256:"SHA-256"},
  digestStringAsync:async(_algorithm:string,text:string)=>
    require("node:crypto").createHash("sha256").update(text).digest("hex"),
}));
const { DatabaseSync } = require("node:sqlite");
class RealSchemaConnection {
  sqlite = new DatabaseSync(":memory:");
  constructor(){this.sqlite.exec("PRAGMA foreign_keys=ON;"+SCHEMA_SQL);}
  async getFirstAsync<T>(sql:string,params:unknown[]=[]):Promise<T|null>{
    return this.sqlite.prepare(sql).get(...params) as T ?? null;
  }
  async getAllAsync<T>(sql:string,params:unknown[]=[]):Promise<T[]>{
    return this.sqlite.prepare(sql).all(...params) as T[];
  }
  async runAsync(sql:string,params:unknown[]=[]):Promise<{changes:number}>{
    return {changes:Number(this.sqlite.prepare(sql).run(...params).changes)};
  }
  async execAsync(sql:string){this.sqlite.exec(sql);}
  close(){this.sqlite.close();}
}
const newFixture=()=>{
  const db=new RealSchemaConnection(),repo=new SqliteMemoryRepository(db as never);
  return {db,repo};
};

test("DOC-02/08 SAVE-03: approved recipe → real FTS → versioned source → CAS correction → search/read again",async()=>{
  const {db,repo}=newFixture();
  try{
    const first=await saveApprovedNote("guest",{
      title:"Лазанья с бешамелем",section:"notes",kind:"note",
      body:"Для соуса используем муку, молоко и мускатный орех.",
    },repo);
    const second=await saveApprovedNote("guest",{
      title:"Лазанья с грибами",section:"notes",kind:"note",
      body:"В соус добавляют сушёные белые грибы и молотую зиру. Сохранить отдельно от варианта с бешамелем.",
    },repo);
    expect(first).not.toBe(second);
    const hits=await searchApprovedNotes("guest","зиру",repo);
    expect(hits.map(h=>h.id)).toEqual([second]);
    expect(hits[0]).toMatchObject({version:1});
    const evidence=await readApprovedNote("guest",hits[0].id,hits[0].version! ,0,5000,repo);
    expect(evidence).toMatchObject({
      id:second,revision:1,totalChars:evidence.content.length,hasMore:false,
      source:{recordId:second,sourceRef:"device-approved-agent",location:"unknown"},
      evidence:{recordId:second,recordVersion:1,startChar:0,
        endChar:evidence.content.length,coverage:"complete",
        originalPage:null,originalTime:null},
    });
    expect(evidence.content).toContain("зиру");
    expect(evidence.content).not.toContain("мускатный орех");
    const updated=await repo.reviseEntity(second,1,{
      type:"note",title:"Лазанья с грибами",
      body:"В соус добавляют сушёные белые грибы и тимьян. Исправлено пользователем.",
    },"Исправлена специя");
    expect(updated.record_version).toBe(2);
    await expect(readApprovedNote("guest",hits[0].id,hits[0].version!,0,5000,repo))
      .rejects.toThrow("stale_memory_version");
    await expect(repo.reviseEntity(second,1,{body:"устаревшая версия"},"Конфликт"))
      .rejects.toBeInstanceOf(MemoryConflictError);
    expect(await searchApprovedNotes("guest","зиру",repo)).toEqual([]);
    const corrected=await searchApprovedNotes("guest","тимьян",repo);
    expect(corrected[0]).toMatchObject({id:second,version:2});
    expect((await readApprovedNote("guest",second,2,0,5000,repo)).content)
      .toContain("Исправлено пользователем.");
    expect((await repo.revisions("entity",second)).length).toBe(1);
  }finally{db.close();}
});

test("SEARCH-06 SEC-01/08: no private titles, hidden counts, or stale source after reclassification",async()=>{
  const {db,repo}=newFixture();
  try{
    const visible=await saveApprovedNote("guest",{
      title:"Ключевое слово лаванда",body:"Ключевое слово лаванда в обычной записи.",section:"notes",
    },repo);
    const sections=await repo.listCollections();
    const open=sections.find(c=>c.slug==="notes")!;
    const protectedSection=sections.find(c=>c.slug==="documents")!;
    await repo.createEntity({collection_id:protectedSection.id,domain:"notes",
      title:"Секретная лаванда",payload:{body:"Только частное слово лаванда"},sensitivity:"sensitive"});
    const sensitiveInOpen=await repo.createEntity({collection_id:open.id,domain:"notes",
      title:"Личная лаванда",payload:{body:"Только скрытое слово лаванда"},sensitivity:"sensitive"});
    const results=await searchApprovedNotes("guest","лаванда",repo);
    expect(results.map(x=>x.id)).toEqual([visible]);
    expect(JSON.stringify(results)).not.toContain("Секретная");
    expect(JSON.stringify(results)).not.toContain("Личная");
    await expect(readApprovedNote("guest",sensitiveInOpen.id,1,0,300,repo))
      .rejects.toThrow("memory_read_not_available");
    await repo.moveEntity(visible,1,protectedSection.id);
    const afterMove=await searchApprovedNotes("guest","лаванда",repo);
    expect(afterMove).toEqual([]);
    await expect(readApprovedNote("guest",visible,1,0,300,repo))
      .rejects.toThrow(/memory_read_not_available|stale_memory_version/);
  }finally{db.close();}
});

test("DOC-04 SEARCH-07 SEC-08: link-only title is discoverable without claiming page contents; archive fails closed",async()=>{
  const {db,repo}=newFixture();
  try{
    const col=await repo.createCollection({name:"Статьи",slug:"saved-articles",sensitivity:"standard"});
    const note=await repo.createEntity({
      collection_id:col.id,domain:"notes",title:"Климатический атлас",
      payload:{type:"note",title:"Климатический атлас",body:""},
      sensitivity:"standard",source_kind:"link",source_ref:"https://example.org/climate",
    });
    const result=await searchApprovedNotes("guest","климатический",repo);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({id:note.id,version:1});
    const read=await readApprovedNote("guest",note.id,1,0,200,repo);
    expect(read.source).toEqual({
      recordId:note.id,sourceRef:"https://example.org/climate",location:"unknown",
    });
    expect(read.evidence.originalPage).toBeNull();
    expect(read.evidence.originalTime).toBeNull();
    expect(read.content).not.toContain("температура");
    await repo.setEntityStatus(note.id,1,"archived");
    expect(await searchApprovedNotes("guest","климатический",repo)).toEqual([]);
    await expect(readApprovedNote("guest",note.id,1,0,200,repo))
      .rejects.toThrow("memory_read_not_available");
  }finally{db.close();}
});
