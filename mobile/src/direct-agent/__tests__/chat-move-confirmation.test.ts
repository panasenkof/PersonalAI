import { DirectChatStore } from "../chat-store";
import { parseConversation,type ConversationRepository,type SavedConversation } from "../conversations";
import { previewMove,confirmMove,undoMove } from "../move-proposal";
import { localMemorySessionUnlocked,waitForApplicationSession } from "../../local-memory/storage";
import type { ChatMoveProposal } from "../move-proposal";

jest.mock("../../local-memory/storage",()=>({
  waitForApplicationSession:jest.fn(async()=>{}),withLocalMemoryDatabase:jest.fn(),
  localMemorySessionUnlocked:jest.fn(()=>true),
  onLocalMemorySessionChange: jest.fn(() => () => {}),
}));
jest.mock("../move-proposal",()=>({
  ...jest.requireActual("../move-proposal"),
  previewMove:jest.fn(),confirmMove:jest.fn(),undoMove:jest.fn(),
}));
jest.mock("expo-crypto",()=>({randomUUID:()=>"id-"+Math.random().toString(36).slice(2)}));
jest.mock("../agent-preferences",()=>({loadModelCallLimit:jest.fn(async()=>4)}));
const settings={provider:"openai",apiKey:"not-actually-sent",model:"remote",
  baseUrl:"https://api.openai.com/v1",allowWeb:false} as any;
const preview:ChatMoveProposal={
  noteId:"note-1",expectedVersion:2,title:"Рецепт лазаньи",
  fromCollectionId:"c-notes",fromName:"Заметки",
  toCollectionId:"c-recipes",toName:"Рецепты",
  reason:"Это рецепт и его лучше хранить с остальными",
  attachmentCount:1,hasSource:true,
};
const receipt={noteId:preview.noteId,title:preview.title,
  fromCollectionId:preview.fromCollectionId,fromName:preview.fromName,
  toCollectionId:preview.toCollectionId,toName:preview.toName,
  batch:"notes:move:11111111-2222-3333-4444-555555555555",verified:true};
function fixture(){
  const records=new Map<string,SavedConversation>();
  const repo:ConversationRepository={
    load:jest.fn(async()=>[...records.values()].map(v=>JSON.parse(JSON.stringify(v)))),
    save:jest.fn(async c=>{records.set(c.id,JSON.parse(JSON.stringify(c)));}),
    remove:jest.fn(async id=>{records.delete(id);}),
  };
  const runner=jest.fn().mockResolvedValue({text:"Предлагаю перенос",sources:[],requests:2,
    moveProposal:preview});
  return {repo,records,runner};
}
beforeEach(()=>{
  jest.clearAllMocks();
  (waitForApplicationSession as jest.Mock).mockResolvedValue(undefined);
  (localMemorySessionUnlocked as jest.Mock).mockReturnValue(true);
  (previewMove as jest.Mock).mockResolvedValue(preview);
  (confirmMove as jest.Mock).mockResolvedValue(receipt);
  (undoMove as jest.Mock).mockResolvedValue(undefined);
});
async function proposed(){
  const {repo,records,runner}=fixture();
  const store=new DirectChatStore("guest",repo,runner);await store.initialize();
  const id=store.getSnapshot().activeId!;
  store.setQuestion("Перенеси заметку про лазанью в Рецепты");
  await store.send(settings);
  const row=store.getSnapshot().conversations[0].rows.at(-1)!;
  expect(row.moveProposal).toEqual(preview);
  return {store,records,runner,row,id};
}

test("9T2: preview is only an agent answer, never an automatic memory write",async()=>{
  const {store,records,runner,row,id}=await proposed();
  expect(runner).toHaveBeenCalledTimes(1);
  expect(typeof runner.mock.calls[0][0].previewMove).toBe("function");
  expect(confirmMove).not.toHaveBeenCalled();
  expect(undoMove).not.toHaveBeenCalled();
  expect(parseConversation(JSON.stringify(records.get(id)))?.rows.at(-1)?.moveProposal).toEqual(preview);
  store.dispose();
});

test("9T2: the model-initiated preview reads only after unlocked host check",async()=>{
  const {store,runner}=await proposed();
  const args={noteId:"note-1",expectedVersion:2,targetSectionSlug:"recipes",
    reason:preview.reason};
  expect(await runner.mock.calls[0][0].previewMove(args)).toEqual(preview);
  expect(previewMove).toHaveBeenCalledWith("guest",args);
  (localMemorySessionUnlocked as jest.Mock).mockReturnValue(false);
  await expect(runner.mock.calls[0][0].previewMove(args))
    .rejects.toThrow("application_locked");
  expect(previewMove).toHaveBeenCalledTimes(1);
  store.dispose();
});

test("9T2: explicit confirm writes via canonical wrapper and exposes persistent undo receipt",async()=>{
  const {store,records,row,id}=await proposed();
  await store.confirmMoveProposal(row.id);
  expect(confirmMove).toHaveBeenCalledTimes(1);
  expect(confirmMove).toHaveBeenCalledWith("guest",preview);
  const result=store.getSnapshot().conversations[0].rows.find(x=>x.id===row.id)!;
  expect(result.moveProposal).toBeUndefined();
  expect(result.moveReceipt).toEqual(receipt);
  expect(parseConversation(JSON.stringify(records.get(id)))?.rows.find(x=>x.id===row.id)?.moveReceipt)
    .toEqual(receipt);
  expect(store.getSnapshot().conversations[0].rows.at(-1)?.text).toContain("Доступна отмена");
  store.dispose();
});

test("9T2: normal cancel changes only SQLCipher chat history and never the actual note",async()=>{
  const {store,records,row,id}=await proposed();
  store.cancelMoveProposal(row.id);
  await store.checkpoint();
  const result=store.getSnapshot().conversations[0].rows.find(x=>x.id===row.id)!;
  expect(result.moveProposal).toBeUndefined();
  expect(result.moveReceipt).toBeUndefined();
  expect(confirmMove).not.toHaveBeenCalled();
  expect(undoMove).not.toHaveBeenCalled();
  expect(parseConversation(JSON.stringify(records.get(id)))?.rows.find(x=>x.id===row.id)?.moveProposal)
    .toBeUndefined();
  store.dispose();
});

test("9T2: explicit undo uses the existing note revision batch and disables repeat undo",async()=>{
  const {store,records,row,id}=await proposed();
  await store.confirmMoveProposal(row.id);
  await store.undoConfirmedMove(row.id);
  expect(undoMove).toHaveBeenCalledTimes(1);
  expect(undoMove).toHaveBeenCalledWith("guest",receipt);
  const final=store.getSnapshot().conversations[0].rows.find(x=>x.id===row.id)!;
  expect(final.moveReceipt?.undone).toBe(true);
  expect(parseConversation(JSON.stringify(records.get(id)))?.rows.find(x=>x.id===row.id)?.moveReceipt?.undone)
    .toBe(true);
  await store.undoConfirmedMove(row.id);
  expect(undoMove).toHaveBeenCalledTimes(1);
  store.dispose();
});

test("9T2: CAS/ACL conflict preserves proposal, shows error and cannot claim success",async()=>{
  const {store,row}=await proposed();
  (confirmMove as jest.Mock).mockRejectedValueOnce(new Error("stale_memory_version"));
  await store.confirmMoveProposal(row.id);
  expect(store.getSnapshot().conversations[0].rows.find(x=>x.id===row.id)?.moveProposal).toEqual(preview);
  expect(store.getSnapshot().conversations[0].rows.some(x=>Boolean(x.moveReceipt))).toBe(false);
  expect(store.getSnapshot().error).toContain("верс");
  expect(store.getSnapshot().conversations[0].movingRowId).toBeUndefined();
  store.dispose();
});

test("9T2: failed undo leaves receipt actionable; no fabricated restored-state claim",async()=>{
  const {store,row}=await proposed();
  await store.confirmMoveProposal(row.id);
  (undoMove as jest.Mock).mockRejectedValueOnce(new Error("stale_memory_version"));
  await store.undoConfirmedMove(row.id);
  expect(store.getSnapshot().conversations[0].rows.find(x=>x.id===row.id)?.moveReceipt?.undone)
    .toBeUndefined();
  expect(store.getSnapshot().error).toContain("Отмена не выполнена");
  store.dispose();
});

test("9T2: moving is disabled during another busy LLM turn and never repeats",async()=>{
  const {store,row}=await proposed();
  store.setQuestion("Другой вопрос");
  let resolve!: (value:any)=>void;
  const runner=(store as any).runner as jest.Mock;
  runner.mockImplementationOnce(()=>new Promise(r=>resolve=r));
  const sent=store.send(settings);
  for(let i=0;i<20&&!runner.mock.calls[1];i++)await Promise.resolve();
  await store.confirmMoveProposal(row.id);
  expect(confirmMove).not.toHaveBeenCalled();
  resolve({text:"Другое",sources:[],requests:1});
  await sent;
  store.dispose();
});
