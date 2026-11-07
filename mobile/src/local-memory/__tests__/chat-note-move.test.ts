/** 9T2: real canonical note-actions functions, synthetic SQLCipher connection.
 * Covers C3-B guard evaluation INSIDE the transaction, before any update.
 * A real native SQLCipher/AppLock smoke remains a separate acceptance gate. */
import { changeNotes,undoNotes } from "../note-actions";
import { localMemorySessionUnlocked } from "../storage";
import { indexEntity } from "../search-index";

jest.mock("../storage",()=>({localMemorySessionUnlocked:jest.fn(()=>true)}));
jest.mock("../search-index",()=>({indexEntity:jest.fn(async()=>{}),
  memoryText:jest.fn(()=>""),}));
jest.mock("expo-crypto",()=>({randomUUID:()=>("12345678-1234-1234-1234-1234567890ab")}));
const unlocked=localMemorySessionUnlocked as jest.Mock;
const sourceId="c-notes",targetId="c-projects",noteId="note-1";
const guard={noteId,fromCollectionId:sourceId,toCollectionId:targetId};
function dbFixture(options?:{sourceSensitivity?:string;targetSensitivity?:string;
    recordSensitivity?:string;recordVersion?:number;recordStatus?:string;
    domain?:string;sourceCollectionId?:string;}){
  const cols=[
    {id:sourceId,sensitivity:options?.sourceSensitivity??"standard"},
    {id:targetId,sensitivity:options?.targetSensitivity??"standard"},
  ];
  const row:any={id:noteId,collection_id:options?.sourceCollectionId??sourceId,
    domain:options?.domain??"notes",record_status:options?.recordStatus??"active",
    sensitivity:options?.recordSensitivity??"standard",title:"Test note",
    record_version:options?.recordVersion??4,payload_json:JSON.stringify({body:"Original body"}),
    updated_at:"2026-11-07T00:00:00Z"};
  const events:string[]=[];
  const revisions:Array<{before_json:string;after_json:string;reason:string}>=[];
  const db={
    execAsync:jest.fn(async(sql:string)=>{events.push(sql);}),
    getFirstAsync:jest.fn(async(sql:string,args?:any[])=>{
      if(sql.startsWith("SELECT * FROM memory_entities"))return {...row};
      if(sql.startsWith("SELECT id FROM memory_collections"))return cols.find(c=>c.id===args?.[0])||null;
      if(sql.startsWith("SELECT sensitivity FROM memory_collections"))
        return cols.find(c=>c.id===args?.[0])||null;
      throw new Error("Unexpected getFirst: "+sql);
    }),
    getAllAsync:jest.fn(async(sql:string,args?:any[])=>{
      if(sql.startsWith("SELECT id FROM memory_attachments"))return [{id:"attached-photo"}];
      if(sql.startsWith("SELECT id,sensitivity FROM memory_collections"))
        return cols.filter(c=>args?.includes(c.id));
      if(sql.startsWith("SELECT before_json,after_json FROM memory_revisions"))
        return revisions.filter(r=>r.reason===args?.[0]);
      throw new Error("Unexpected getAll: "+sql);
    }),
    runAsync:jest.fn(async(sql:string,args:any[])=>{
      if(sql.startsWith("UPDATE memory_entities")){
        if(row.id!==args[7]||row.record_version!==args[8])
          throw new Error("CAS mismatch");
        Object.assign(row,{collection_id:args[0],payload_json:args[1],title:args[2],
          sensitivity:args[3],record_status:args[4],record_version:args[5],
          updated_at:args[6]});
        return {changes:1};
      }
      if(sql.startsWith("INSERT INTO memory_revisions")){
        revisions.push({reason:args[5],before_json:args[7],after_json:args[8]});
        return {changes:1};
      }
      if(sql.startsWith("UPDATE memory_attachments"))return {changes:1};
      throw new Error("Unexpected run: "+sql);
    }),
  };
  return {db,row,cols,events,revisions};
}
beforeEach(()=>{jest.clearAllMocks();unlocked.mockReturnValue(true);});

test("9T2: a standard note moves in one canonical transaction with versioned revision and unchanged original payload",async()=>{
  const {db,row,events,revisions}=dbFixture();
  const batch=await changeNotes(db as any,"move",[{id:noteId,record_version:4}],
    targetId,undefined,guard);
  expect(batch).toMatch(/^notes:move:/);
  expect(events).toEqual(["BEGIN IMMEDIATE","COMMIT"]);
  expect(row).toMatchObject({collection_id:targetId,record_version:5,
    record_status:"active",sensitivity:"standard"});
  expect(JSON.parse(row.payload_json)).toEqual({body:"Original body"});
  expect(revisions).toHaveLength(1);
  expect(JSON.parse(revisions[0].before_json)).toMatchObject({
    collection_id:sourceId,record_version:4,attachmentIds:["attached-photo"],
  });
  expect(indexEntity).toHaveBeenCalledWith(db,noteId,expect.any(String));
});

test.each([
  ["stale version",{recordVersion:5}],
  ["archived record",{recordStatus:"archived"}],
  ["sensitive record",{recordSensitivity:"secret"}],
  ["sensitive source collection",{sourceSensitivity:"secret"}],
  ["sensitive target collection",{targetSensitivity:"sensitive"}],
  ["wrong source collection",{sourceCollectionId:"unknown"}],
  ["non-notes domain",{domain:"documents"}],
])("9T2: %s never passes the atomic gate before UPDATE",async(_name,options)=>{
  const {db,events,revisions}=dbFixture(options);
  await expect(changeNotes(db as any,"move",[{id:noteId,record_version:4}],
    targetId,undefined,guard)).rejects.toThrow();
  expect(events).toEqual(["BEGIN IMMEDIATE","ROLLBACK"]);
  expect(revisions).toEqual([]);
  expect(db.runAsync).not.toHaveBeenCalled();
});

test("9T2: AppLock closing in transaction aborts without any write",async()=>{
  const {db,events}=dbFixture();
  unlocked.mockReturnValue(false);
  await expect(changeNotes(db as any,"move",[{id:noteId,record_version:4}],
    targetId,undefined,guard)).rejects.toThrow("application_locked");
  expect(events).toEqual(["BEGIN IMMEDIATE","ROLLBACK"]);
  expect(db.runAsync).not.toHaveBeenCalled();
});

test("9T2: canonical undo reverts to original section with new revision; later version conflicts deny undo",async()=>{
  const {db,row,revisions,events}=dbFixture();
  const batch=await changeNotes(db as any,"move",[{id:noteId,record_version:4}],
    targetId,undefined,guard);
  await undoNotes(db as any,batch,guard);
  expect(row).toMatchObject({collection_id:sourceId,record_version:6,
    record_status:"active",sensitivity:"standard"});
  expect(JSON.parse(row.payload_json).body).toBe("Original body");
  expect(revisions).toHaveLength(2);
  expect(events).toEqual(["BEGIN IMMEDIATE","COMMIT","BEGIN IMMEDIATE","COMMIT"]);
  await expect(undoNotes(db as any,batch,guard)).rejects.toThrow("stale_memory_version");
  expect(events.slice(-2)).toEqual(["BEGIN IMMEDIATE","ROLLBACK"]);
});

test("9T2: changing target ACL before undo fails closed",async()=>{
  const {db,cols,row,events}=dbFixture();
  const batch=await changeNotes(db as any,"move",[{id:noteId,record_version:4}],
    targetId,undefined,guard);
  cols[1].sensitivity="secret";
  await expect(undoNotes(db as any,batch,guard)).rejects.toThrow("move_undo_review_changed");
  expect(row.collection_id).toBe(targetId);
  expect(events.slice(-2)).toEqual(["BEGIN IMMEDIATE","ROLLBACK"]);
});

test("9T2: unguarded existing note-actions still retain compatibility",async()=>{
  const {db,row}=dbFixture();
  await changeNotes(db as any,"move",[{id:noteId,record_version:4}],targetId);
  expect(row.collection_id).toBe(targetId);
});
