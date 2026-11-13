import { applyInboxTriageNotes } from "../note-actions";

jest.mock("expo-crypto",()=>({randomUUID:jest.fn(()=>"batch-test")}));
jest.mock("../storage",()=>({localMemorySessionUnlocked:jest.fn(()=>true)}));
jest.mock("../transaction",()=>({
  withUnlockedTransaction:jest.fn(async (db:unknown,fn:(tx:unknown)=>Promise<unknown>)=>fn(db)),
}));
jest.mock("../search-index",()=>({
  indexEntity:jest.fn(async()=>undefined),
  memoryText:jest.fn(()=>""), 
}));
const collections=[
  {id:"inbox-id",slug:"inbox",sensitivity:"sensitive",parent_id:null},
  {id:"projects-id",slug:"projects",sensitivity:"standard",parent_id:null},
];
const note=(id:string,version:number)=>({
  id,collection_id:"inbox-id",domain:"notes",record_version:version,
  record_status:"active",sensitivity:"inherit",payload_json:JSON.stringify({body:"Пример",tags:["важно"]}),
  title:"Тест",created_at:"2026-11-13T10:00:00.000Z",
});
function fakeDb(rows:Record<string,ReturnType<typeof note>>, sections=collections){
  const runAsync=jest.fn(async (..._args:any[])=>({changes:1}));
  const getAllAsync=jest.fn(async(sql:string)=>{
    if(sql.includes("FROM memory_collections"))return sections;
    if(sql.includes("FROM memory_attachments"))return [];
    throw new Error("unexpected list: "+sql);
  });
  const getFirstAsync=jest.fn(async(sql:string,args?:unknown[])=>{
    if(sql.includes("FROM memory_entities"))return rows[String(args?.[0])]??null;
    throw new Error("unexpected read: "+sql);
  });
  return {runAsync,getAllAsync,getFirstAsync,execAsync:jest.fn()};
}
const suggestion=(id="note1",version=3)=>({
  noteId:id,expectedVersion:version,targetSectionSlug:"projects",tags:["AI"],
});
test("S9-1c3: confirmed move and tags use one canonical revision + FTS",async()=>{
  const db=fakeDb({note1:note("note1",3)});
  const result=await applyInboxTriageNotes(db as never,[suggestion()]);
  expect(result).toEqual({batch:"notes:inbox_triage:batch-test",applied:["note1"],skipped:[]});
  const update=db.runAsync.mock.calls.find(call=>call[0].includes("UPDATE memory_entities"));
  expect(update).toBeDefined();
  expect(update![1][0]).toBe("projects-id");
  expect(update![1][3]).toBe("standard");
  expect(JSON.parse(update![1][1]).tags).toEqual(["ai","важно"]);
  expect(db.runAsync.mock.calls.some(call=>call[0].includes("INSERT INTO memory_revisions"))).toBe(true);
});
test("S9-1c3: stale version is skipped without writes",async()=>{
  const db=fakeDb({note1:note("note1",4)});
  expect(await applyInboxTriageNotes(db as never,[suggestion()]))
    .toMatchObject({applied:[],skipped:["note1"]});
  expect(db.runAsync).not.toHaveBeenCalled();
});
test("S9-1c3: secret and moved-away records rejected",async()=>{
  const db=fakeDb({note1:{...note("note1",3),sensitivity:"secret"}});
  await expect(applyInboxTriageNotes(db as never,[suggestion()]))
    .rejects.toThrow("inbox_note_acl_changed");
  expect(db.runAsync).not.toHaveBeenCalled();
});
test("S9-1c3: destination ACL change fails before any memory write",async()=>{
  const db=fakeDb({note1:note("note1",3)},[
    collections[0],{...collections[1],sensitivity:"secret"},
  ]);
  await expect(applyInboxTriageNotes(db as never,[suggestion()]))
    .rejects.toThrow("inbox_target_acl_changed");
  expect(db.runAsync).not.toHaveBeenCalled();
});
test("S9-1c3: duplicate and malformed selections rejected",async()=>{
  const db=fakeDb({note1:note("note1",3)});
  await expect(applyInboxTriageNotes(db as never,[suggestion(),suggestion()]))
    .rejects.toThrow("invalid_inbox_triage_selection");
  await expect(applyInboxTriageNotes(db as never,[{...suggestion(),tags:["bad tag"]}]))
    .rejects.toThrow();
  expect(db.runAsync).not.toHaveBeenCalled();
});
