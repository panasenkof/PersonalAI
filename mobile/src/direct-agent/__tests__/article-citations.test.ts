import { ARTICLE_CITATION_RE, articleCitationCounts, resolveArticleCitation }
  from "../article-citations";
import type { ChatArticleReadReport } from "../conversations";
import { parseInline, parseMarkdown, hasMarkdown } from "../../components/markdown-parse";

const report:ChatArticleReadReport={
  kind:"selected_saved_note_reads",selectedCount:4,entries:[
    {selectedIndex:0,id:"full-1",version:3,title:"Полная заметка",
      status:"complete_saved_note_text",totalChars:8000,verifiedChars:8000,
      ranges:[{startChar:0,endChar:8000}]},
    {selectedIndex:1,id:"partial-2",version:7,title:"Частично прочитана",
      status:"partial_saved_note",totalChars:9000,verifiedChars:3500,
      ranges:[{startChar:0,endChar:1500},{startChar:6000,endChar:8000}]},
    {selectedIndex:2,id:"url-only",version:1,title:"Только ссылка",
      status:"link_only",totalChars:30,verifiedChars:30,
      ranges:[{startChar:0,endChar:30}]},
    {selectedIndex:3,id:"stale-4",version:1,
      status:"not_available_or_stale",verifiedChars:0,ranges:[]},
  ],
};
const cite=(index:number,startChar:number,endChar:number)=>({index,startChar,endChar});

test("9C: links only to bounded intervals that were actually read",()=>{
  expect(resolveArticleCitation(report,cite(1,0,250))).toMatchObject({
    id:"full-1",version:3,title:"Полная заметка"});
  expect(resolveArticleCitation(report,cite(2,6300,7400))).toMatchObject({
    id:"partial-2",version:7});
  for(const pointer of [
    cite(1,8000,8001),cite(1,0,8001),cite(1,-1,100),
    cite(1,200,200),cite(1,500,200),cite(2,1200,6200),
    cite(2,5000,6300),cite(2,8000,8500),cite(3,0,20),
    cite(4,0,100),cite(0,0,10),cite(5,0,10),cite(999,0,10),
    cite(NaN,0,10),cite(1,0,Infinity),
  ])expect(resolveArticleCitation(report,pointer)).toBeNull();
  expect(resolveArticleCitation(undefined,cite(1,0,20))).toBeNull();
  const legacy={...report,entries:[{...report.entries[0],ranges:undefined},
    ...report.entries.slice(1)]};
  expect(resolveArticleCitation(legacy,cite(1,0,20))).toBeNull();
});

test("9C: unverified citations never gain a fake clickable target",()=>{
  const answer="Верный диапазон [[S1:0-250]], разрыв [[S2:1200-6200]], " +
    "ссылка без текста [[S3:0-10]], чужой номер [[S999:0-50]].";
  expect([...answer.matchAll(ARTICLE_CITATION_RE)]).toHaveLength(4);
  expect(articleCitationCounts(answer,report)).toEqual({valid:1,invalid:3});
  expect(articleCitationCounts("Нет ссылок",report)).toEqual({valid:0,invalid:0});
});

test("9C: existing Markdown list, bold, italic, external links and code survive",()=>{
  const answer="# Вывод\n- **Справка [[S1:0-250]]** и " +
    "[сайт](https://example.org)\n> *Диапазон [[S2:6000-7000]]*";
  const blocks=parseMarkdown(answer,true);
  expect(blocks[0]).toMatchObject({kind:"heading"});
  expect(blocks[1]).toMatchObject({kind:"bullet"});
  expect((blocks[1] as {spans:any[]}).spans).toEqual(expect.arrayContaining([
    expect.objectContaining({text:"[[S1:0-250]]",bold:true,
      citation:{index:1,startChar:0,endChar:250}}),
    expect.objectContaining({text:"сайт",url:"https://example.org"}),
  ]));
  expect((blocks[2] as {spans:any[]}).spans).toEqual(expect.arrayContaining([
    expect.objectContaining({text:"[[S2:6000-7000]]",italic:true,
      citation:{index:2,startChar:6000,endChar:7000}}),
  ]));
  expect(parseInline("Текст [[S1:0-250]]",{},false).every(s=>!s.citation))
    .toBe(true);
  expect(hasMarkdown("Текст [[S1:0-250]]",true)).toBe(true);
  expect(hasMarkdown("Текст [[S1:0-250]]",false)).toBe(false);

  const code=parseMarkdown("```\n[[S1:0-250]]\n```\nПосле [[S1:20-70]]",true);
  expect(code[0]).toEqual({kind:"code",text:"[[S1:0-250]]"});
  expect(code[1]).toMatchObject({kind:"paragraph"});
  expect((code[1] as {spans:any[]}).spans).toContainEqual(
    expect.objectContaining({citation:{index:1,startChar:20,endChar:70}}));
});
