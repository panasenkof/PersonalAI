/** SEC-04/08/SEARCH-06: on-device agent lookup/reader must use one
 * unlocked SQLCipher transaction for collection ACL and returned content.
 * Tests isolate the transaction boundary; real SQL semantics are exercised
 * separately in memory-sql-acceptance.test.ts.
 */
import { searchApprovedNotes, readApprovedNote } from "../memory";
import { SqliteMemoryRepository } from "../../local-memory/repository";

let mockEvents:string[]=[];
const mockConnection={
  execAsync:jest.fn(async(sql:string)=>{mockEvents.push(sql);}),
};
jest.mock("../../local-memory/storage",()=>({
  openLocalMemory:jest.fn(async()=>undefined),
  withLocalMemoryDatabase:jest.fn(async(_profile:string,run:(db:unknown)=>Promise<unknown>)=>
    run(mockConnection)),
}));
jest.mock("expo-crypto",()=>({randomUUID:()=>require("node:crypto").randomUUID()}));

const allowed={id:"open",slug:"notes",name:"Заметки",sensitivity:"standard",created_at:"2026-10-29"};
const entity={
  id:"note-1",collection_id:"open",domain:"notes",title:"Рецепт",payload:{body:"Добавить зиру"},
  record_version:1,record_status:"active",sensitivity:"standard",
  kind:"note",source_ref:"user-confirmed",source_kind:"user",
  schema_version:"1",valid_from:null,valid_until:null,created_at:"2026-10-29",
  updated_at:"2026-10-29",
};
beforeEach(()=>{
  jest.restoreAllMocks();jest.clearAllMocks();mockEvents=[];
  jest.spyOn(SqliteMemoryRepository.prototype,"listCollections").mockImplementation(async()=>{
    mockEvents.push("collections");
    return [allowed] as never;
  });
  jest.spyOn(SqliteMemoryRepository.prototype,"searchMemory").mockImplementation(async()=>{
    mockEvents.push("search");
    return [{entity,chunk:"Добавить зиру",score:1}] as never;
  });
  jest.spyOn(SqliteMemoryRepository.prototype,"entity").mockImplementation(async()=>{
    mockEvents.push("entity");
    return entity as never;
  });
});

test("SEC-08: actual agent search authorizes sections and search under SAME SQLCipher lock",async()=>{
  const res=await searchApprovedNotes("guest","зиру",undefined,async()=>null);
  expect(res).toEqual([expect.objectContaining({id:"note-1",version:1,body:"Добавить зиру"})]);
  expect(mockEvents).toEqual([
    "collections", // preflight only; no permission granted
    "BEGIN IMMEDIATE",
    "collections", // authoritative current ACL inside lock
    "search",
    "COMMIT",
  ]);
});

test("SEC-08: original read checks record and collection privacy inside one snapshot",async()=>{
  const res=await readApprovedNote("guest","note-1",1);
  expect(res).toMatchObject({id:"note-1",revision:1,source:{recordId:"note-1"}});
  expect(mockEvents).toEqual(["BEGIN IMMEDIATE","entity","collections","COMMIT"]);
});

test("SEC-04: late denial rolls back and returns no search or source text",async()=>{
  jest.spyOn(SqliteMemoryRepository.prototype,"listCollections").mockImplementation(async()=>{
    mockEvents.push("collections"); return mockEvents.includes("BEGIN IMMEDIATE")?[
      {...allowed,sensitivity:"secret"},
    ] as never:[allowed] as never;
  });
  const res=await searchApprovedNotes("guest","зиру",undefined,async()=>null);
  expect(res).toEqual([]);
  expect(mockEvents).toEqual(["collections","BEGIN IMMEDIATE","collections","COMMIT"]);
  expect(mockEvents).not.toContain("search");
  mockEvents=[];
  jest.spyOn(SqliteMemoryRepository.prototype,"listCollections").mockImplementation(async()=>{
    mockEvents.push("collections");return [{...allowed,sensitivity:"secret"}] as never;
  });
  await expect(readApprovedNote("guest","note-1",1)).rejects.toThrow("memory_read_not_available");
  expect(mockEvents).toEqual(["BEGIN IMMEDIATE","entity","collections","ROLLBACK"]);
});
