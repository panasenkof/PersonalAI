import { prepareAssistantReplyNote } from "../chat-response-note";
import type { SavedConversation } from "../conversations";
import { TRUNCATED_NOTE } from "../limits";

function chat(text:string):SavedConversation{
  return {id:"conv-1",title:"Итог работы с PDF\n",createdAt:"2026-11-02",updatedAt:"2026-11-03",
    question:"",drafts:[],rows:[
      {id:"user",role:"user",text:"Вопрос"},
      {id:"complete",role:"assistant",text},
      {id:"info",role:"info",text:"Сохранено"},
    ]};
}
const location={conversationId:"conv-1",rowId:"complete"};
test("H-SAVE1a: full Markdown, lists, URLs and trailing lines are preserved byte-for-byte",()=>{
  const answer="# Анализ\n\n- **Первое**\n- Второе\n\n[Источник](https://example.org/source)\n";
  const source=chat(answer);
  const result=prepareAssistantReplyNote([source],location);
  expect(result.body).toBe(answer);
  expect(result.title).toBe("Ответ ИИ · Итог работы с PDF");
  expect(result.provenance).toEqual({kind:"assistant_reply",conversationId:"conv-1",rowId:"complete"});
  expect(source.rows[1].text).toBe(answer); // no mutation of source
});
test("H-SAVE1a: do not treat an unfinished stream, info or user text as a finished reply",()=>{
  const source=chat("Сохранённый полный ответ");
  for(const rowId of ["missing","user","info","reply:user:0"]){
    expect(()=>prepareAssistantReplyNote([source],{conversationId:"conv-1",rowId})).toThrow("Завершённый ответ");
  }
  expect(()=>prepareAssistantReplyNote([] , location)).toThrow("Завершённый ответ");
});
test("H-SAVE1a: incomplete model responses and over-60k source must not be silently saved as complete",()=>{
  expect(()=>prepareAssistantReplyNote([chat("Начало"+TRUNCATED_NOTE)],location)).toThrow("обрезан");
  expect(()=>prepareAssistantReplyNote([chat("А".repeat(60_001))],location)).toThrow("60 000");
  expect(prepareAssistantReplyNote([chat("A".repeat(60_000))],location).body).toHaveLength(60_000);
});
test("H-SAVE1a: no network, storage write, attachments or synthetic evidence in prepared body",()=>{
  const source=chat("Только ответ модели");
  source.rows[0].attachments=[{id:"p",name:"medical.png",mime:"image/png",kind:"image",data:"private",size:7}];
  const note=prepareAssistantReplyNote([source],location);
  expect(note.body).toBe("Только ответ модели");
  expect(JSON.stringify(note)).not.toContain("medical.png");
  expect(JSON.stringify(note)).not.toContain("private");
});
test("H-SAVE1a: revalidation after conversation deletion prevents late save",()=>{
  const rows=[chat("А")];
  prepareAssistantReplyNote(rows,location);
  rows.splice(0,1);
  expect(()=>prepareAssistantReplyNote(rows,location)).toThrow("не найден");
});
test("H-SAVE1a: malformed locator cannot create an unrelated note",()=>{
  for(const id of ["", "a".repeat(129)]){
    expect(()=>prepareAssistantReplyNote([chat("Ответ")],{conversationId:id,rowId:"complete"})).toThrow("Некорректная");
    expect(()=>prepareAssistantReplyNote([chat("Ответ")],{conversationId:"conv-1",rowId:id})).toThrow("Некорректная");
  }
});
