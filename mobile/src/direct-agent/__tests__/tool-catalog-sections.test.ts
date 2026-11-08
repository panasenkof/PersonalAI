import { createToolCatalog } from "../tool-catalog";
import type { DirectAgentOptions } from "../engine";
import type { ChatSectionProposal } from "../section-actions";

const settings:DirectAgentOptions["settings"]={
  provider:"openai",model:"test-model",baseUrl:"https://api.openai.com/v1",
  apiKey:"key",webSearchKey:"",allowWeb:false,
};
const proposal:ChatSectionProposal={
  kind:"create",name:"Обучение",parentId:"parent-id",parentName:"ИИ",
  reason:"Пользователь попросил создать подраздел",
};
function options(extra:Partial<DirectAgentOptions>={}) {
  const preview=jest.fn(async()=>proposal);
  const opts:DirectAgentOptions={
    settings,prompt:"Создай раздел ИИ / Обучение",history:[],
    lookup:jest.fn().mockResolvedValue([]),propose:jest.fn(),previewSectionAction:preview,
    sections:[{slug:"section-ai",name:"ИИ",path:"ИИ"}],
    ...extra,
  };
  return {preview,opts,catalog:createToolCatalog(opts,[],[],[])};
}
test("shared registry exposes both safe section tools, never a direct memory writer",async()=>{
  const {catalog,preview,opts}=options();
  expect(catalog.definitions.map(d=>d.name)).toEqual(expect.arrayContaining([
    "propose_create_memory_section","propose_delete_memory_section","draft_memory_fact",
  ]));
  const result=await catalog.run("propose_create_memory_section",{
    name:"Обучение",parentSlug:"section-ai",reason:proposal.reason,
  });
  expect(result).toMatchObject({status:"awaiting_user_confirmation",
    saved:false,requiresUserTap:true,action:"create",outcome:"pending_confirmation"});
  expect(catalog.finish().sectionProposal).toEqual(proposal);
  expect(preview).toHaveBeenCalledTimes(1);
  expect(opts.propose).not.toHaveBeenCalled();
  expect(await catalog.run("propose_delete_memory_section",{
    sectionSlug:"section-ai",reason:"Удалить по запросу пользователя",
  })).toHaveProperty("error","section_action_already_proposed_this_turn");
});
test("delete stages only an empty section; does not perform SQLite deletion",async()=>{
  const deletion:ChatSectionProposal={kind:"delete",id:"s1",slug:"section-old",
    name:"Старый",parentId:null,parentName:null,createdAt:"2026-11-08T12:00:00.000Z",
    reason:"Пользователь попросил удалить",recordCount:0,childCount:0};
  const preview=jest.fn(async()=>deletion);
  const {catalog}=options({previewSectionAction:preview});
  expect(await catalog.run("propose_delete_memory_section",{
    sectionSlug:"section-old",reason:deletion.reason,
  })).toMatchObject({action:"delete",status:"awaiting_user_confirmation",saved:false});
  expect(catalog.finish().sectionProposal).toEqual(deletion);
  expect(preview).toHaveBeenCalledWith({kind:"delete",sectionSlug:"section-old",reason:deletion.reason});
});
test("private/import-only turns never advertise section mutation tools",()=>{
  for(const extra of [{skipLocalMemory:true},{contextOnly:true}]){
    const {catalog}=options(extra);
    expect(catalog.definitions.map(d=>d.name)).not.toEqual(expect.arrayContaining([
      "propose_create_memory_section",
    ]));
    expect(catalog.definitions.map(d=>d.name)).not.toEqual(expect.arrayContaining([
      "propose_delete_memory_section",
    ]));
  }
});
test("invalid, injected or incomplete section arguments never reach the preview callback",async()=>{
  const {catalog,preview}=options();
  for(const bad of [
    {name:"Обучение",parentSlug:"section-ai",reason:"Обоснование",extra:"sql"},
    {name:"Обучение",reason:"Обоснование"},
    {name:"../../memory",parentSlug:null,reason:"Обоснование"},
  ])expect(await catalog.run("propose_create_memory_section",bad)).toHaveProperty("error");
  for(const bad of [
    {sectionSlug:"documents",reason:"x"},
    {sectionSlug:"section-ai",reason:"Обоснование",cascade:true},
    {sectionSlug:"section-ai",reason:"Обоснование",deleteAll:true},
  ])expect(await catalog.run("propose_delete_memory_section",bad)).toHaveProperty("error");
  expect(preview).not.toHaveBeenCalled();
});


test("section proposals and receipts survive encrypted conversation JSON reload",()=>{
  const {parseConversation}=require("../conversations") as typeof import("../conversations");
  const proposal:ChatSectionProposal={kind:"delete",id:"id-old",slug:"section-old",
    name:"Устаревшее",parentId:null,parentName:null,createdAt:"2026-11-08T12:00:00.000Z",
    reason:"Пользователь просит убрать",recordCount:0,childCount:0};
  const base={id:"conversation",title:"Разделы",createdAt:"2026-11-08T12:00:00.000Z",
    updatedAt:"2026-11-08T12:00:00.000Z",question:"",drafts:[]};
  const rows=[
    {id:"proposed",role:"assistant",text:"Нужно подтвердить",sectionProposal:proposal},
    {id:"done",role:"assistant",text:"Удалено",sectionReceipt:{
      kind:"delete",id:"id-old",slug:"section-old",name:"Устаревшее",parentName:null,verified:true}},
    {id:"tampered",role:"assistant",text:"Пример",sectionProposal:{...proposal,recordCount:1}},
  ];
  const loaded=parseConversation(JSON.stringify({...base,rows}));
  expect(loaded?.rows[0].sectionProposal).toEqual(proposal);
  expect(loaded?.rows[1].sectionReceipt).toMatchObject({kind:"delete",verified:true});
  expect(loaded?.rows[2].sectionProposal).toBeUndefined();
});

test("model receives a safe reason when requested section is nonempty",async()=>{
  const preview=jest.fn(async()=>{
    throw new Error("section_not_empty");
  });
  const {catalog}=options({previewSectionAction:preview});
  expect(await catalog.run("propose_delete_memory_section",{
    sectionSlug:"section-old",reason:"Пользователь просит удалить",
  })).toEqual({error:"section_not_empty"});
  expect(catalog.finish().sectionProposal).toBeUndefined();
});
