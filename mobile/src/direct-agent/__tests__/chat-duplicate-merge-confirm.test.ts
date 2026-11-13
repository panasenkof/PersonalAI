import { DirectChatStore } from "../chat-store";
import { parseConversation, type ConversationRepository, type SavedConversation } from "../conversations";
import { changeNotes, undoNotes } from "../../local-memory/note-actions";
import type { VerifiedDuplicateMergeRequest } from "../duplicate-merge-gate";

jest.mock("../../local-memory/storage",()=>({
  waitForApplicationSession:jest.fn(async()=>{}),
  localMemorySessionUnlocked:jest.fn(()=>true),
  onLocalMemorySessionChange:jest.fn(()=>()=>{}),
  withLocalMemoryDatabase:jest.fn(async (_profile:string,fn:(db:any)=>Promise<any>)=>fn({})),
}));
jest.mock("../../local-memory/note-actions",()=>({
  changeNotes:jest.fn(async()=>"notes:merge:merge-test"),
  undoNotes:jest.fn(async()=>{}),
}));
jest.mock("../memory",()=>({
  searchApprovedNotes:jest.fn(async()=>[]),saveApprovedNote:jest.fn(),
  proposableMemorySections:jest.fn(async()=>[]),
}));
jest.mock("expo-crypto",()=>({randomUUID:()=>"test-id"}));

const proposal:VerifiedDuplicateMergeRequest={
  fingerprint:"a".repeat(64),
  noteIds:["n2","n1"],expectedVersions:[7,3],
  keepNoteId:"n2",reason:"Один и тот же источник",
  attachmentCount:2,sourceTagEntries:4,
  records:[
    {id:"n2",version:7,title:"Оставить",section:"Проекты",collectionId:"projects",attachmentCount:1,tagCount:2},
    {id:"n1",version:3,title:"Источник",section:"Заметки",collectionId:"notes",attachmentCount:1,tagCount:2},
  ],
};
function fixture(){
  const c:SavedConversation={id:"c1",title:"Дубли",createdAt:"2026-11-13T10:00:00.000Z",
    updatedAt:"2026-11-13T10:00:00.000Z",question:"",drafts:[],rows:[
      {id:"merge1",role:"assistant",text:"Дубли найдены",duplicateMergeProposal:proposal},
    ]};
  const records=new Map<string,SavedConversation>([["c1",c]]);
  const repo:ConversationRepository={
    load:jest.fn(async()=>[...records.values()]),
    save:jest.fn(async next=>{records.set(next.id,JSON.parse(JSON.stringify(next)));}),
    remove:jest.fn(async id=>{records.delete(id);}),
  };
  return {records,repo};
}
beforeEach(()=>jest.clearAllMocks());

test("S9-2d: only click invokes the existing merge writer, keep-first and one batch",async()=>{
  const {repo}=fixture();
  const store=new DirectChatStore("guest",repo,jest.fn());
  await store.initialize();
  expect(changeNotes).not.toHaveBeenCalled();
  await store.confirmProposal("merge1");
  expect(changeNotes).toHaveBeenCalledTimes(1);
  const args=(changeNotes as jest.Mock).mock.calls[0];
  expect(args[1]).toBe("merge");
  expect(args[2]).toEqual([{id:"n2",record_version:7},{id:"n1",record_version:3}]);
  expect(args[6]).toEqual({noteIds:["n2","n1"],keepNoteId:"n2"});
  const row=store.getSnapshot().conversations[0].rows.find(r=>r.id==="merge1");
  expect(row?.duplicateMergeProposal).toBeUndefined();
  expect(row?.duplicateMergeReceipt).toMatchObject({
    batch:"notes:merge:merge-test",keepNoteId:"n2",mergedCount:1,
  });
  await store.undoProposal("merge1");
  expect(undoNotes).toHaveBeenCalledWith(expect.anything(),"notes:merge:merge-test",
    undefined,{noteIds:["n2","n1"],keepNoteId:"n2"});
  expect(store.getSnapshot().conversations[0].rows.find(r=>r.id==="merge1")
    ?.duplicateMergeReceipt?.undone).toBe(true);
  store.dispose();
});

test("S9-2d: rejecting a merge card never writes to memory",async()=>{
  const {repo}=fixture();
  const store=new DirectChatStore("guest",repo,jest.fn());
  await store.initialize();
  store.dismissProposal("merge1");
  expect(changeNotes).not.toHaveBeenCalled();
  expect(store.getSnapshot().conversations[0].rows[0].duplicateMergeProposal).toBeUndefined();
  store.dispose();
});

test("S9-2d: reload never reauthorizes an old proposal, receipt can be undone",()=>{
  const {records}=fixture();
  expect(parseConversation(JSON.stringify(records.get("c1")))?.rows[0]
    .duplicateMergeProposal).toBeUndefined();
  expect(parseConversation(JSON.stringify({
    ...records.get("c1"),rows:[{id:"merge1",role:"assistant",text:"Готово",
      duplicateMergeReceipt:{batch:"notes:merge:merge-test",keepNoteId:"n2",
        noteIds:["n2","n1"],mergedCount:1}}],
  }))?.rows[0].duplicateMergeReceipt?.batch).toBe("notes:merge:merge-test");
});
