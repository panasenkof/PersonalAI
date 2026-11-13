import { prepareTurnHistory } from "../agent-host";
import { interruptedAssistantPatch } from "../agent-result";
import { parseConversation, type SavedConversation } from "../conversations";
import type { LiveConversation } from "../chat-store";
import { defaultDirectPreferences } from "../settings";

const settings={...defaultDirectPreferences,apiKey:"",webSearchKey:""};
const secret = "Личные данные из закрытого раздела «Входящие»";
const date = "2026-11-13T12:00:00.000Z";
const base = (): LiveConversation => ({
  id:"inbox-chat",title:"Разбор",createdAt:date,updatedAt:date,
  question:"",drafts:[],busy:false,progress:"",
  rows:[
    {id:"u1",role:"user",text:"Разбери входящие"},
    {id:"a1",role:"assistant",text:secret,inboxTriageResult:true},
    {id:"u2",role:"user",text:"Следующий вопрос"},
    {id:"a2",role:"assistant",text:"Обычный публичный ответ"},
  ],
});

test("S9-1b: previous private reply stays visible locally but is redacted from normal LLM history",()=>{
  const convo=base();
  const history=prepareTurnHistory(convo,settings,"Новый вопрос",false);
  expect(convo.rows[1].text).toBe(secret);
  expect(JSON.stringify(history.history)).not.toContain(secret);
  expect(JSON.stringify(history.history)).toContain("Приватный разбор");
  expect(JSON.stringify(history.history)).toContain("Обычный публичный ответ");
  const restored=parseConversation(JSON.stringify(convo as SavedConversation));
  expect(restored?.rows[1].inboxTriageResult).toBe(true);
  const again=prepareTurnHistory({...convo,rows:restored!.rows},settings,"Новый вопрос",false);
  expect(JSON.stringify(again.history)).not.toContain(secret);
});

test("S9-1b: cancelled partial Inbox answer is marked private too",()=>{
  const patch=interruptedAssistantPatch({
    conversation:base(),taskState:{} as any,
    internetPhotoId:false,intentPreserveDraft:true,inboxTriageResult:true,
    modelStarted:true,beforeModelError:"Ошибка",prompt:"Разбери",draftFiles:[],
    signalAborted:true,latest:secret,error:new Error("aborted"),
    newId:(()=>{let i=0;return ()=>"row-"+(++i);})(),
  });
  const partial=patch.rows?.find(r=>r.role==="assistant"&&r.text===secret);
  expect(partial?.inboxTriageResult).toBe(true);
  const history=prepareTurnHistory({...base(),rows:patch.rows!},settings,"Позже",false);
  expect(JSON.stringify(history.history)).not.toContain(secret);
});
