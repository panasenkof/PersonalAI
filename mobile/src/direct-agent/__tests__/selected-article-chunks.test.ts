import { createToolCatalog } from "../tool-catalog";
import type { DirectAgentSettings } from "../settings";
import type { ChatArticlePage } from "../conversations";

const settings:DirectAgentSettings={
  provider:"openai",baseUrl:"https://api.openai.com/v1",model:"test-model",
  apiKey:"test",webSearchKey:"",allowWeb:false,
};
const selection:ChatArticlePage={
  kind:"saved_topic_links",topic:"космос",queryTerms:["космос"],
  savedFrom:"2026-10-31T00:00:00.000Z",savedBefore:"2026-11-07T00:00:00.000Z",
  startLocal:"2026-10-31",endLocal:"2026-11-06",
  selected:[{id:"note-0",version:2},{id:"note-1",version:4}],
};
const args=(selectedIndex:number,offset:number|null=0,budget:number|null=6000)=>({
  selectedIndex,offset,budget,
});
const body="Раздел с проверяемыми сведениями. ".repeat(330);
function response(id:string,version:number,offset:number,budget:number,text=body){
  const content=text.slice(offset,offset+budget);
  const nextOffset=offset+content.length;
  return {id,revision:version,title:"Сохранённый текст",content,offset,
    totalChars:text.length,hasMore:nextOffset<text.length,
    ...(nextOffset<text.length?{nextOffset}:{}),
    evidence:{recordId:id,recordVersion:version,startChar:offset,endChar:nextOffset,
      coverage:nextOffset===text.length&&offset===0?"complete":"excerpt",
      originalPage:null,originalTime:null},
  };
}
function harness(read:jest.Mock,selected:ChatArticlePage=selection){
  return createToolCatalog({settings,prompt:"Дочитай выбранные статьи",
    history:[],lookup:jest.fn().mockResolvedValue([]),propose:jest.fn(),
    selectArticles:jest.fn(),articleSelection:selected,read,
  },[],[],[]);
}

test("9B: selected chunk continuation covers later text without arbitrary IDs or false full-read claims",async()=>{
  const read=jest.fn().mockImplementation(async(id:string,v:number,offset:number,budget:number)=>
    response(id,v,offset,budget));
  const catalog=harness(read);
  expect(catalog.definitions.some(t=>t.name==="read_selected_article_chunk")).toBe(true);
  const first=await catalog.run("read_selected_article_chunk",args(0,0,6000));
  expect(first).toMatchObject({outcome:"read",id:"note-0",version:2,
    offset:0,hasMore:true,nextOffset:6000,sourceCoverage:"verified_chunk_only",
    savedNoteFullyRead:false,originalWebPageRead:false});
  const second=await catalog.run("read_selected_article_chunk",args(0,6000,6000));
  expect(second).toMatchObject({outcome:"read",id:"note-0",version:2,
    offset:6000,hasMore:false,sourceCoverage:"verified_chunk_only",
    savedNoteFullyRead:false,originalWebPageRead:false});
  expect(read).toHaveBeenNthCalledWith(2,"note-0",2,6000,6000);
  expect((first.content as string)+(second.content as string)).toBe(body);
  expect(catalog.memory().some(n=>n.id==="note-0")).toBe(true);
  expect(catalog.finish().articlePage?.selected).toEqual(selection.selected);
});

test("9B: one full saved note can be classified, but a URL is never original article evidence",async()=>{
  const read=jest.fn().mockImplementation(async(id:string,v:number,offset:number,budget:number)=>
    response(id,v,offset,budget,id==="note-1"?"https://example.com/article":"Короткая заметка"));
  const catalog=harness(read);
  expect(await catalog.run("read_selected_article_chunk",args(1,0,1000)))
    .toMatchObject({outcome:"read",status:"link_only",savedNoteFullyRead:true,
      originalWebPageRead:false});
  expect(await catalog.run("read_selected_article_chunk",args(0,0,1000)))
    .toMatchObject({outcome:"read",status:"saved_note_chunk",savedNoteFullyRead:true});
  expect(catalog.memory().map(n=>n.id)).not.toContain("note-1");
});

test("9B: reject arbitrary record IDs, unselected indices and oversized or negative ranges",async()=>{
  const read=jest.fn();
  const catalog=harness(read);
  expect(await catalog.run("read_selected_article_chunk",{...args(0),id:"private"}))
    .toMatchObject({error:"invalid_selected_article_chunk_args"});
  for(const invalid of [args(2),args(-1),args(0,-1),args(0,0,6001),
    args(0,0,0),args(0,20_000_001),args(0,0,101.3)]){
    expect(await catalog.run("read_selected_article_chunk",invalid))
      .toMatchObject({error:"invalid_selected_article_chunk_args"});
  }
  expect(read).not.toHaveBeenCalled();
});

test("9B: stale selected note does not leak content; lock and corrupt evidence fail closed",async()=>{
  const read=jest.fn().mockRejectedValue(new Error("stale_memory_version"));
  const catalog=harness(read);
  const stale=await catalog.run("read_selected_article_chunk",args(0));
  expect(stale).toMatchObject({outcome:"empty",contentIncluded:false,status:"not_available_or_stale"});
  expect(stale).not.toHaveProperty("content");
  read.mockRejectedValue(new Error("application_locked"));
  expect(await catalog.run("read_selected_article_chunk",args(0)))
    .toEqual({error:"tool_failed_or_unavailable"});
  read.mockImplementation(async(id:string,v:number,o:number,b:number)=>({
    ...response(id,v,o,b),evidence:{recordId:id,recordVersion:v,startChar:o,endChar:9_999_999,coverage:"excerpt"},
  }));
  expect(await catalog.run("read_selected_article_chunk",args(0)))
    .toEqual({error:"tool_failed_or_unavailable"});
});

test("9B: invalid selection and missing capability do not expose chunk tool data",async()=>{
  const read=jest.fn();
  const corrupted={...selection,selected:[{id:"note-0",version:2},{id:"note-0",version:2}]};
  const catalog=harness(read,corrupted);
  expect(await catalog.run("read_selected_article_chunk",args(0)))
    .toMatchObject({error:"missing_or_invalid_article_selection"});
  const noSelection=createToolCatalog({settings,prompt:"Привет",history:[],
    lookup:jest.fn().mockResolvedValue([]),propose:jest.fn(),read,
  },[],[],[]);
  expect(noSelection.definitions.some(t=>t.name==="read_selected_article_chunk")).toBe(false);
  expect(await noSelection.run("read_selected_article_chunk",args(0)))
    .toEqual({error:"tool_not_allowed"});
  expect(read).not.toHaveBeenCalled();
});
