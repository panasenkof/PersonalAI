import { createToolCatalog } from "../tool-catalog";
import type { DirectAgentOptions } from "../engine";

const sections=[{slug:"projects",name:"Дела и проекты"},{slug:"notes",name:"Заметки"}];
const harness=(context?:DirectAgentOptions["context"])=>{
  const propose=jest.fn();
  const opts:DirectAgentOptions={
    settings:{provider:"openai",model:"test-model",baseUrl:"https://api.openai.com/v1",
      apiKey:"key",webSearchKey:"",allowWeb:false},
    prompt:"Подскажи рецепт",history:[],sections,context,contextClassificationEnabled:true,
    lookup:jest.fn().mockResolvedValue([]),propose,
  };
  return {catalog:createToolCatalog(opts,[],[],[]),propose};
};

test("same registered catalog proposes (but does not persist) a dialogue topic and section",async()=>{
  const {catalog,propose}=harness();
  expect(catalog.definitions.some(tool=>tool.name==="set_conversation_context")).toBe(true);
  const result=await catalog.run("set_conversation_context",{
    topic:"Домашняя лазанья",sectionSlug:"notes",reason:"Пользователь спрашивает рецепт",
  });
  expect(result).toMatchObject({status:"pending_conversation_commit",saved:false,
    memoryRecordChanged:false,sectionSlug:"notes"});
  expect(catalog.finish().contextCandidate).toEqual({
    topic:"Домашняя лазанья",sectionSlug:"notes",reason:"Пользователь спрашивает рецепт",
  });
  expect(propose).not.toHaveBeenCalled();
});

test("tool refuses unknown, private documents, extra keys and second context per turn",async()=>{
  const {catalog}=harness();
  for(const bad of [
    {topic:"Документы",sectionSlug:"documents",reason:"Источник"},
    {topic:"Отпуск",sectionSlug:"invented",reason:"Источник"},
    {topic:"Отпуск",sectionSlug:"notes",reason:"Источник",command:"delete_notes"},
  ]){
    expect(await catalog.run("set_conversation_context",bad)).toHaveProperty("error");
  }
  expect(catalog.finish().contextCandidate).toBeUndefined();
  expect(await catalog.run("set_conversation_context",{
    topic:"Отпуск",sectionSlug:null,reason:"Не хватает оснований",
  })).toMatchObject({status:"pending_conversation_commit"});
  expect(await catalog.run("set_conversation_context",{
    topic:"Работа",sectionSlug:"projects",reason:"Смена",
  })).toHaveProperty("error");
});

test("tool cannot silently repoint a pinned conversation",async()=>{
  const {catalog}=harness({topic:"PersAI",sectionSlug:"projects",pinned:true});
  expect(await catalog.run("set_conversation_context",{
    topic:"Рецепт",sectionSlug:"notes",reason:"Пользователь сменил тему",
  })).toHaveProperty("error","conversation_section_pinned");
  expect(await catalog.run("set_conversation_context",{
    topic:"Разработка приложения",sectionSlug:"projects",reason:"Смена подтемы",
  })).toMatchObject({status:"pending_conversation_commit"});
});
