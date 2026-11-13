import { undoNotes } from "../note-actions";

jest.mock("expo-crypto",()=>({randomUUID:jest.fn(()=>"undo-test")}));
jest.mock("../storage",()=>({localMemorySessionUnlocked:jest.fn(()=>true)}));
jest.mock("../transaction",()=>({
  withUnlockedTransaction:jest.fn(async (db:unknown,fn:(tx:unknown)=>Promise<unknown>)=>fn(db)),
}));
jest.mock("../search-index",()=>({indexEntity:jest.fn(async()=>undefined),memoryText:jest.fn(()=>""),}));

const before={
  id:"n1",collection_id:"inbox-id",domain:"notes",record_status:"active",
  sensitivity:"inherit",record_version:3,title:"Личное",payload_json:'{"tags":["до"]}',
  attachmentIds:[],created_at:"2026-11-13T10:00:00Z",
};
const after={...before,collection_id:"projects-id",sensitivity:"standard",record_version:4,
  payload_json:'{"tags":["до","после"]}',batch_participants:["n1"]};
type Section = {id:string;slug:string;sensitivity:string;parent_id:string|null};
const sections:Section[]=[
  {id:"inbox-id",slug:"inbox",sensitivity:"sensitive",parent_id:null},
  {id:"projects-id",slug:"projects",sensitivity:"standard",parent_id:null},
];
const batch="notes:inbox_triage:batch-test";
function dbFixture(customSections:Section[]=sections, customAfter=after){
  const runAsync=jest.fn(async (..._args:any[])=>({changes:1}));
  const getAllAsync=jest.fn(async(sql:string)=>{
    if(sql.includes("FROM memory_revisions"))return [{before_json:JSON.stringify(before),
      after_json:JSON.stringify(after)}];
    if(sql.includes("FROM memory_collections"))return customSections;
    if(sql.includes("FROM memory_attachments"))return [];
    throw new Error("unexpected SQL "+sql);
  });
  const getFirstAsync=jest.fn(async(sql:string)=>{
    if(sql.includes("FROM memory_entities"))return customAfter;
    throw new Error("unexpected SQL "+sql);
  });
  return {runAsync,getAllAsync,getFirstAsync,execAsync:jest.fn()};
}
test("S9-1c4: canonical undo restores Inbox collection, tags and sensitivity",async()=>{
  const db=dbFixture();
  await undoNotes(db as never,batch);
  const update=db.runAsync.mock.calls.find(([sql])=>sql.includes("UPDATE memory_entities"));
  expect(update).toBeDefined();
  expect(update![1][0]).toBe("inbox-id");
  expect(JSON.parse(update![1][1]).tags).toEqual(["до"]);
  expect(update![1][3]).toBe("inherit");
  expect(db.runAsync.mock.calls.some(([sql])=>sql.includes("INSERT INTO memory_revisions")))
    .toBe(true);
});
test("S9-1c4: changed Inbox privacy fails before undoing any note",async()=>{
  const db=dbFixture([{...sections[0],sensitivity:"standard"},sections[1]]);
  await expect(undoNotes(db as never,batch)).rejects.toThrow("inbox_triage_undo_acl_changed");
  expect(db.runAsync).not.toHaveBeenCalled();
});
test("S9-1c4: protected destination ancestors fail closed",async()=>{
  const db=dbFixture([
    sections[0],{...sections[1],parent_id:"secret-id"},
    {id:"secret-id",slug:"private",sensitivity:"secret",parent_id:null},
  ]);
  await expect(undoNotes(db as never,batch)).rejects.toThrow("inbox_triage_undo_acl_changed");
  expect(db.runAsync).not.toHaveBeenCalled();
});
test("S9-1c4: later edits prevent undo",async()=>{
  const db=dbFixture(sections,{...after,record_version:5});
  await expect(undoNotes(db as never,batch)).rejects.toThrow("stale_memory_version");
  expect(db.runAsync).not.toHaveBeenCalled();
});
