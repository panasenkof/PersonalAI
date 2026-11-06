import { DirectChatStore } from "../chat-store";
import { savedAiArticleIntent, selectSavedAiArticles } from "../article-selection";
import { parseConversation, type ConversationRepository, type SavedConversation } from "../conversations";
import { waitForApplicationSession } from "../../local-memory/storage";

jest.mock("../../local-memory/storage",()=>({
  waitForApplicationSession:jest.fn(async()=>{}),withLocalMemoryDatabase:jest.fn(),
  localMemorySessionUnlocked:jest.fn(()=>true),
}));
jest.mock("../article-selection",()=>({
  savedAiArticleIntent:jest.fn(),
  selectSavedAiArticles:jest.fn(),
  savedAiArticlePageIntent:jest.fn((page:any)=>page.kind==="saved_topic_links" ? {...page,dateMode:page.dateMode||"saved"} : {...page,dateMode:page.dateMode||"saved",topic:"ai",queryTerms:["ИИ"]}),
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

test("next saved-article page is read locally, keeps old references, and persists continuation",async()=>{
  const {repo,records,runner}=fixture();
  const store=new DirectChatStore("guest",repo,runner);await store.initialize();
  selection.mockResolvedValueOnce({
    count:11,hasMore:true,nextCursor:{beforeCreatedAt:"2026-11-04T09:00:00.000Z",beforeId:"b"},
    records:[{id:"a",title:"ИИ и Android",section:"Заметки",version:1,createdAt:"2026-11-06T09:00:00.000Z"},
      {id:"b",title:"Локальные модели",section:"Проекты",version:2,createdAt:"2026-11-04T09:00:00.000Z"}],
  }).mockResolvedValueOnce({count:11,hasMore:false,records:[
    {id:"c",title:"Нейросети для телефона",section:"Заметки",version:1,createdAt:"2026-11-03T09:00:00.000Z"},
  ]});
  store.setQuestion("Выбери статьи на тему ИИ за последнюю неделю");
  await store.searchSavedArticlesLocally();
  const id=store.getSnapshot().activeId!;
  const first=store.getSnapshot().conversations[0].rows[1];
  expect(first.articlePage?.nextCursor).toMatchObject({beforeId:"b"});
  await store.loadMoreSavedArticlesLocally(first.id);
  const rows=records.get(id)!.rows;
  expect(rows.map(x=>x.role)).toEqual(["user","assistant","user","assistant"]);
  expect(rows[1].memory?.map(x=>x.id)).toEqual(["a","b"]);
  expect(rows[1].articlePage?.nextCursor).toBeUndefined();
  expect(rows[3].memory?.map(x=>x.id)).toEqual(["c"]);
  expect(rows[3].articlePage?.nextCursor).toBeUndefined();
  expect(selection.mock.calls[1][3]).toEqual({beforeCreatedAt:"2026-11-04T09:00:00.000Z",beforeId:"b"});
  expect(runner).not.toHaveBeenCalled();
  store.dispose();
});

test("typed Покажи ещё follows the same page without the remote runner or extra query",async()=>{
  const {repo,runner}=fixture();
  const store=new DirectChatStore("guest",repo,runner);await store.initialize();
  selection.mockResolvedValueOnce({
    count:9,hasMore:true,nextCursor:{beforeCreatedAt:"2026-11-04T09:00:00.000Z",beforeId:"b"},
    records:[{id:"b",title:"ИИ Android",section:"Заметки",version:1,createdAt:"2026-11-04T09:00:00.000Z"}],
  }).mockResolvedValueOnce({count:9,hasMore:false,records:[
    {id:"c",title:"ИИ on device",section:"Заметки",version:1,createdAt:"2026-11-03T09:00:00.000Z"}],
  });
  store.setQuestion("Найди статьи об ИИ за неделю");
  await store.searchSavedArticlesLocally();
  store.setQuestion("Покажи ещё");
  await store.send(settings);
  expect(store.getSnapshot().conversations[0].question).toBe("");
  expect(selection).toHaveBeenCalledTimes(2);
  expect(runner).not.toHaveBeenCalled();
  store.dispose();
});

test("failed page leaves cursor available for retry and does not use model",async()=>{
  const {repo,runner}=fixture();
  const store=new DirectChatStore("guest",repo,runner);await store.initialize();
  selection.mockResolvedValueOnce({
    count:9,hasMore:true,nextCursor:{beforeCreatedAt:"2026-11-04T09:00:00.000Z",beforeId:"b"},
    records:[{id:"b",title:"ИИ Android",section:"Заметки",version:1,createdAt:"2026-11-04T09:00:00.000Z"}],
  }).mockRejectedValueOnce(new Error("application_locked"));
  store.setQuestion("Выбери статьи про ИИ за неделю");await store.searchSavedArticlesLocally();
  const id=store.getSnapshot().conversations[0].rows[1].id;
  await store.loadMoreSavedArticlesLocally(id);
  expect(store.getSnapshot().conversations[0].rows.find(x=>x.id===id)?.articlePage?.nextCursor).toMatchObject({beforeId:"b"});
  expect(runner).not.toHaveBeenCalled();
  store.dispose();
});

test("article cursor survives encrypted conversation reload; malformed cursor is ignored",async()=>{
  const {repo,records}=fixture();
  const store=new DirectChatStore("guest",repo);await store.initialize();
  selection.mockResolvedValueOnce({
    count:20,hasMore:true,nextCursor:{beforeCreatedAt:"2026-11-04T09:00:00.000Z",beforeId:"b"},
    records:[{id:"b",title:"Статьи ИИ",section:"Заметки",version:1,createdAt:"2026-11-04T09:00:00.000Z"}],
  });
  store.setQuestion("Выбери статьи об ИИ за неделю");await store.searchSavedArticlesLocally();
  const raw=JSON.stringify(records.get(store.getSnapshot().activeId!)!);
  expect(JSON.parse(raw).rows[1].articlePage?.nextCursor?.beforeId).toBe("b");
  const restored=parseConversation(raw)!;
  expect(restored.rows[1].articlePage?.nextCursor?.beforeId).toBe("b");
  const tampered=JSON.parse(raw);
  tampered.rows[1].articlePage.nextCursor.beforeId="untrusted cursor with spaces";
  expect(parseConversation(JSON.stringify(tampered))!.rows[1].articlePage).toBeUndefined();
  store.dispose();
});

test("literal-topic shortlist survives history reload and uses identical local FTS phrase on the next page",async()=>{
  const {repo,records,runner}=fixture();
  const store=new DirectChatStore("guest",repo,runner);await store.initialize();
  intent.mockReturnValueOnce({savedFrom:"2026-10-31T00:00:00.000Z",savedBefore:"2026-11-07T00:00:00.000Z",
    startLocal:"2026-10-31",endLocal:"2026-11-06",dateMode:"saved",topic:"ремонт автомобиля",
    queryTerms:["ремонт автомобиля"]});
  selection.mockResolvedValueOnce({count:15,hasMore:true,
    nextCursor:{beforeCreatedAt:"2026-11-04T09:00:00.000Z",beforeId:"b"},
    records:[{id:"b",title:"Ремонт автомобиля",section:"Заметки",version:1,createdAt:"2026-11-04T09:00:00.000Z"}],
  }).mockResolvedValueOnce({count:15,hasMore:false,records:[
    {id:"c",title:"Сервис",section:"Заметки",version:1,createdAt:"2026-11-03T09:00:00.000Z"},
  ]});
  store.setQuestion("Найди статьи про ремонт автомобиля на этой неделе");
  await store.searchSavedArticlesLocally();
  const conversation=store.getSnapshot().conversations[0];
  expect(conversation.rows[1].text).toContain("по точной фразе «ремонт автомобиля»");
  const raw=JSON.stringify(records.get(conversation.id)!);
  const restored=parseConversation(raw)!;
  expect(restored.rows[1].articlePage).toMatchObject({kind:"saved_topic_links",
    topic:"ремонт автомобиля",queryTerms:["ремонт автомобиля"]});
  await store.loadMoreSavedArticlesLocally(conversation.rows[1].id);
  expect(selection.mock.calls[1][1]).toMatchObject({topic:"ремонт автомобиля",queryTerms:["ремонт автомобиля"]});
  expect(runner).not.toHaveBeenCalled();
  const damaged=JSON.parse(raw);
  damaged.rows[1].articlePage.queryTerms=["не связанная тема"];
  expect(parseConversation(JSON.stringify(damaged))!.rows[1].articlePage).toBeUndefined();
  store.dispose();
});

test("exact-URL duplicate is only a read-only hint, both source links remain openable",async()=>{
  const {repo,runner}=fixture();const store=new DirectChatStore("guest",repo,runner);
  await store.initialize();
  selection.mockResolvedValueOnce({count:2,hasMore:false,records:[
    {id:"a",title:"Сохранение с комментарием",section:"Заметки",version:1,
      createdAt:"2026-11-06T09:00:00.000Z",duplicateCount:1},
    {id:"b",title:"Другой комментарий",section:"Проекты",version:1,
      createdAt:"2026-11-04T09:00:00.000Z",duplicateCount:1},
  ]});
  store.setQuestion("Найди статьи об ИИ за неделю");
  await store.searchSavedArticlesLocally();
  const row=store.getSnapshot().conversations[0].rows[1];
  expect(row.text).toContain("ещё доступных сохранений этого URL: 1");
  expect(row.memory?.map(x=>x.id)).toEqual(["a","b"]);
  expect(runner).not.toHaveBeenCalled();
  store.dispose();
});

test("9A5c: published-date shortlist says source-claimed, shows unknown count and never calls model",async()=>{
  const {repo,records,runner}=fixture();
  const store=new DirectChatStore("guest",repo,runner);await store.initialize();
  intent.mockReturnValueOnce({dateMode:"published",topic:"ai",queryTerms:["ИИ"],
    publicationFrom:"2026-10-31",publicationBefore:"2026-11-07",
    savedFrom:"2026-10-31T00:00:00.000Z",savedBefore:"2026-11-07T00:00:00.000Z",
    startLocal:"2026-10-31",endLocal:"2026-11-06"});
  selection.mockResolvedValueOnce({count:1,hasMore:false,unknownPublicationCount:4,records:[
    {id:"a",title:"ИИ сегодня",section:"Заметки",version:1,createdAt:"2026-09-01T10:00:00.000Z",
      publicationDay:"2026-11-03",duplicateCount:0},
  ]});
  store.setQuestion("Найди статьи об ИИ, опубликованные за последние 7 дней");
  await store.searchSavedArticlesLocally();
  const answer=records.get(store.getSnapshot().activeId!)!.rows[1];
  expect(answer.text).toContain("Период публикации по данным сайта");
  expect(answer.text).toContain("не проверена независимо");
  expect(answer.text).toContain("неизвестной датой публикации: 4");
  expect(answer.text).toContain("2026-11-03");
  expect(answer.articlePage?.dateMode).toBe("published");
  expect(runner).not.toHaveBeenCalled();
  store.dispose();
});

test("9A5c: published follow-up retains publication mode and does not leak to LLM",async()=>{
  const {repo,runner}=fixture();
  const store=new DirectChatStore("guest",repo,runner);await store.initialize();
  intent.mockReturnValueOnce({dateMode:"published",topic:"ai",queryTerms:["ИИ"],
    publicationFrom:"2026-10-31",publicationBefore:"2026-11-07",
    savedFrom:"2026-10-31T00:00:00.000Z",savedBefore:"2026-11-07T00:00:00.000Z",
    startLocal:"2026-10-31",endLocal:"2026-11-06"});
  selection.mockResolvedValueOnce({count:9,hasMore:true,unknownPublicationCount:2,
    nextCursor:{beforeCreatedAt:"2026-11-04T09:00:00.000Z",beforeId:"b"},
    records:[{id:"b",title:"ИИ Android",section:"Заметки",version:1,
      createdAt:"2026-11-04T09:00:00.000Z",publicationDay:"2026-11-03"}],
  }).mockResolvedValueOnce({count:9,hasMore:false,unknownPublicationCount:2,records:[
    {id:"c",title:"ИИ on device",section:"Заметки",version:1,
      createdAt:"2026-11-03T09:00:00.000Z",publicationDay:"2026-11-02"}],
  });
  store.setQuestion("Найди статьи об ИИ, опубликованные за последние 7 дней");
  await store.searchSavedArticlesLocally();
  const first=store.getSnapshot().conversations[0].rows[1];
  expect(parseConversation(JSON.stringify(store.getSnapshot().conversations[0]))?.rows[1].articlePage?.dateMode).toBe("published");
  await store.loadMoreSavedArticlesLocally(first.id);
  expect(store.getSnapshot().conversations[0].rows.at(-1)?.text).toContain("по данным сайтов");
  expect(selection.mock.calls[1][1]).toMatchObject({dateMode:"published"});
  expect(runner).not.toHaveBeenCalled();
  store.dispose();
});
