import { createToolCatalog } from "../tool-catalog";
import type { DirectAgentSettings } from "../settings";
import type { ChatArticlePage } from "../conversations";

const settings:DirectAgentSettings={
  provider:"openai",baseUrl:"https://api.openai.com/v1",model:"test-model",
  apiKey:"test",webSearchKey:"",allowWeb:false,
};
const selected:ChatArticlePage={
  kind:"saved_topic_links",topic:"космос",queryTerms:["космос"],
  savedFrom:"2026-10-31T00:00:00.000Z",savedBefore:"2026-11-07T00:00:00.000Z",
  startLocal:"2026-10-31",endLocal:"2026-11-06",
  selected:[{id:"note-0",version:2},{id:"note-1",version:3},
    {id:"note-2",version:4},{id:"note-3",version:5}],
};
const text="A".repeat(13_000);
function evidence(id:string,version:number,offset:number,budget:number,body:string) {
  const content=body.slice(offset,offset+budget), end=offset+content.length;
  return {id,revision:version,title:id,content,offset,totalChars:body.length,
    hasMore:end<body.length,...(end<body.length?{nextOffset:end}:{}),
    evidence:{recordId:id,recordVersion:version,startChar:offset,endChar:end,
      coverage:offset===0&&end===body.length?"complete":"excerpt",
      originalPage:null,originalTime:null},
  };
}
const chunks=(selectedIndex:number,offset:number,budget=6000)=>({selectedIndex,offset,budget});
function harness(read:jest.Mock,other:Partial<Parameters<typeof createToolCatalog>[0]>={}) {
  return createToolCatalog({settings,prompt:"Обобщи прочитанные статьи",history:[],
    lookup:jest.fn().mockResolvedValue([]),propose:jest.fn(),
    selectArticles:jest.fn(),articleSelection:selected,read,...other,
  },[],[],[]);
}

test("9B: verified ranges merge but disjoint read cannot claim full saved note",async()=>{
  const read=jest.fn(async(id:string,v:number,off:number,b:number)=>{
    if(id==="note-2")throw new Error("stale_memory_version");
    return evidence(id,v,off,b,id==="note-1"?"https://example.org/article":text);
  });
  const tools=harness(read);
  await tools.run("read_selected_local_articles",{startIndex:0,count:3,charsPerNote:1000});
  let result=await tools.run("selected_article_read_coverage",{});
  expect(result).toMatchObject({outcome:"read",selectedCount:4,
    fullyReadCount:0,partialCount:1,linkOnlyCount:1,
    unavailableCount:1,unreadCount:1,readTextCount:1,
    allSelectedHaveFullSavedNoteText:false,originalWebPagesVerified:0});
  expect(result.entries).toMatchObject([
    {selectedIndex:0,status:"partial_saved_note",verifiedChars:1000,nextUnreadOffset:1000},
    {selectedIndex:1,status:"link_only",verifiedChars:27},
    {selectedIndex:2,status:"not_available_or_stale",verifiedChars:0},
    {selectedIndex:3,status:"unread",verifiedChars:0},
  ]);

  await tools.run("read_selected_article_chunk",chunks(0,6000,6000));
  result=await tools.run("selected_article_read_coverage",{});
  expect(result.entries[0]).toMatchObject({status:"partial_saved_note",
    verifiedChars:7000,nextUnreadOffset:1000,
    ranges:[{startChar:0,endChar:1000},{startChar:6000,endChar:12000}]});

  await tools.run("read_selected_article_chunk",chunks(0,1000,5000));
  await tools.run("read_selected_article_chunk",chunks(0,12000,1000));
  result=await tools.run("selected_article_read_coverage",{});
  expect(result).toMatchObject({fullyReadCount:1,partialCount:0,
    linkOnlyCount:1,unavailableCount:1,unreadCount:1,readTextCount:1});
  expect(result.entries[0]).toMatchObject({status:"complete_saved_note_text",
    totalChars:13000,verifiedChars:13000,ranges:[{startChar:0,endChar:13000}]});
});

test("9B: verified old ranges are discarded when source is reclassified inaccessible",async()=>{
  const read=jest.fn(async(id:string,v:number,o:number,b:number)=>evidence(id,v,o,b,text));
  const tools=harness(read);
  expect(await tools.run("read_selected_article_chunk",chunks(0,0,6000)))
    .toMatchObject({outcome:"read"});
  read.mockRejectedValue(new Error("memory_read_not_available"));
  expect(await tools.run("read_selected_article_chunk",chunks(0,6000)))
    .toMatchObject({outcome:"empty",status:"not_available_or_stale"});
  const coverage=await tools.run("selected_article_read_coverage",{});
  expect(coverage.entries[0]).toMatchObject({status:"not_available_or_stale",
    verifiedChars:0,ranges:[]});
  expect(tools.memory().map(n=>n.id)).not.toContain("note-0");
});

test("9B: total length conflict with same revision invalidates all accumulated coverage",async()=>{
  const read=jest.fn(async(id:string,v:number,o:number,b:number)=>evidence(id,v,o,b,text));
  const tools=harness(read);
  await tools.run("read_selected_article_chunk",chunks(0,0,6000));
  read.mockImplementation(async(id:string,v:number,o:number,b:number)=>evidence(id,v,o,b,text+"Z"));
  expect(await tools.run("read_selected_article_chunk",chunks(0,6000)))
    .toEqual({error:"tool_failed_or_unavailable"});
  const coverage=await tools.run("selected_article_read_coverage",{});
  expect(coverage.entries[0]).toMatchObject({status:"unread",verifiedChars:0});
});

test("9B: coverage tool checks authorization, input and stays within one model turn",async()=>{
  const read=jest.fn(async(id:string,v:number,o:number,b:number)=>evidence(id,v,o,b,"Факт"));
  const first=harness(read);
  await first.run("read_selected_article_chunk",chunks(0,0));
  const next=harness(read);
  expect((await next.run("selected_article_read_coverage",{})).entries[0])
    .toMatchObject({status:"unread"});
  expect(await first.run("selected_article_read_coverage",{id:"private"}))
    .toMatchObject({error:"invalid_article_coverage_args"});
  const locked=harness(read,{workspaceAvailable:()=>false});
  expect(await locked.run("selected_article_read_coverage",{}))
    .toMatchObject({error:"application_locked"});
  const noSelection=createToolCatalog({settings,prompt:"Привет",history:[],
    lookup:jest.fn().mockResolvedValue([]),propose:jest.fn(),read,
  },[],[],[]);
  expect(noSelection.definitions.some(x=>x.name==="selected_article_read_coverage")).toBe(false);
  expect(await noSelection.run("selected_article_read_coverage",{}))
    .toEqual({error:"tool_not_allowed"});
});

test("9B: invalid evidence cannot certify even a single source",async()=>{
  const read=jest.fn(async(id:string,v:number,o:number,b:number)=>({
    ...evidence(id,v,o,b,text),
    evidence:{recordId:id,recordVersion:v,startChar:o,endChar:999999,coverage:"excerpt"},
  }));
  const tools=harness(read);
  expect(await tools.run("read_selected_article_chunk",chunks(0,0)))
    .toEqual({error:"tool_failed_or_unavailable"});
  expect((await tools.run("selected_article_read_coverage",{})).entries[0])
    .toMatchObject({status:"unread",verifiedChars:0});
});
