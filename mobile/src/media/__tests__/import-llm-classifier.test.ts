import { classifyImportCollectionWithAgent, classificationExcerpt, MAX_CLASSIFICATION_EXCERPT_CHARS,
  type ImportClassificationRequest } from "../import-llm-classifier";
import { createToolCatalog } from "../../direct-agent/tool-catalog";
import type { CollectionRecord } from "../../local-memory/types";
import type { DirectAgentOptions, DirectResult } from "../../direct-agent/engine";

const collections: CollectionRecord[] = [
  {id:"inbox",slug:"inbox",name:"Входящие",sensitivity:"sensitive",description:null,created_at:"2026-11-07"},
  {id:"notes",slug:"notes",name:"Заметки",sensitivity:"standard",description:null,created_at:"2026-11-07"},
  {id:"recipes",slug:"recipes",name:"Рецепты",sensitivity:"standard",description:null,created_at:"2026-11-07"},
  {id:"family",slug:"family",name:"Семья",sensitivity:"sensitive",description:null,created_at:"2026-11-07"},
  {id:"documents",slug:"documents",name:"Документы",sensitivity:"sensitive",description:null,created_at:"2026-11-07"},
];
const request=():ImportClassificationRequest=>({
  title:"Лазанья",body:"Приготовлю лазанью с томатами",extractedText:"",
  collections,settings:{provider:"openai",baseUrl:"https://api.openai.com/v1",model:"test-model",
    apiKey:"secret",webSearchKey:"",allowWeb:true},
  explicitConsent:true,sensitivity:"standard",modelCallLimit:3,
});
const candidate=(sectionSlug:string|null="recipes"):DirectResult=>({
  text:"Определено",sources:[],requests:2,
  contextCandidate:{topic:"Рецепт лазаньи",sectionSlug,reason:"В подписи рецепт"},
});

test("MSG-6.C2: existing context tool is the ONLY registered action; no files, web or memory payload",async()=>{
  const runner=jest.fn(async(options:DirectAgentOptions)=>{
    expect(options.contextOnly).toBe(true);
    expect(options.contextClassificationEnabled).toBe(true);
    expect(options.skipLocalMemory).toBe(true);
    expect(options.history).toEqual([]);
    expect(options.attachments).toEqual([]);
    expect(options.settings.allowWeb).toBe(false);
    expect(options.maxRequests).toBe(2);
    expect(options.prompt).toContain("Приготовлю лазанью");
    expect(options.sections).toEqual([{slug:"notes",name:"Заметки"},{slug:"recipes",name:"Рецепты"}]);
    const catalog=createToolCatalog(options,[],[],[]);
    expect(catalog.definitions.map(tool=>tool.name)).toEqual(["set_conversation_context"]);
    expect(await catalog.run("search_local_notes",{query:"secret"})).toEqual({error:"tool_not_allowed"});
    expect(await catalog.run("draft_memory_fact",{title:"X"})).toEqual({error:"tool_not_allowed"});
    return candidate();
  });
  await expect(classifyImportCollectionWithAgent(request(),runner)).resolves.toEqual({
    collectionId:"recipes",sectionSlug:"recipes",sectionName:"Рецепты",
    topic:"Рецепт лазаньи",reason:"В подписи рецепт",excerptTruncated:false,
  });
  expect(runner).toHaveBeenCalledTimes(1);
});

test("MSG-6.C2: without separate consent or with sensitive source NO model network request",async()=>{
  const runner=jest.fn().mockResolvedValue(candidate());
  await expect(classifyImportCollectionWithAgent({...request(),explicitConsent:false},runner))
    .rejects.toThrow("разрешения");
  await expect(classifyImportCollectionWithAgent({...request(),sensitivity:"sensitive"},runner))
    .rejects.toThrow("Личные");
  await expect(classifyImportCollectionWithAgent({...request(),modelCallLimit:1},runner))
    .rejects.toThrow("до 2");
  expect(runner).not.toHaveBeenCalled();
});

test("MSG-6.C2: non-readable binary, link-only, or empty material cannot be silently classified",async()=>{
  const runner=jest.fn().mockResolvedValue(candidate());
  expect(classificationExcerpt("https://t.me/topic/15","").substantive).toBe(false);
  expect(classificationExcerpt("","").substantive).toBe(false);
  await expect(classifyImportCollectionWithAgent({...request(),body:"",extractedText:""},runner))
    .resolves.toBeNull();
  await expect(classifyImportCollectionWithAgent({...request(),body:"https://t.me/topic/15"},runner))
    .resolves.toBeNull();
  expect(runner).not.toHaveBeenCalled();
});

test("MSG-6.C2: source is a bounded EXCERPT, not secretly a complete scan of PDF/photo",async()=>{
  const long="Рецепт ".repeat(10000),excerpt=classificationExcerpt(long,"");
  expect(excerpt.visible).toHaveLength(MAX_CLASSIFICATION_EXCERPT_CHARS);
  expect(excerpt.truncated).toBe(true);
  const runner=jest.fn().mockResolvedValue(candidate());
  const result=await classifyImportCollectionWithAgent({...request(),body:long},runner);
  expect(result?.excerptTruncated).toBe(true);
  expect((runner.mock.calls[0][0].prompt as string).length).toBeLessThan(8000);
});

test("MSG-6.C2: model cannot invent a new/private collection or mark upstream link as read",async()=>{
  for(const slug of ["documents","family","unknown",null]){
    const runner=jest.fn().mockResolvedValue(candidate(slug));
    expect(await classifyImportCollectionWithAgent(request(),runner)).toBeNull();
  }
});

test("MSG-6.C2: AppLock abort cancels classification before any model request",async()=>{
  const controller=new AbortController();controller.abort();
  const runner=jest.fn().mockResolvedValue(candidate());
  await expect(classifyImportCollectionWithAgent({...request(),signal:controller.signal},runner))
    .rejects.toThrow("отменено");
  expect(runner).not.toHaveBeenCalled();
});
