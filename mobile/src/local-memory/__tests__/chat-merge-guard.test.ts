import { changeNotes, undoNotes } from "../note-actions";

jest.mock("expo-crypto",()=>({randomUUID:jest.fn(()=>"merge-test")}));
jest.mock("../storage",()=>({localMemorySessionUnlocked:jest.fn(()=>true)}));
jest.mock("../transaction",()=>({
  withUnlockedTransaction:jest.fn(async (db:unknown,fn:(tx:unknown)=>Promise<unknown>)=>fn(db)),
}));
jest.mock("../search-index",()=>({
  indexEntity:jest.fn(async()=>undefined),memoryText:jest.fn((p:{body?:string})=>p.body||""),
}));
const sections=[
  {id:"root",slug:"projects",sensitivity:"standard",parent_id:null},
  {id:"nested",slug:"work",sensitivity:"standard",parent_id:"root"},
];
const note=(id:string,version:number)=>({
  id,collection_id:"nested",domain:"notes",record_status:"active",
  record_version:version,sensitivity:"inherit",payload_json:JSON.stringify({body:"Общий текст",tags:["идеи"]}),
  title:"Заметка "+id,source_kind:"manual",source_ref:null,valid_from:null,valid_until:null,
});
const before=[note("n1",2),note("n2",3)];
const batch="notes:merge:merge-test";
const guard={noteIds:["n1","n2"],keepNoteId:"n1"};
function fakeDb(customSections=sections){
  const runAsync=jest.fn(async (..._args:any[])=>({changes:1}));
  const getFirstAsync=jest.fn(async (sql:string,params?:unknown[])=>{
    if(sql.includes("SELECT * FROM memory_entities WHERE id=?"))
      return before.find(row=>row.id===params?.[0])||null;
    if(sql.includes("SELECT sensitivity FROM memory_collections WHERE id=?"))
      return {sensitivity:"standard"};
    if(sql.includes("SELECT 1 AS linked"))return null;
    throw new Error("unexpected scalar SQL: "+sql);
  });
  const getAllAsync=jest.fn(async (sql:string)=>{
    if(sql.includes("FROM memory_collections"))return customSections;
    if(sql.includes("FROM memory_attachments"))return [];
    if(sql.includes("FROM memory_received_shares"))return [];
    throw new Error("unexpected array SQL: "+sql);
  });
  return {runAsync,getFirstAsync,getAllAsync,execAsync:jest.fn()};
}
const selection=[{id:"n1",record_version:2},{id:"n2",record_version:3}];
test("S9-2c: only explicit keep-first selection can invoke guarded canonical merge",async()=>{
  const db=fakeDb();
  await expect(changeNotes(db as never,"merge",[...selection].reverse(),
    undefined,undefined,undefined,guard)).rejects.toThrow("invalid_confirmed_merge");
  expect(db.runAsync).not.toHaveBeenCalled();
});
test("S9-2c: ordinary nested sources can merge through existing canonical revision writer",async()=>{
  const db=fakeDb();
  expect(await changeNotes(db as never,"merge",selection,
    undefined,undefined,undefined,guard)).toBe(batch);
  const calls=db.runAsync.mock.calls;
  expect(calls.some(([sql])=>sql.includes("UPDATE memory_entities"))).toBe(true);
  expect(calls.some(([sql])=>sql.includes("INSERT INTO memory_revisions"))).toBe(true);
});
test("S9-2c: protected or orphaned ancestor blocks ALL changes before writer",async()=>{
  const blocked=[
    {...sections[0],sensitivity:"sensitive"},
    sections[1],
  ];
  const db=fakeDb(blocked);
  await expect(changeNotes(db as never,"merge",selection,
    undefined,undefined,undefined,guard)).rejects.toThrow("merge_review_acl_changed");
  expect(db.runAsync).not.toHaveBeenCalled();
  const db2=fakeDb([sections[1]]);
  await expect(changeNotes(db2 as never,"merge",selection,
    undefined,undefined,undefined,guard)).rejects.toThrow("merge_review_acl_changed");
  expect(db2.runAsync).not.toHaveBeenCalled();
});
test("S9-2c: stale version cannot write and user changes survive",async()=>{
  const db=fakeDb();
  await expect(changeNotes(db as never,"merge",[
    selection[0],{id:"n2",record_version:4}],undefined,undefined,undefined,guard))
    .rejects.toThrow("stale_memory_version");
  expect(db.runAsync).not.toHaveBeenCalled();
});
test("S9-2c: Undo rejects forged batch before database work",async()=>{
  const db=fakeDb();
  await expect(undoNotes(db as never,"notes:move:merge-test",undefined,guard))
    .rejects.toThrow("invalid_merge_undo");
  expect(db.getAllAsync).not.toHaveBeenCalled();
});
