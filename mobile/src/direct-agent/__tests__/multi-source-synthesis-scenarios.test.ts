import { runDirectAgent } from "../engine";
import type { DirectAgentSettings } from "../settings";
import type { ChatArticlePage, ChatArticleReadReport } from "../conversations";
import { parseConversation } from "../conversations";
import { articleCitationCounts, resolveArticleCitation } from "../article-citations";

const settings:DirectAgentSettings={
  provider:"openai",apiKey:"fixture-only",webSearchKey:"",
  baseUrl:"https://api.openai.com/v1",model:"gpt-4.1-mini",allowWeb:false,
};
const selected:ChatArticlePage={
  kind:"saved_topic_links",topic:"локальные модели",queryTerms:["локальные модели"],
  savedFrom:"2026-10-31T00:00:00.000Z",savedBefore:"2026-11-07T00:00:00.000Z",
  startLocal:"2026-10-31",endLocal:"2026-11-06",dateMode:"saved",
  selected:Array.from({length:8},(_,i)=>({id:"report-"+i,version:3})),
};
const bodies=[
  "Испытание Atlas: локальная модель обрабатывает 100 запросов в секунду; автор считает это быстрым вариантом.",
  "Испытание Atlas: локальная модель обрабатывает 20 запросов в секунду; автор считает её медленной.",
  "Сравнение длинных заметок по локальным моделям. ".repeat(350),
  "https://example.org/just-a-link",
  "",
  "Удалённая или обновлённая заметка о моделях.",
  "Модель Orion работает без подключения к интернету, но требует много ОЗУ.",
  "Обзор Vega: малая модель работает на обычном смартфоне.",
];
// Exactly 13k+ UTF-16 code units: proves the first excerpt is never a full analysis.
expect(bodies[2].length).toBeGreaterThan(13_000);
const tool=(name:string,args:unknown,callId:string)=>({
  ok:true,status:200,json:async()=>({status:"completed",output:[
    {type:"function_call",name,call_id:callId,arguments:JSON.stringify(args)},
  ]}),
});
const reply=(text:string)=>({ok:true,status:200,json:async()=>({
  status:"completed",output:[{type:"message",
    content:[{type:"output_text",text}]}],
})});
const batch=(startIndex:number,count:number,charsPerNote=1000)=>({
  startIndex,count,charsPerNote,
});
const chunk=(selectedIndex:number,offset:number,budget:number)=>({
  selectedIndex,offset,budget,
});
const run=(transport:jest.Mock,read:jest.Mock,extras:Record<string,unknown>={})=>
  runDirectAgent({settings,prompt:"Сравни все восемь статей и покажи расхождения",
    history:[],lookup:jest.fn().mockResolvedValue([]),propose:jest.fn(),
    transport:transport as unknown as typeof fetch,
    selectArticles:jest.fn(),read,articleSelection:selected,
    ...extras,
  });
function canonicalRead(revisedIndex?:number) {
  return jest.fn(async(id:string,version:number,offset:number,budget:number)=>{
    const index=Number(id.slice("report-".length));
    if(index===5 || index===revisedIndex)throw new Error("stale_memory_version");
    if(!Number.isSafeInteger(index) || index<0 || index>=bodies.length ||
      version!==3)throw new Error("memory_read_not_available");
    const body=bodies[index];
    const content=body.slice(offset,offset+budget),end=offset+content.length;
    return {id,revision:version,title:"Материал №"+(index+1),
      offset,content,totalChars:body.length,hasMore:end<body.length,
      ...(end<body.length?{nextOffset:end}:{}),
      evidence:{recordId:id,recordVersion:version,startChar:offset,
        endChar:end,coverage:offset===0&&end===body.length?"complete":"excerpt",
        originalPage:null,originalTime:null},
    };
  });
}
function byIndex(report:ChatArticleReadReport,index:number){
  return report.entries[index];
}
function roundTrip(text:string,report:ChatArticleReadReport,articlePage:ChatArticlePage){
  const fixture={id:"conversation-8",title:"Подборка восьми статей",
    createdAt:"2026-11-06T08:00:00.000Z",
    updatedAt:"2026-11-06T08:01:00.000Z",question:"",drafts:[],
    rows:[{id:"answer-1",role:"assistant",text,articleReadReport:report,
      articlePage}]};
  const restored=parseConversation(JSON.stringify(fixture));
  expect(restored?.rows[0].articleReadReport).toEqual(report);
  return restored!;
}

test("9B acceptance: 8 selected, contradictory articles, missing middle of long note, link-only, empty, stale and unread",async()=>{
  const answer=[
    "Есть противоречие: в Atlas указаны 100 запросов/с [[S1:0-75]]",
    "и 20 запросов/с [[S2:0-75]].",
    "Поздняя часть длинной заметки видна [[S3:7000-7100]],",
    "но её середина не прочитана [[S3:2000-2100]].",
    "URL-only не подтверждает содержания [[S4:0-10]].",
    "Сводка частичная: два из восьми материалов пока не прочитаны.",
  ].join("\n");
  const transport=jest.fn()
    .mockResolvedValueOnce(tool("read_selected_local_articles",batch(0,6),"b1"))
    .mockResolvedValueOnce(tool("read_selected_article_chunk",chunk(2,7000,1000),"c1"))
    .mockResolvedValueOnce(tool("selected_article_read_coverage",{},"cov"))
    .mockResolvedValueOnce(reply(answer));
  const read=canonicalRead();
  const result=await run(transport,read);
  expect(result.text).toBe(answer);
  expect(result.requests).toBe(4);
  expect(read).toHaveBeenCalledTimes(7); // six selected, plus a distant chunk
  expect(read.mock.calls.some(c=>c[0]==="report-6"||c[0]==="report-7")).toBe(false);
  expect(result.articlePage?.selected).toEqual(selected.selected);
  const report=result.articleReadReport!;
  expect(report).toBeDefined();
  expect(report.entries.map(e=>e.status)).toEqual([
    "complete_saved_note_text","complete_saved_note_text","partial_saved_note",
    "link_only","empty_saved_note","not_available_or_stale","unread","unread",
  ]);
  expect(byIndex(report,2)).toMatchObject({totalChars:bodies[2].length,
    verifiedChars:2000,ranges:[{startChar:0,endChar:1000},
      {startChar:7000,endChar:8000}]});
  expect(byIndex(report,5)).toMatchObject({verifiedChars:0,status:"not_available_or_stale"});
  expect(articleCitationCounts(answer,report)).toEqual({valid:3,invalid:2});
  expect(resolveArticleCitation(report,{index:3,startChar:2000,endChar:2100})).toBeNull();
  const modelInput=JSON.parse(transport.mock.calls[3][1].body);
  const coverageOutput=modelInput.input.find((n:any)=>
    n.type==="function_call_output"&&n.call_id==="cov");
  expect(JSON.parse(coverageOutput.output)).toMatchObject({
    selectedCount:8,fullyReadCount:2,partialCount:1,
    linkOnlyCount:1,emptyCount:1,unavailableCount:1,unreadCount:2,
    allSelectedHaveFullSavedNoteText:false,originalWebPagesVerified:0,
  });
  const batchOutput=JSON.parse(modelInput.input.find((n:any)=>
    n.type==="function_call_output"&&n.call_id==="b1").output);
  expect(batchOutput.entries.map((n:any)=>n.selectedIndex)).toEqual([0,1,2,3,4,5]);
  expect(batchOutput.entries[5]).toMatchObject({
    selectedIndex:5,id:"report-5",status:"not_available_or_stale",
  });
  // Even the encrypted task scratchpad does not certify a later turn's sources.
  expect(JSON.stringify(result.taskState)).not.toContain(
    '"tool":"selected_article_read_coverage"');
  roundTrip(result.text,report,result.articlePage!);
});

test("9B acceptance: 8 items across two batches, re-read a 13k+ note and report remaining exceptions",async()=>{
  const transport=jest.fn()
    .mockResolvedValueOnce(tool("read_selected_local_articles",batch(0,6),"b1"))
    .mockResolvedValueOnce(tool("read_selected_local_articles",batch(6,2),"b2"))
    .mockResolvedValueOnce(tool("read_selected_article_chunk",chunk(2,1000,6000),"c1"))
    .mockResolvedValueOnce(tool("read_selected_article_chunk",chunk(2,7000,6000),"c2"))
    .mockResolvedValueOnce(tool("read_selected_article_chunk",
      chunk(2,13000,6000),"c3"))
    .mockResolvedValueOnce(tool("selected_article_read_coverage",{},"cov"))
    .mockResolvedValueOnce(reply("Atlas противоречив [[S1:0-45]] [[S2:0-45]]."));
  const read=canonicalRead();
  const result=await run(transport,read,{maxRequests:8});
  expect(result.requests).toBe(7);
  const report=result.articleReadReport!;
  expect(report.entries).toHaveLength(8);
  expect(byIndex(report,2)).toMatchObject({status:"complete_saved_note_text",
    verifiedChars:bodies[2].length,ranges:[{startChar:0,endChar:bodies[2].length}]});
  expect(byIndex(report,6).status).toBe("complete_saved_note_text");
  expect(byIndex(report,7).status).toBe("complete_saved_note_text");
  expect(byIndex(report,3).status).toBe("link_only");
  expect(byIndex(report,4).status).toBe("empty_saved_note");
  expect(byIndex(report,5).status).toBe("not_available_or_stale");
  expect(articleCitationCounts(result.text,report)).toEqual({valid:2,invalid:0});
  const modelInput=JSON.parse(transport.mock.calls[6][1].body);
  const coverageOutput=modelInput.input.find((n:any)=>
    n.type==="function_call_output"&&n.call_id==="cov");
  expect(JSON.parse(coverageOutput.output)).toMatchObject({
    selectedCount:8,fullyReadCount:5,partialCount:0,
    linkOnlyCount:1,emptyCount:1,unavailableCount:1,unreadCount:0,
    allSelectedHaveFullSavedNoteText:false,originalWebPagesVerified:0,
  });
  const batch2=JSON.parse(modelInput.input.find((n:any)=>
    n.type==="function_call_output"&&n.call_id==="b2").output);
  expect(batch2.entries.map((n:any)=>n.selectedIndex)).toEqual([6,7]);
  const reopened=roundTrip(result.text,report,result.articlePage!);
  const past=reopened.rows[0].articleReadReport!;
  expect(past.entries[2].ranges).toEqual([{startChar:0,endChar:bodies[2].length}]);
});

test("9C acceptance: follow-up keeps the same selection/filter but re-authorizes versions; prior reads cannot count",async()=>{
  const transport=jest.fn()
    .mockResolvedValueOnce(tool("read_selected_local_articles",batch(0,6),"batch"))
    .mockResolvedValueOnce(reply("Первая сводка [[S1:0-40]]."));
  const initial=await run(transport,canonicalRead());
  const saved=roundTrip(initial.text,initial.articleReadReport!,initial.articlePage!);
  const prior=saved.rows[0];
  const changedRead=canonicalRead(0); // source revision no longer matches
  const nextTransport=jest.fn()
    .mockResolvedValueOnce(tool("read_selected_local_articles",batch(0,2),"new"))
    .mockResolvedValueOnce(tool("selected_article_read_coverage",{},"new-cov"))
    .mockResolvedValueOnce(reply("Новая версия Atlas недоступна; остался второй материал [[S2:0-40]]."));
  const followup=await run(nextTransport,changedRead,{
    prompt:"А теперь только о скорости этих же локальных моделей.",
    history:[{role:"user",content:"Сравни статьи"},
      {role:"assistant",content:initial.text}],
    articleSelection:prior.articlePage,
  });
  expect(changedRead).toHaveBeenCalledTimes(2);
  expect(changedRead.mock.calls.map(c=>c[0])).toEqual(["report-0","report-1"]);
  expect(followup.articlePage?.selected).toEqual(prior.articlePage?.selected);
  expect(followup.articlePage?.savedFrom).toBe(prior.articlePage?.savedFrom);
  expect(followup.articlePage?.savedBefore).toBe(prior.articlePage?.savedBefore);
  expect(followup.articleReadReport?.entries.map(e=>e.status)).toEqual([
    "not_available_or_stale","complete_saved_note_text",
    "unread","unread","unread","unread","unread","unread",
  ]);
  expect(articleCitationCounts(followup.text,followup.articleReadReport!))
    .toEqual({valid:1,invalid:0});
  expect(resolveArticleCitation(followup.articleReadReport!,{
    index:1,startChar:0,endChar:30,
  })).toBeNull();
  const replyInput=JSON.parse(nextTransport.mock.calls[2][1].body);
  const cov=JSON.parse(replyInput.input.find((n:any)=>
    n.type==="function_call_output"&&n.call_id==="new-cov").output);
  expect(cov).toMatchObject({selectedCount:8,fullyReadCount:1,unavailableCount:1,
    unreadCount:6,checkedCount:2});
  expect(JSON.stringify(followup.taskState)).not.toContain(
    '"tool":"selected_article_read_coverage"');
});
