import { inspectMove,validMoveProposal,validMoveReceipt,
  type ChatMoveProposal } from "../move-proposal";
import { createToolCatalog } from "../tool-catalog";
import { parseConversation } from "../conversations";
import { runDirectAgent } from "../engine";
import type { DirectAgentSettings } from "../settings";

const from={id:"collection-notes",slug:"notes",name:"Заметки",
  sensitivity:"standard",description:null,created_at:"2026-11-07"};
const to={id:"collection-projects",slug:"projects",name:"Проекты",
  sensitivity:"standard",description:null,created_at:"2026-11-07"};
const entity={
  id:"note-bike",collection_id:from.id,domain:"notes",record_status:"active",
  sensitivity:"standard",title:"Красный велосипед",record_version:4,
  payload:{body:"Рама красная"},source_ref:"user-photo",source_kind:"user",
  schema_version:"1",valid_from:null,valid_until:null,
  created_at:"2026-11-07",updated_at:"2026-11-07",
};
const request={noteId:"note-bike",expectedVersion:4,targetSectionSlug:"projects",
  reason:"Хранить снимок велосипеда в разделе проекта"};
const preview:ChatMoveProposal={
  noteId:"note-bike",expectedVersion:4,title:"Красный велосипед",
  fromCollectionId:from.id,fromName:from.name,
  toCollectionId:to.id,toName:to.name,
  reason:request.reason,attachmentCount:2,hasSource:true,
};
const settings:DirectAgentSettings={
  provider:"openai",baseUrl:"https://api.openai.com/v1",model:"gpt-4.1-mini",
  apiKey:"test-only",webSearchKey:"",allowWeb:false,
};
function repository(note:any=entity,collections:any[]=[from,to]){
  return {entity:jest.fn().mockResolvedValue(note),
    listCollections:jest.fn().mockResolvedValue(collections)} as any;
}
function harness(ready=true){
  const lookup=jest.fn().mockResolvedValue([{
    id:"note-bike",title:"Красный велосипед",body:"Рама красная",
    version:4,section:"Заметки",
  }]);
  const previewMove=jest.fn().mockResolvedValue(preview);
  const options={settings,prompt:"Перенеси фотографию велосипеда в Проекты",
    history:[],lookup,propose:jest.fn(),
    ...(ready?{previewMove}:{})};
  return {lookup,previewMove,catalog:createToolCatalog(options,[],[],[])};
}

test("9T2: preview uses authoritative active standard note + existing standard section",async()=>{
  const repo=repository();
  const result=await inspectMove(request,repo,2);
  expect(result).toEqual(preview);
  expect(repo.entity).toHaveBeenCalledWith("note-bike");
  expect(validMoveProposal(result)).toBe(true);
});

test.each([
  ["private note",{...entity,sensitivity:"secret"},[from,to]],
  ["private source",entity,[{...from,sensitivity:"secret"},to]],
  ["private destination",entity,[from,{...to,sensitivity:"sensitive"}]],
  ["document",{...entity,domain:"documents"},[from,to]],
  ["archived",{...entity,record_status:"archived"},[from,to]],
  ["no destination",entity,[from]],
  ["wrong collection",{...entity,collection_id:"unknown"},[from,to]],
])("9T2: %s must not produce a move preview",async(_label,note,sections)=>{
  await expect(inspectMove(request,repository(note,sections))).rejects.toThrow();
});

test("9T2: stale revision, same section, forged slug and short reason all rejected",async()=>{
  await expect(inspectMove({...request,expectedVersion:3},repository()))
    .rejects.toThrow("stale_memory_version");
  await expect(inspectMove({...request,targetSectionSlug:"notes"},repository()))
    .rejects.toThrow("move_target_not_available");
  for(const wrong of ["../private","Documents","projects;DROP",""]) {
    await expect(inspectMove({...request,targetSectionSlug:wrong},repository()))
      .rejects.toThrow();
  }
  await expect(inspectMove({...request,reason:"abc"},repository()))
    .rejects.toThrow("invalid_move_proposal_arguments");
});

test("9T2: tool is unavailable without callback or on web-only turn",async()=>{
  const {catalog}=harness(false);
  expect(catalog.definitions.some(x=>x.name==="propose_move_local_note")).toBe(false);
  expect(await catalog.run("propose_move_local_note",request))
    .toEqual({error:"tool_not_allowed"});
  const {lookup,previewMove}=harness();
  const webOnly=createToolCatalog({settings,prompt:"Web",history:[],lookup,
    propose:jest.fn(),previewMove,skipLocalMemory:true},[],[],[]);
  expect(webOnly.definitions.some(x=>x.name==="propose_move_local_note")).toBe(false);
});

test("9T2: no arbitrary model-supplied ID/version; only verified search handle may propose",async()=>{
  const {catalog,previewMove}=harness();
  const tool=catalog.definitions.find(t=>t.name==="propose_move_local_note");
  expect(tool?.parameters).toMatchObject({required:[
    "noteId","expectedVersion","targetSectionSlug","reason",
  ],additionalProperties:false});
  expect(await catalog.run("propose_move_local_note",request))
    .toEqual({error:"note_not_selected_for_move"});
  await catalog.run("search_local_notes",{query:"велосипед"});
  for(const bad of [
    {...request,noteId:"other"},
    {...request,expectedVersion:5},
    {...request,reason:"a"},
    {...request,targetSectionSlug:"../private"},
    {...request,extra:"write_now"},
  ]){
    const result=await catalog.run("propose_move_local_note",bad);
    expect(result).toHaveProperty("error");
  }
  expect(previewMove).not.toHaveBeenCalled();
  expect(await catalog.run("propose_move_local_note",request)).toMatchObject({
    outcome:"pending_confirmation",status:"awaiting_user_confirmation",
    saved:false,requiresUserTap:true,noteId:"note-bike",fromSection:"Заметки",
    toSection:"Проекты",
  });
  expect(previewMove).toHaveBeenCalledWith(request);
  expect(catalog.finish().moveProposal).toEqual(preview);
  expect(await catalog.run("propose_move_local_note",request))
    .toEqual({error:"move_preview_already_proposed_this_turn"});
});

test("9T2: list_local_notes can issue authorized ID/version without another search mechanism",async()=>{
  const previewMove=jest.fn().mockResolvedValue(preview);
  const catalog=createToolCatalog({settings,prompt:"Перенеси запись",history:[],
    lookup:jest.fn().mockResolvedValue([]),propose:jest.fn(),previewMove,
    list:jest.fn().mockResolvedValue({scope:"standard_active_notes",
      records:[{id:entity.id,version:4,title:"Велосипед",section:"Заметки"}],
      hasMore:false,contentIncluded:false}),
  },[],[],[]);
  const args={query:null,collectionId:null,limit:null,beforeUpdatedAt:null,beforeId:null};
  expect(await catalog.run("list_local_notes",args)).toMatchObject({outcome:"read"});
  expect(await catalog.run("propose_move_local_note",request))
    .toMatchObject({outcome:"pending_confirmation"});
});

test("9T2: corrupt or mismatched host previews never become confirmable",async()=>{
  const {lookup}=harness();
  for(const invalid of [
    {...preview,noteId:"forged"},
    {...preview,toCollectionId:preview.fromCollectionId},
    {...preview,expectedVersion:5},
    {...preview,attachmentCount:-1},
    {...preview,reason:""},
  ]){
    const catalog=createToolCatalog({settings,prompt:"Перенеси",history:[],
      lookup,propose:jest.fn(),previewMove:jest.fn().mockResolvedValue(invalid)},[],[],[]);
    await catalog.run("search_local_notes",{query:"велосипед"});
    expect(await catalog.run("propose_move_local_note",request))
      .toEqual({error:"invalid_move_preview"});
    expect(catalog.finish().moveProposal).toBeUndefined();
  }
});

test("9T2: interrupted proposal cannot appear in chat after cancellation",async()=>{
  const abort=new AbortController();
  const {lookup}=harness();
  const catalog=createToolCatalog({settings,prompt:"Перенеси",history:[],
    lookup,propose:jest.fn(),signal:abort.signal,
    previewMove:jest.fn().mockImplementation(async()=>{
      abort.abort();return preview;
    })},[],[],[]);
  await catalog.run("search_local_notes",{query:"велосипед"});
  await expect(catalog.run("propose_move_local_note",request))
    .rejects.toThrow("Запрос остановлен");
  expect(catalog.finish().moveProposal).toBeUndefined();
});

test("9T2: snapshot validates preview + receipt; rejects forged status and damaged data",()=>{
  const base={id:"chat",title:"Тест",createdAt:"2026-11-07",updatedAt:"2026-11-07",
    question:"",drafts:[],rows:[{id:"a",role:"assistant",text:"Предложение",moveProposal:preview}]};
  expect(parseConversation(JSON.stringify(base))?.rows[0].moveProposal).toEqual(preview);
  const corrupt={...base,rows:[{...base.rows[0],moveProposal:{...preview,noteId:"../../outside"}}]};
  expect(parseConversation(JSON.stringify(corrupt))?.rows[0].moveProposal).toBeUndefined();
  const receipt={noteId:entity.id,title:preview.title,fromCollectionId:from.id,
    fromName:from.name,toCollectionId:to.id,toName:to.name,
    batch:"notes:move:11111111-2222-3333-4444-555555555555",verified:true};
  expect(validMoveReceipt(receipt)).toBe(true);
  expect(parseConversation(JSON.stringify({...base,rows:[{
    id:"receipt",role:"assistant",text:"Готово",moveReceipt:receipt,
  }]}))?.rows[0].moveReceipt).toEqual(receipt);
  expect(validMoveReceipt({...receipt,batch:"notes:trash:wrong"})).toBe(false);
  expect(parseConversation(JSON.stringify({...base,rows:[{
    id:"receipt",role:"assistant",text:"Готово",
    moveReceipt:{...receipt,undone:"yes"},
  }]}))?.rows[0].moveReceipt).toBeUndefined();
});

test("9T2: scripted Responses function calling creates preview, NEVER a write tool",async()=>{
  const transport=jest.fn()
    .mockResolvedValueOnce({ok:true,status:200,json:async()=>({
      status:"completed",output:[{type:"function_call",name:"search_local_notes",
        call_id:"find",arguments:JSON.stringify({query:"велосипед"})}],
    })})
    .mockResolvedValueOnce({ok:true,status:200,json:async()=>({
      status:"completed",output:[{type:"function_call",name:"propose_move_local_note",
        call_id:"proposal",arguments:JSON.stringify(request)}],
    })})
    .mockResolvedValueOnce({ok:true,status:200,json:async()=>({
      status:"completed",output:[{type:"message",content:[{
        type:"output_text",text:"Предлагаю перенос. Нажмите «Подтвердить перенос»."}]}],
    })});
  const lookup=jest.fn().mockResolvedValue([{
    id:"note-bike",version:4,title:"Красный велосипед",body:"Рама красная",
    section:"Заметки",
  }]);
  const previewMove=jest.fn().mockResolvedValue(preview);
  const result=await runDirectAgent({settings,prompt:"Перенеси фотографию велосипеда в Проекты",
    history:[],lookup,propose:jest.fn(),previewMove,
    transport:transport as unknown as typeof fetch,
  });
  expect(result.requests).toBe(3);
  expect(result.moveProposal).toEqual(preview);
  expect(previewMove).toHaveBeenCalledTimes(1);
  expect(result.text).toContain("Подтвердить перенос");
  const input=JSON.parse(transport.mock.calls[2][1].body);
  expect(input.tools.some((t:any)=>t.name==="changeNotes"||t.name==="undoNotes"))
    .toBe(false);
  const receipt=input.input.find((v:any)=>v.type==="function_call_output"&&v.call_id==="proposal");
  expect(JSON.parse(receipt.output)).toMatchObject({
    saved:false,requiresUserTap:true,status:"awaiting_user_confirmation",
  });
});
