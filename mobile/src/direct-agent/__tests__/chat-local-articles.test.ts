import { DirectChatStore } from "../chat-store";
import { savedAiArticleIntent, selectSavedAiArticles } from "../article-selection";
import type { ConversationRepository, SavedConversation } from "../conversations";
import { waitForApplicationSession } from "../../local-memory/storage";

jest.mock("../../local-memory/storage",()=>({
  waitForApplicationSession:jest.fn(async()=>{}),withLocalMemoryDatabase:jest.fn(),
  localMemorySessionUnlocked:jest.fn(()=>true),
}));
jest.mock("../article-selection",()=>({
  savedAiArticleIntent:jest.fn(),
  selectSavedAiArticles:jest.fn(),
}));
jest.mock("expo-crypto",()=>({randomUUID:()=>"id-"+Math.random().toString(36).slice(2)}));
const intent=savedAiArticleIntent as jest.Mock;
const selection=selectSavedAiArticles as jest.Mock;
const settings={provider:"openai",apiKey:"never-use-key",model:"remote",baseUrl:"https://api.openai.com/v1"} as any;
function fixture(){
  const records=new Map<string,SavedConversation>();
  const repo:ConversationRepository={
    load:jest.fn(async()=>[...records.values()]),
    save:jest.fn(async c=>{records.set(c.id,JSON.parse(JSON.stringify(c)));}),
    remove:jest.fn(async id=>{records.delete(id);}),
  };
  const runner=jest.fn();
  return {records,repo,runner};
}
beforeEach(()=>{
  jest.clearAllMocks();
  (waitForApplicationSession as jest.Mock).mockResolvedValue(undefined);
  intent.mockImplementation((q:string,_now:Date,attachments:boolean)=>!attachments&&q.includes("статьи")
    ? {savedFrom:"2026-10-31T00:00:00.000Z",savedBefore:"2026-11-07T00:00:00.000Z",
      startLocal:"2026-10-31",endLocal:"2026-11-06",dateMode:"saved",topic:"ai",queryTerms:["ИИ"]}:null);
  selection.mockResolvedValue({count:2,hasMore:false,records:[
    {id:"a",title:"ИИ и Android",section:"Заметки",version:1,createdAt:"2026-11-06T09:00:00.000Z"},
    {id:"b",title:"Локальные модели",section:"Проекты",version:2,createdAt:"2026-11-04T09:00:00.000Z"},
  ]});
});
test("local article selection is saved in the ordinary chat, with openable note refs and zero LLM calls",async()=>{
  const {repo,records,runner}=fixture();
  const store=new DirectChatStore("guest",repo,runner);
  await store.initialize();
  store.setQuestion("Выбери статьи на тему ИИ за последнюю неделю");
  await store.searchSavedArticlesLocally();
  const conversation=records.get(store.getSnapshot().activeId!)!;
  expect(conversation.rows.map(x=>x.role)).toEqual(["user","assistant"]);
  expect(conversation.rows[1].memory).toMatchObject([{id:"a",via:"search"},{id:"b",via:"search"}]);
  expect(conversation.rows[1].text).toContain("Найдено 2");
  expect(conversation.rows[1].text).toContain("только в памяти телефона");
  expect(conversation.question).toBe("");
  expect(runner).not.toHaveBeenCalled();
  expect(selection).toHaveBeenCalledTimes(1);
  store.dispose();
});
test("send also routes an explicit article shortlist locally without transmitting question",async()=>{
  const {repo,runner}=fixture();
  const store=new DirectChatStore("guest",repo,runner); await store.initialize();
  store.setQuestion("Найди статьи об ИИ за последнюю неделю");
  await store.send(settings);
  expect(runner).not.toHaveBeenCalled();
  expect(selection).toHaveBeenCalledTimes(1);
  store.dispose();
});
test("failure restores draft for retry and does not call remote LLM",async()=>{
  const {repo,runner}=fixture();
  const store=new DirectChatStore("guest",repo,runner); await store.initialize();
  store.setQuestion("Выбери статьи об ИИ за неделю");
  selection.mockRejectedValueOnce(new Error("application_locked"));
  await store.searchSavedArticlesLocally();
  expect(store.getSnapshot().conversations[0].question).toContain("Выбери статьи");
  expect(store.getSnapshot().conversations[0].rows.at(-1)?.role).toBe("info");
  expect(runner).not.toHaveBeenCalled();
  store.dispose();
});
