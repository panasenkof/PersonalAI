import { createToolCatalog } from "../tool-catalog";
import { runDirectAgent } from "../engine";
import { parseConversation } from "../conversations";
import type { DirectAgentOptions } from "../engine";
import type { DirectAgentSettings } from "../settings";
import type { ChatMemoryRef } from "../conversations";

const settings:DirectAgentSettings={
  provider:"openai",baseUrl:"https://api.openai.com/v1",model:"gpt-4.1-mini",
  apiKey:"test-only",webSearchKey:"",allowWeb:false,
};
const found:ChatMemoryRef[]=[
  {id:"note-bike",title:"Красный велосипед у дерева",via:"search",
    photo:true,photoAttachmentId:"photo-front"},
  {id:"note-bike",title:"Красный велосипед у дерева",via:"search",
    photo:true,photoAttachmentId:"photo-side"},
  {id:"note-garden",title:"Дерево во дворе",via:"search",
    photo:true,photoAttachmentId:"photo-tree"},
];
function harness(searchPhotos?:DirectAgentOptions["searchPhotos"],
  more:Partial<DirectAgentOptions>={}){
  const options:DirectAgentOptions={
    settings,prompt:"Расскажи, что сохранилось о велосипеде",history:[],
    lookup:jest.fn().mockResolvedValue([]),propose:jest.fn(),
    ...(searchPhotos?{searchPhotos}:{}),...more,
  };
  return createToolCatalog(options,[],[],[]);
}
const query=(description="красный велосипед у дерева")=>({mode:"text",description});
const toolResponse=(name:string,args:unknown,callId="photo-1")=>({
  ok:true,status:200,json:async()=>({status:"completed",output:[
    {type:"function_call",name,call_id:callId,arguments:JSON.stringify(args)},
  ]}),
});
const final=(answer:string)=>({
  ok:true,status:200,json:async()=>({status:"completed",output:[
    {type:"message",content:[{type:"output_text",text:answer}]},
  ]}),
});

test("9T1-R2: photo tool is opt-in per host adapter and hidden on internet-only turns",async()=>{
  const noAdapter=harness();
  expect(noAdapter.definitions.some(t=>t.name==="search_local_photos")).toBe(false);
  expect(await noAdapter.run("search_local_photos",query()))
    .toEqual({error:"tool_not_allowed"});
  const search=jest.fn().mockResolvedValue({text:"Нашёл",memory:found});
  const internet=harness(search,{skipLocalMemory:true});
  expect(internet.definitions.some(t=>t.name==="search_local_photos")).toBe(false);
  expect(await internet.run("search_local_photos",query()))
    .toEqual({error:"tool_not_allowed"});
  expect(search).not.toHaveBeenCalled();
});

test("9T1-R2: actual local photo handles survive tool → LLM → chat photo cards, no image bytes",async()=>{
  const search=jest.fn().mockResolvedValue({
    text:"Нашёл подходящих фото: 3. Остальные варианты можно раскрыть.",
    memory:found,
  });
  const catalog=harness(search);
  const spec=catalog.definitions.find(t=>t.name==="search_local_photos");
  expect(spec?.parameters).toMatchObject({
    type:"object",required:["mode","description"],additionalProperties:false,
  });
  const response=await catalog.run("search_local_photos",query());
  expect(search).toHaveBeenCalledWith({mode:"text",description:"красный велосипед у дерева"});
  expect(response).toMatchObject({
    outcome:"found",scope:"standard_active_local_photos",
    status:"found",count:3,imageBytesIncluded:false,
    originalImagesInspectedByLLM:false,
    photos:[
      {id:"note-bike",photoAttachmentId:"photo-front"},
      {id:"note-bike",photoAttachmentId:"photo-side"},
      {id:"note-garden",photoAttachmentId:"photo-tree"},
    ],
  });
  expect(JSON.stringify(response)).not.toContain('"data":');
  expect(JSON.stringify(response)).not.toContain('"vector":');
  expect(JSON.stringify(response)).not.toContain('"base64":');
  expect(catalog.memory().filter(m=>"photo" in m && m.photo)).toEqual(found);
  expect(catalog.finish().photoAction).toBeUndefined();
  // Handles are answer-time pointers, never elevated to persistent memory facts.
  expect(JSON.stringify(catalog.finish().taskState)).not.toContain('"tool":"search_local_photos"');
});

test.each([
  ["model","model_missing"],["import","no_photos"],["prepare","unprepared"],
] as const)("9T1-R2: %s recovery is not misreported as 'no matches'",async(action,status)=>{
  const search=jest.fn().mockResolvedValue({
    text:"Поиск пока недоступен. Проверьте настройки.",memory:[],photoAction:action,
  });
  const catalog=harness(search);
  const response=await catalog.run("search_local_photos",query());
  expect(response).toMatchObject({outcome:"empty",status,count:0,photos:[],
    photoAction:action});
  expect(catalog.finish().photoAction).toBe(action);
  expect(catalog.memory()).toEqual([]);
});

test("9T1-R2: genuine empty result is distinct from unavailable index",async()=>{
  const search=jest.fn().mockResolvedValue({text:"Не найдено",memory:[]});
  const catalog=harness(search);
  expect(await catalog.run("search_local_photos",query())).toMatchObject({
    outcome:"empty",status:"no_matches",count:0,
  });
  expect(catalog.finish().photoAction).toBeUndefined();
});

test("9T1-R2: rejects web destinations, arbitrary IDs, forged originals and duplicate attachment handles",async()=>{
  const search=jest.fn().mockResolvedValue({text:"Нашёл",memory:found});
  const catalog=harness(search);
  for(const bad of [{},{description:"x"},{description:" "},
    {mode:"text",description:"а".repeat(161)},{mode:"text",description:22},
    {mode:"text",description:"красный велосипед",id:"private-note"},
    {mode:"text",description:"найди фото в интернете"},
    {mode:"text",description:"https://example.org/a"},
    {mode:"text",description:"коробка online"},
  ]){
    expect(await catalog.run("search_local_photos",bad))
      .toMatchObject({error:"invalid_local_photo_search_args"});
  }
  expect(search).not.toHaveBeenCalled();
  const badResults=[
    [{...found[0],id:"../private"}],
    [{...found[0],photoAttachmentId:"../other"}],
    [{...found[0],photo:false}],
    [{...found[0],via:"assistant"}],
    [{...found[0],title:""}],
    [found[0],found[0]],
    Array.from({length:21},(_,i)=>({...found[0],photoAttachmentId:"img-"+i})),
  ];
  for(const records of badResults){
    const badSearch=jest.fn().mockResolvedValue({text:"Нашёл",memory:records});
    const badCatalog=harness(badSearch);
    expect(await badCatalog.run("search_local_photos",query()))
      .toEqual({error:"invalid_local_photo_search_result"});
    expect(badCatalog.memory()).toEqual([]);
    expect(badCatalog.finish().photoAction).toBeUndefined();
  }
});

test("9T1-R2: at most two searches per turn, distinct photos of same note retained",async()=>{
  const search=jest.fn()
    .mockResolvedValueOnce({text:"Первый набор",memory:found.slice(0,2)})
    .mockResolvedValueOnce({text:"Другой",memory:[found[1],found[2]]});
  const catalog=harness(search);
  expect(await catalog.run("search_local_photos",query())).toMatchObject({
    count:2,outcome:"found",
  });
  expect(await catalog.run("search_local_photos",query("дерево во дворе")))
    .toMatchObject({count:2,outcome:"found"});
  expect(catalog.memory().filter(m=>"photo" in m && m.photo)).toEqual(found);
  expect(await catalog.run("search_local_photos",query("велосипед рядом")))
    .toEqual({error:"local_photo_turn_budget_exhausted"});
  expect(search).toHaveBeenCalledTimes(2);
});

test("9T1-R2: cancellation, lock and search failure cannot publish stale photo handles",async()=>{
  const aborter=new AbortController();
  const search=jest.fn().mockImplementation(async()=>{
    aborter.abort();
    return {text:"Found",memory:found};
  });
  const catalog=harness(search,{signal:aborter.signal});
  await expect(catalog.run("search_local_photos",query()))
    .rejects.toThrow("Запрос остановлен");
  expect(catalog.memory()).toEqual([]);
  const locked=harness(jest.fn().mockRejectedValue(
    new Error("application_locked")));
  expect(await locked.run("search_local_photos",query()))
    .toEqual({error:"tool_failed_or_unavailable"});
  expect(locked.memory()).toEqual([]);
});

test("9T1-R2: scripted Responses loop renders photo result from catalog and survives encrypted chat reopen",async()=>{
  const transport=jest.fn()
    .mockResolvedValueOnce(toolResponse("search_local_photos",query()))
    .mockResolvedValueOnce(final("В памяти есть снимки велосипеда, откройте найденные фото."));
  const search=jest.fn().mockResolvedValue({text:"Нашёл 3 фотографии",memory:found});
  const result=await runDirectAgent({
    settings,prompt:"Где фотографии велосипеда, которые я сохранил?",
    history:[],lookup:jest.fn().mockResolvedValue([]),
    propose:jest.fn(),searchPhotos:search,
    transport:transport as unknown as typeof fetch,
  });
  expect(result.requests).toBe(2);
  expect(search).toHaveBeenCalledTimes(1);
  expect(result.memory).toEqual(found);
  expect(result.text).toContain("откройте найденные фото");
  const modelInput=JSON.parse(transport.mock.calls[1][1].body);
  const photoToolResult=modelInput.input.find((part:any)=>
    part.type==="function_call_output" && part.call_id==="photo-1");
  const data=JSON.parse(photoToolResult.output);
  expect(data).toMatchObject({scope:"standard_active_local_photos",
    count:3,photos:expect.arrayContaining([
      expect.objectContaining({id:"note-bike",photoAttachmentId:"photo-front"}),
      expect.objectContaining({id:"note-bike",photoAttachmentId:"photo-side"}),
    ]),imageBytesIncluded:false});
  expect(modelInput.input.some((part:any)=>
    JSON.stringify(part).includes("data:image"))).toBe(false);
  const fixture={id:"photos",title:"Фотографии",
    createdAt:"2026-11-06T10:00:00.000Z",
    updatedAt:"2026-11-06T10:01:00.000Z",
    question:"",drafts:[],rows:[{id:"answer",role:"assistant",
      text:result.text,memory:result.memory}]};
  const saved=parseConversation(JSON.stringify(fixture));
  expect(saved?.rows[0].memory).toEqual(found);
});

test("9T1-R2: model absence produces an actionable assistant row",async()=>{
  const transport=jest.fn()
    .mockResolvedValueOnce(toolResponse("search_local_photos",query()))
    .mockResolvedValueOnce(final("Для поиска фотографий установите локальную модель."));
  const result=await runDirectAgent({
    settings,prompt:"Где сохранённые фотографии?",history:[],
    lookup:jest.fn().mockResolvedValue([]),propose:jest.fn(),
    transport:transport as unknown as typeof fetch,
    searchPhotos:jest.fn().mockResolvedValue({
      text:"Для поиска нужна модель",memory:[],photoAction:"model",
    }),
  });
  expect(result.photoAction).toBe("model");
  expect(result.memory).toEqual([]);
  const fixture={id:"photos",title:"Фотографии",createdAt:"2026-11-06",
    updatedAt:"2026-11-06",question:"",drafts:[],rows:[
      {id:"action",role:"assistant",text:result.text,photoAction:result.photoAction},
    ]};
  expect(parseConversation(JSON.stringify(fixture))?.rows[0].photoAction)
    .toBe("model");
});


test("9T1-R2 regression: ordinary memory references retain the previous eight-note limit",async()=>{
  const ordinary=Array.from({length:14},(_,i)=>({
    id:"note-"+i,title:"Ordinary note "+i,via:"assistant" as const,
  }));
  const options:DirectAgentOptions={
    settings,prompt:"Как меняется выбор фото?",history:[],
    lookup:jest.fn().mockResolvedValue([]),propose:jest.fn(),
    searchPhotos:jest.fn().mockResolvedValue({text:"Нашёл",memory:found}),
  };
  const catalog=createToolCatalog(options,[],[],ordinary);
  expect(catalog.memory()).toHaveLength(8);
  await catalog.run("search_local_photos",query());
  const refs=catalog.memory();
  expect(refs).toHaveLength(found.length+8);
  expect(refs.slice(0,found.length)).toEqual(found);
  expect(refs.filter(r=>!("photo" in r))).toHaveLength(8);
});

test("9T-R2: one local-photo tool serves selected image and text; image never goes to LLM",async()=>{
  const search=jest.fn().mockResolvedValue({text:"Нашёл",memory:found});
  const catalog=harness(search,{photoQueryAvailable:true});
  const descriptor=catalog.definitions.find(t=>t.name==="search_local_photos");
  expect(descriptor?.parameters).toMatchObject({
    properties:{mode:{enum:["text","image"]}},
    required:["mode","description"],
  });
  expect(await catalog.run("search_local_photos",{mode:"image",description:""}))
    .toMatchObject({outcome:"found",count:3,imageBytesIncluded:false});
  expect(search).toHaveBeenCalledWith({mode:"image",description:""});
  expect(await catalog.run("search_local_photos",{mode:"image",description:"guess"}))
    .toEqual({error:"invalid_local_photo_search_args"});
  const unavailable=harness(search);
  expect(await unavailable.run("search_local_photos",{mode:"image",description:""}))
    .toEqual({error:"invalid_local_photo_search_args"});
  expect(unavailable.definitions.find(t=>t.name==="search_local_photos")?.parameters)
    .toMatchObject({properties:{mode:{enum:["text"]}}});
});
