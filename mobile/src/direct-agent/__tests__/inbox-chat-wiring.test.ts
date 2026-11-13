import { DirectChatStore } from "../chat-store";
import { parseConversation, type ConversationRepository, type SavedConversation } from "../conversations";
import { defaultDirectPreferences } from "../settings";
import { onLocalMemorySessionChange, waitForApplicationSession } from "../../local-memory/storage";

jest.mock("../../local-memory/storage",()=>({
  waitForApplicationSession:jest.fn(async()=>{}),
  localMemorySessionUnlocked:jest.fn(()=>true),
  onLocalMemorySessionChange:jest.fn(()=>()=>{}),
  withLocalMemoryDatabase:jest.fn(),
}));
jest.mock("../memory",()=>({
  searchApprovedNotes:jest.fn(async()=>[]),
  proposableMemorySections:jest.fn(async()=>[]),
  saveApprovedNote:jest.fn(),
}));
jest.mock("../agent-preferences",()=>({
  loadModelCallLimit:jest.fn(async()=>4),
}));
let seq=0;
jest.mock("expo-crypto",()=>({
  randomUUID:()=> "inbox-ui-"+String(++seq),
}));
const settings={...defaultDirectPreferences,
  model:"test-model",apiKey:"test-key",allowWeb:true,webSearchKey:"test-key"};
const approval={
  conversationId:"",limit:2,label:"Разрешить разбор 2 записей из «Входящих»",
};
function repo() {
  const records=new Map<string,SavedConversation>();
  const storage:ConversationRepository={
    load:jest.fn(async()=>[...records.values()].map(x=>JSON.parse(JSON.stringify(x)))),
    save:jest.fn(async c=>{records.set(c.id,JSON.parse(JSON.stringify(c)));}),
    remove:jest.fn(async id=>{records.delete(id);}),
  };
  return {storage,records};
}

beforeEach(()=>{
  seq=0;
  jest.clearAllMocks();
  (waitForApplicationSession as jest.Mock).mockResolvedValue(undefined);
});

test("S9-1b: LLM consent card awaits tap; only following turn can expose private reader",async()=>{
  const {storage,records}=repo();
  const runner=jest.fn(async(opts:any)=>{
    if(runner.mock.calls.length===1){
      expect(opts.listInboxForTriage).toBeUndefined();
      expect(opts.requestInboxTriageApproval).toEqual(expect.any(Function));
      const result=opts.requestInboxTriageApproval(2);
      expect(result).toMatchObject({conversationId:opts.context?.id || expect.any(String),limit:2});
      return {text:"Требуется разрешение",sources:[],requests:1,inboxApproval:result};
    }
    expect(opts.listInboxForTriage).toEqual(expect.any(Function));
    expect(opts.settings.allowWeb).toBe(false);
    return {text:"Найдены записи для предварительного разбора",sources:[],requests:1};
  });
  const store=new DirectChatStore("guest",storage,runner);
  await store.initialize();
  const id=store.getSnapshot().activeId!;
  store.setQuestion("Разбери входящие");
  await store.send(settings);
  expect(runner).toHaveBeenCalledTimes(1);
  const first=store.getSnapshot().conversations[0].rows.find(x=>x.inboxApproval);
  expect(first?.inboxApproval).toMatchObject({conversationId:id,limit:2});
  expect(JSON.stringify(records.get(id))).not.toMatch(/Конфиденциальный текст|secret-key/);
  await store.confirmProposal(first!.id,settings);
  expect(runner).toHaveBeenCalledTimes(2);
  expect(store.getSnapshot().conversations[0].rows.find(x=>x.id===first!.id)?.inboxApproval)
    .toBeUndefined();
  expect(store.getSnapshot().conversations[0].rows.at(-1)?.text)
    .toContain("предварительного разбора");
  expect(parseConversation(JSON.stringify(records.get(id)))?.rows.some(x=>x.inboxApproval))
    .toBe(false);
  store.dispose();
});

test("S9-1b: refusing or changing conversation revokes grant and cannot trigger another model turn",async()=>{
  const {storage}=repo();
  const runner=jest.fn(async(opts:any)=>({
    text:"Требуется разрешение",sources:[],requests:1,
    inboxApproval:opts.requestInboxTriageApproval(2),
  }));
  const store=new DirectChatStore("guest",storage,runner);
  await store.initialize();
  store.setQuestion("Разбери записи");
  await store.send(settings);
  const row=store.getSnapshot().conversations[0].rows.find(x=>x.inboxApproval)!;
  store.dismissProposal(row.id);
  await store.confirmProposal(row.id,settings);
  expect(runner).toHaveBeenCalledTimes(1);
  const first=store.getSnapshot().activeId!;
  store.create();
  store.select(first);
  expect(store.getSnapshot().conversations.find(x=>x.id===first)?.rows.find(x=>x.id===row.id)?.inboxApproval)
    .toBeUndefined();
  store.dispose();
});

test("S9-1b: a lock event kills pending approval even after app reopens",async()=>{
  const {storage}=repo();
  const runner=jest.fn(async(opts:any)=>({
    text:"Требуется разрешение",sources:[],requests:1,
    inboxApproval:opts.requestInboxTriageApproval(2),
  }));
  const store=new DirectChatStore("guest",storage,runner);
  await store.initialize();
  store.setQuestion("Разбери записи");
  await store.send(settings);
  const row=store.getSnapshot().conversations[0].rows.find(x=>x.inboxApproval)!;
  const listener=(onLocalMemorySessionChange as jest.Mock).mock.calls[0][0];
  listener(false);
  listener(true);
  await store.confirmProposal(row.id,settings);
  expect(runner).toHaveBeenCalledTimes(1);
  expect(store.getSnapshot().error).toContain("устарело");
  store.dispose();
});
