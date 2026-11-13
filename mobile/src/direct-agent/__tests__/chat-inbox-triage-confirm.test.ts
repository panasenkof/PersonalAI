import { DirectChatStore } from "../chat-store";
import { parseConversation, type ConversationRepository, type SavedConversation } from "../conversations";
import type { InboxTriageProposal } from "../inbox-triage-proposal";
import { applyInboxTriageNotes, undoNotes } from "../../local-memory/note-actions";

jest.mock("../../local-memory/storage",()=>({
  waitForApplicationSession:jest.fn(async()=>{}),
  localMemorySessionUnlocked:jest.fn(()=>true),
  onLocalMemorySessionChange:jest.fn(()=>()=>{}),
  withLocalMemoryDatabase:jest.fn(async (_profile:string,fn:(db:any)=>Promise<any>)=>fn({})),
}));
jest.mock("../../local-memory/note-actions",()=>({
  applyInboxTriageNotes:jest.fn(async()=>({
    batch:"notes:inbox_triage:batch-test",applied:["n2"],skipped:[],
  })),
  undoNotes:jest.fn(async()=>{}),
}));
jest.mock("../memory",()=>({
  searchApprovedNotes:jest.fn(async()=>[]),saveApprovedNote:jest.fn(),
  proposableMemorySections:jest.fn(async()=>[]),
}));
jest.mock("expo-crypto",()=>({randomUUID:()=> "id-"+Math.random().toString(36).slice(2)}));

const proposal:InboxTriageProposal={items:[
  {noteId:"n1",expectedVersion:3,targetSectionSlug:"projects",tags:["a"],
    displayTitle:"План",targetSectionName:"Проекты",reason:"Относится к проектам"},
  {noteId:"n2",expectedVersion:7,targetSectionSlug:"notes",tags:["b"],
    displayTitle:"Идея",targetSectionName:"Заметки",reason:"Общая заметка"},
]};
function fixture() {
  const c:SavedConversation={id:"c1",title:"Разбор",createdAt:"2026-11-13T10:00:00.000Z",
    updatedAt:"2026-11-13T10:00:00.000Z",question:"",drafts:[],rows:[
      {id:"p1",role:"assistant",text:"Предлагаю распределить",inboxTriageProposal:proposal,inboxTriageResult:true},
    ]};
  const rows=new Map<string,SavedConversation>([["c1",c]]);
  const repo:ConversationRepository={
    load:jest.fn(async()=>[...rows.values()]),
    save:jest.fn(async value=>{rows.set(value.id,JSON.parse(JSON.stringify(value)));}),
    remove:jest.fn(async id=>{rows.delete(id);}),
  };
  return {rows,repo};
}
beforeEach(()=>jest.clearAllMocks());
test("S9-1c4: only selected rows are written, receipt persisted, existing undo handles batch",async()=>{
  const {repo,rows}=fixture();
  const store=new DirectChatStore("guest",repo,jest.fn());
  await store.initialize();
  await store.confirmProposal("p1",undefined,["n2"]);
  expect(applyInboxTriageNotes).toHaveBeenCalledTimes(1);
  expect((applyInboxTriageNotes as jest.Mock).mock.calls[0][1]).toEqual([{
    noteId:"n2",expectedVersion:7,targetSectionSlug:"notes",tags:["b"],
  }]);
  const row=store.getSnapshot().conversations[0].rows.find(x=>x.id==="p1");
  expect(row?.inboxTriageProposal).toBeUndefined();
  expect(row?.inboxTriageReceipt?.applied).toEqual(["n2"]);
  await store.undoProposal("p1");
  expect(undoNotes).toHaveBeenCalledWith(expect.anything(),"notes:inbox_triage:batch-test");
  const reversed=store.getSnapshot().conversations[0].rows.find(x=>x.id==="p1");
  expect(reversed?.inboxTriageReceipt?.undone).toBe(true);
  await store.checkpoint();
  expect(parseConversation(JSON.stringify(rows.get("c1")))?.rows[0].inboxTriageReceipt?.undone).toBe(true);
  store.dispose();
});
test("S9-1c4: no implicit all-selection, rejection and bogus note IDs cannot write",async()=>{
  const {repo}=fixture();const store=new DirectChatStore("guest",repo,jest.fn());
  await store.initialize();
  await store.confirmProposal("p1");
  await store.confirmProposal("p1",undefined,["forged"]);
  expect(applyInboxTriageNotes).not.toHaveBeenCalled();
  expect(store.getSnapshot().conversations[0].rows[0].inboxTriageProposal).toEqual(proposal);
  store.dismissProposal("p1");
  expect(store.getSnapshot().conversations[0].rows[0].inboxTriageProposal).toBeUndefined();
  expect(applyInboxTriageNotes).not.toHaveBeenCalled();
  store.dispose();
});
test("S9-1c4: once app reloads, stale proposal isn't reauthorized; undo receipt survives",()=>{
  const {rows}=fixture();
  expect(parseConversation(JSON.stringify(rows.get("c1")))?.rows[0].inboxTriageProposal).toBeUndefined();
  expect(parseConversation(JSON.stringify({
    ...rows.get("c1"),rows:[{id:"p1",role:"assistant",text:"Готово",inboxTriageReceipt:{
      batch:"notes:inbox_triage:batch-test",applied:["n2"],skipped:[]}}],
  }))?.rows[0].inboxTriageReceipt?.applied).toEqual(["n2"]);
});
