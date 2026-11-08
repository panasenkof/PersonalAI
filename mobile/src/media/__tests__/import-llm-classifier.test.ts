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
  importTags:["лазанья","рецепты"],
});

test("MSG-6.C2: bounded import metadata proposal uses ONLY the existing catalog, no reads or writes",async()=>{
  const runner=jest.fn(async(options:DirectAgentOptions)=>{
    expect(options.contextOnly).toBe(true);
    expect(options.contextClassificationEnabled).toBe(true);
    expect(options.importTagsEnabled).toBe(true);
    expect(options.skipLocalMemory).toBe(true);
    expect(options.history).toEqual([]);
    expect(options.attachments).toEqual([]);
    expect(options.settings.allowWeb).toBe(false);
    expect(options.maxRequests).toBe(2);
    expect(options.prompt).toContain("Приготовлю лазанью");
    expect(options.sections).toEqual([{slug:"notes",name:"Заметки"},{slug:"recipes",name:"Рецепты"}]);
    const catalog=createToolCatalog(options,[],[],[]);
    expect(catalog.definitions.map(tool=>tool.name)).toEqual(["propose_import_metadata"]);
    expect(await catalog.run("set_conversation_context",{topic:"x",sectionSlug:null,reason:"y"}))
      .toEqual({error:"tool_not_allowed"});
    expect(await catalog.run("search_local_notes",{query:"secret"})).toEqual({error:"tool_not_allowed"});
    expect(await catalog.run("draft_memory_fact",{title:"X"})).toEqual({error:"tool_not_allowed"});
    return candidate();
  });
  await expect(classifyImportCollectionWithAgent(request(),runner)).resolves.toEqual({
    collectionId:"recipes",sectionSlug:"recipes",sectionName:"Рецепты",
    topic:"Рецепт лазаньи",reason:"В подписи рецепт",tags:["лазанья","рецепты"],excerptTruncated:false,
  });
  expect(runner).toHaveBeenCalledTimes(1);
});

test("MSG-6.C2: without separate consent or with sensitive source NO model network request",async()=>{
  const runner=jest.fn().mockResolvedValue(candidate());
  await expect(classifyImportCollectionWithAgent({...request(),explicitConsent:false},runner))
    .rejects.toThrow("разрешени");
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
  for(const slug of ["documents","family","unknown"]){
    const runner=jest.fn().mockResolvedValue(candidate(slug));
    expect(await classifyImportCollectionWithAgent(request(),runner)).toBeNull();
  }
  const noSection=await classifyImportCollectionWithAgent(request(),jest.fn().mockResolvedValue(candidate(null)));
  expect(noSection).toMatchObject({sectionSlug:null,collectionId:null,tags:["лазанья","рецепты"]});
});

test("Import metadata tool rejects invented/private sections and invalid tag lists before any changes",async()=>{
  const options:DirectAgentOptions={settings:request().settings,prompt:"Рецепт",history:[],lookup:async()=>[],
    propose:()=>undefined,contextOnly:true,importTagsEnabled:true,contextClassificationEnabled:true,
    sections:[{slug:"recipes",name:"Рецепты"}]};
  const invalid=(tags:unknown,slug:string|null="recipes")=>({topic:"Рецепт лазаньи",sectionSlug:slug,reason:"Про лазанью",tags});
  let catalog=createToolCatalog(options,[],[],[]);
  expect(await catalog.run("propose_import_metadata",invalid(["bad/name"]))).toEqual({error:"invalid_import_tags"});
  expect(await catalog.run("propose_import_metadata",invalid(["рецепты"],"secret"))).toEqual({error:"unknown_conversation_section"});
  expect(await catalog.run("propose_import_metadata",invalid(["Рецепты","#Лазанья"]))).toMatchObject({status:"pending_import_save",saved:false});
  expect(catalog.finish().importTags).toEqual(["лазанья","рецепты"]);
  expect(await catalog.run("propose_import_metadata",invalid(["second"]))).toEqual({error:"import_metadata_already_proposed"});
});

test("MSG-6.C2: AppLock abort cancels classification before any model request",async()=>{
  const controller=new AbortController();controller.abort();
  const runner=jest.fn().mockResolvedValue(candidate());
  await expect(classifyImportCollectionWithAgent({...request(),signal:controller.signal},runner))
    .rejects.toThrow("отменено");
  expect(runner).not.toHaveBeenCalled();
});
