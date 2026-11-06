import { createToolCatalog } from "../tool-catalog";
import type { DirectAgentSettings } from "../settings";
import type { ChatArticlePage } from "../conversations";

const settings:DirectAgentSettings={
  provider:"openai",baseUrl:"https://api.openai.com/v1",model:"test-model",
  apiKey:"test",webSearchKey:"",allowWeb:false,
};
const page:ChatArticlePage={
  kind:"saved_topic_links",topic:"космос",queryTerms:["космос"],
  savedFrom:"2026-10-31T00:00:00.000Z",savedBefore:"2026-11-07T00:00:00.000Z",
  startLocal:"2026-10-31",endLocal:"2026-11-06",
  selected:Array.from({length:8},(_,i)=>({id:"note-"+i,version:2})),
};
function response(id:string,version:number,budget:number,body:string){
  const content=body.slice(0,budget);
  return {id,revision:version,title:"Заметка "+id,content,offset:0,
    totalChars:body.length,hasMore:content.length<body.length,
    ...(content.length<body.length?{nextOffset:content.length}:{}),
    evidence:{recordId:id,recordVersion:version,startChar:0,endChar:content.length,
      coverage:content.length===body.length?"complete":"excerpt",
      originalPage:null,originalTime:null},
  };
}
function harness(read:jest.Mock, selected:ChatArticlePage=page){
  return createToolCatalog({settings,prompt:"Сделай из них выжимку",
    history:[],lookup:jest.fn().mockResolvedValue([]),propose:jest.fn(),
    selectArticles:jest.fn(),articleSelection:selected,read,
  },[],[],[]);
}
const args=(startIndex:number,count=6,charsPerNote=1000)=>({startIndex,count,charsPerNote});

test("9B: read selected article IDs only, with bounded pages, verified evidence and actual memory citations",async()=>{
  const read=jest.fn().mockImplementation(async(id:string,v:number,_offset:number,b:number)=>{
    if(id==="note-1")return response(id,v,b,"https://example.org/a");
    if(id==="note-2")return response(id,v,b,"");
    return response(id,v,b,"Проверяемые факты о космосе. ".repeat(id==="note-3"?100:2));
  });
  const catalog=harness(read);
  expect(catalog.definitions.some(t=>t.name==="read_selected_local_articles")).toBe(true);
  const first=await catalog.run("read_selected_local_articles",args(0));
  expect(first).toMatchObject({outcome:"read",selectedCount:8,checked:6,
    hasMore:true,nextIndex:6,linkOnlyCount:1,partialCount:1});
  expect(first.entries).toHaveLength(6);
  expect((first.entries as Array<Record<string,unknown>>).slice(0,4)).toMatchObject([
    {id:"note-0",version:2,status:"complete_saved_note_text"},
    {id:"note-1",status:"link_only"},{id:"note-2",status:"empty_saved_note"},
    {id:"note-3",status:"partial_saved_note"},
  ]);
  const second=await catalog.run("read_selected_local_articles",args(6));
  expect(second).toMatchObject({outcome:"read",selectedCount:8,checked:2,hasMore:false});
  expect(read).toHaveBeenCalledTimes(8);
  expect(read).toHaveBeenNthCalledWith(8,"note-7",2,0,1000);
  expect(catalog.memory().map(m=>m.id)).not.toContain("note-1");
  expect(catalog.memory().map(m=>m.id)).not.toContain("note-2");
  expect(catalog.memory().map(m=>m.id)).toContain("note-3");
  expect(catalog.finish().articlePage?.selected).toEqual(page.selected);
});

test("9B: model cannot inject arbitrary IDs or inflate bytes/pages; no source read on invalid arguments",async()=>{
  const read=jest.fn();
  const catalog=harness(read);
  expect(await catalog.run("read_selected_local_articles",{
    ...args(0),id:"sensitive-note",
  })).toMatchObject({error:"invalid_selected_article_args"});
  expect(await catalog.run("read_selected_local_articles",args(0,7)))
    .toMatchObject({error:"invalid_selected_article_args"});
  expect(await catalog.run("read_selected_local_articles",args(0,6,6000)))
    .toMatchObject({error:"invalid_selected_article_args"});
  expect(await catalog.run("read_selected_local_articles",args(24)))
    .toMatchObject({error:"invalid_selected_article_args"});
  expect(read).not.toHaveBeenCalled();
});

test("9B: stale/reclassified notes do not leak title or contents, other selected notes remain readable",async()=>{
  const read=jest.fn().mockImplementation(async(id:string,v:number,_offset:number,b:number)=>{
    if(id==="note-0")throw new Error("stale_memory_version");
    if(id==="note-1")throw new Error("memory_read_not_available");
    return response(id,v,b,"Данные из исходника");
  });
  const result=await harness(read).run("read_selected_local_articles",args(0,3));
  expect(result).toMatchObject({outcome:"read",unavailableCount:2,
    entries:[{id:"note-0",status:"not_available_or_stale"},
      {id:"note-1",status:"not_available_or_stale"},
      {id:"note-2",status:"complete_saved_note_text"}]});
  expect(JSON.stringify(result)).not.toContain("private");
});

test("9B: corrupted result or mid-read AppLock fails closed; unverified content is not returned",async()=>{
  const read=jest.fn().mockResolvedValue(response("different-id",2,1000,"Подмена"));
  const invalid=await harness(read).run("read_selected_local_articles",args(0,1));
  expect(invalid).toEqual({error:"tool_failed_or_unavailable"});
  read.mockReset().mockRejectedValue(new Error("application_locked"));
  expect(await harness(read).run("read_selected_local_articles",args(0,1)))
    .toEqual({error:"tool_failed_or_unavailable"});
});

test("9B: an absent selection hides even the batch tool",async()=>{
  const read=jest.fn();
  const catalog=createToolCatalog({settings,prompt:"Привет",history:[],
    lookup:jest.fn().mockResolvedValue([]),propose:jest.fn(),read,
  },[],[],[]);
  expect(catalog.definitions.some(t=>t.name==="read_selected_local_articles")).toBe(false);
  expect(await catalog.run("read_selected_local_articles",args(0)))
    .toEqual({error:"tool_not_allowed"});
});
