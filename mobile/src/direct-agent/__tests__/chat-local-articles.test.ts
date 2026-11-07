import { DirectChatStore } from "../chat-store";
import { selectSavedAiArticles } from "../article-selection";
import { parseConversation, type ConversationRepository, type SavedConversation,
  type ChatArticlePage } from "../conversations";
import { waitForApplicationSession } from "../../local-memory/storage";

jest.mock("../../local-memory/storage",()=>({
  waitForApplicationSession:jest.fn(async()=>{}),withLocalMemoryDatabase:jest.fn(),
  localMemorySessionUnlocked:jest.fn(()=>true),
}));
jest.mock("../article-selection",()=>({
  selectSavedAiArticles:jest.fn(),
}));
jest.mock("expo-crypto",()=>({randomUUID:()=>"id-"+Math.random().toString(36).slice(2)}));
jest.mock("../agent-preferences",()=>({loadModelCallLimit:jest.fn(async()=>4)}));
const selection=selectSavedAiArticles as jest.Mock;
const settings={provider:"openai",apiKey:"never-use-key",model:"remote",
  baseUrl:"https://api.openai.com/v1",allowWeb:false} as any;
const page:ChatArticlePage={
  kind:"saved_topic_links",dateMode:"published",topic:"ремонт автомобиля",
  queryTerms:["ремонт автомобиля"],
  savedFrom:"2026-10-31T00:00:00.000Z",savedBefore:"2026-11-07T00:00:00.000Z",
  startLocal:"2026-10-31",endLocal:"2026-11-06",
  nextCursor:{beforeCreatedAt:"2026-11-04T09:00:00.000Z",beforeId:"note-2"},
  selected:[{id:"note-1",version:2},{id:"note-2",version:3}],
};
function fixture(){
  const records=new Map<string,SavedConversation>();
  const repo:ConversationRepository={
    load:jest.fn(async()=>[...records.values()]),
    save:jest.fn(async c=>{records.set(c.id,JSON.parse(JSON.stringify(c)));}),
    remove:jest.fn(async id=>{records.delete(id);}),
  };
  const runner=jest.fn().mockResolvedValue({text:"Подборка",
    sources:[],requests:1,articlePage:page});
  return {records,repo,runner};
}
beforeEach(()=>{
  jest.clearAllMocks();
  (waitForApplicationSession as jest.Mock).mockResolvedValue(undefined);
  selection.mockResolvedValue({scope:"standard_active_saved_links",
    matchMode:"one_of_fts_phrases",count:2,hasMore:false,records:[]});
});

test("saved-article selection in ordinary chat goes through LLM instead of automatic local picker",async()=>{
  const {repo,records,runner}=fixture();
  const store=new DirectChatStore("guest",repo,runner);await store.initialize();
  store.setQuestion("Выбери статьи на тему ремонт автомобиля за последнюю неделю");
  await store.send(settings);
  expect(runner).toHaveBeenCalledTimes(1);
  expect(runner.mock.calls[0][0].prompt).toContain("Выбери статьи");
  expect(typeof runner.mock.calls[0][0].selectArticles).toBe("function");
  expect(selection).not.toHaveBeenCalled();
  expect(records.get(store.getSnapshot().activeId!)?.rows.at(-1)?.articlePage)
    .toEqual(page);
  store.dispose();
});

test("agent tool invokes the existing SQLCipher saved-articles adapter only on model choice",async()=>{
  const {repo,runner}=fixture();
  const store=new DirectChatStore("guest",repo,runner);await store.initialize();
  const query={topic:"ремонт автомобиля",dateMode:"published" as const,
    startLocal:"2026-10-31",endLocal:"2026-11-06",
    savedFrom:page.savedFrom,savedBefore:page.savedBefore,
    publicationFrom:"2026-10-31",publicationBefore:"2026-11-07",
    queryTerms:["ремонт автомобиля"]};
  runner.mockImplementationOnce(async (options:any)=>{
    const result=await options.selectArticles(query);
    expect(result).toMatchObject({scope:"standard_active_saved_links"});
    return {text:"Нашёл материалы",sources:[],requests:2,articlePage:page};
  });
  store.setQuestion("Найди статьи про ремонт автомобиля, опубликованные на этой неделе");
  await store.send(settings);
  expect(selection).toHaveBeenCalledTimes(1);
  expect(selection.mock.calls[0][1]).toEqual(query);
  store.dispose();
});

test("button 'Показать ещё' creates a model turn, pinned to the clicked historic article page",async()=>{
  const {repo,records,runner}=fixture();
  const store=new DirectChatStore("guest",repo,runner);await store.initialize();
  store.setQuestion("Подбери статьи о ремонте автомобиля за неделю");
  await store.send(settings);
  const first=store.getSnapshot().conversations[0].rows.at(-1)!;
  expect(parseConversation(JSON.stringify(records.get(store.getSnapshot().activeId!)))?.rows.at(-1)?.articlePage?.dateMode)
    .toBe("published");
  store.setQuestion("Несвязанный черновик");
  runner.mockImplementationOnce(async(options:any)=>{
    expect(options.prompt).toBe("Покажи ещё сохранённые статьи из этой подборки");
    expect(options.articleContinuation).toEqual(page);
    expect(options.articleSelection).toEqual(page);
    return {text:"Вторая страница",sources:[],requests:2,
      articlePage:{...page,nextCursor:undefined,selected:[
        ...page.selected!,{id:"note-3",version:1},
      ]}};
  });
  await store.continueArticlesWithAgent(settings,first.id);
  expect(runner).toHaveBeenCalledTimes(2);
  expect(selection).not.toHaveBeenCalled();
  expect(store.getSnapshot().conversations[0].question).toBe("Несвязанный черновик");
  expect(store.getSnapshot().conversations[0].rows.at(-1)?.text).toBe("Вторая страница");
  store.dispose();
});

test("typed 'Покажи ещё' also uses the agent and receives the prior cursor",async()=>{
  const {repo,runner}=fixture();
  const store=new DirectChatStore("guest",repo,runner);await store.initialize();
  store.setQuestion("Найди статьи про ремонт автомобиля за неделю");
  await store.send(settings);
  store.setQuestion("Покажи ещё");
  await store.send(settings);
  expect(runner).toHaveBeenCalledTimes(2);
  expect(runner.mock.calls[1][0].articleContinuation).toEqual(page);
  expect(selection).not.toHaveBeenCalled();
  store.dispose();
});

test("typed continuation cannot reuse an older cursor once the latest page is exhausted",async()=>{
  const {repo,runner}=fixture();
  const store=new DirectChatStore("guest",repo,runner);await store.initialize();
  store.setQuestion("Выбери статьи о ремонте автомобиля за неделю");
  await store.send(settings);
  store.setQuestion("Покажи ещё");
  runner.mockResolvedValueOnce({text:"Последняя страница",sources:[],requests:2,
    articlePage:{...page,nextCursor:undefined}});
  await store.send(settings);
  store.setQuestion("Покажи ещё");
  await store.send(settings);
  expect(runner.mock.calls[2][0].articleContinuation).toBeUndefined();
  store.dispose();
});

test("no contextual article continuation without a verified saved cursor",async()=>{
  const {repo,runner}=fixture();
  const store=new DirectChatStore("guest",repo,runner);await store.initialize();
  store.setQuestion("Вопрос");
  await store.send(settings);
  const n=runner.mock.calls.length;
  await store.continueArticlesWithAgent(settings,"not-real");
  expect(runner).toHaveBeenCalledTimes(n);
  store.dispose();
});

test("provider failure is never replaced by an unapproved local article result",async()=>{
  const {repo,runner}=fixture();
  const store=new DirectChatStore("guest",repo,runner);await store.initialize();
  store.setQuestion("Найди статьи про ремонт автомобиля за неделю");
  runner.mockRejectedValueOnce(new Error("model_unavailable"));
  await store.send(settings);
  expect(runner).toHaveBeenCalledTimes(1);
  expect(selection).not.toHaveBeenCalled();
  expect(store.getSnapshot().conversations[0].rows.at(-1)?.role).toBe("info");
  store.dispose();
});
