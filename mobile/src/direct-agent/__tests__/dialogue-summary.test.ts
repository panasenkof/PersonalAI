import { planDialogueSummary, runDialogueSummary } from "../dialogue-summary";
import { prepareAssistantReplyNote } from "../chat-response-note";
import { parseConversation, type SavedConversation } from "../conversations";
import { defaultDirectPreferences } from "../settings";
import type { DirectAgentOptions } from "../engine";
import { TRUNCATED_NOTE } from "../limits";

const settings={...defaultDirectPreferences,apiKey:"test",webSearchKey:"",allowWeb:true};
function conversation(rows:SavedConversation["rows"]):SavedConversation {
  return {id:"conversation",title:"Диалог об обработке PDF",createdAt:"2026-11-02",
    updatedAt:"2026-11-03",rows,drafts:[],question:""};
}
const rows=()=>[
  {id:"u1",role:"user" as const,text:"Сравни PDF и TXT",attachments:[
    {id:"file1",name:"secret.pdf",mime:"application/pdf",kind:"text" as const,
      data:"SECRET_ORIGINAL",size:16}]},
  {id:"a1",role:"assistant" as const,text:"PDF — инструкция; TXT — план"},
  {id:"u2",role:"user" as const,text:"Что решить дальше?"},
  {id:"a2",role:"assistant" as const,text:"Проверить сборку."},
];
function options(maxRequests=5,signal?:AbortSignal):DirectAgentOptions{
  return {settings,prompt:"Итог беседы",history:[],maxRequests,signal,lookup:async()=>[],
    propose:()=>undefined};
}
test("H-SAVE1b: planning selects an exact range and never copies attachment bytes",()=>{
  const c=conversation(rows());
  const p=planDialogueSummary(c,"all",settings.model,settings.provider);
  expect(p).toMatchObject({includedRows:4,totalRows:4,omittedAttachments:1,calls:1,
    firstRowId:"u1",lastRowId:"a2"});
  expect(p.source).toContain("Сравни PDF и TXT");
  expect(p.source).not.toContain("SECRET_ORIGINAL");
  expect(p.source).not.toContain("secret.pdf");
  const recent=planDialogueSummary(conversation([...rows(),...Array.from({length:10},(_,i)=>({
    id:"extra"+i,role:"user" as const,text:"сообщение "+i}))]),"last10",settings.model,settings.provider);
  expect(recent).toMatchObject({includedRows:10,totalRows:14,firstRowId:"extra0"});
  expect(recent.source).not.toContain("Сравни PDF");
});
test("H-SAVE1b: changed dialogue or provider invalidates consent",()=>{
  const c=conversation(rows());
  const previous=planDialogueSummary(c,"all",settings.model,settings.provider);
  c.rows[1].text="Ответ изменён";
  expect(planDialogueSummary(c,"all",settings.model,settings.provider).approvalKey).not.toBe(previous.approvalKey);
  expect(planDialogueSummary(c,"all",settings.model,"different-provider").approvalKey).not.toBe(previous.approvalKey);
});
test("H-SAVE1b: small dialogue uses a single isolated LLM call, returns editable full coverage",async()=>{
  const plan=planDialogueSummary(conversation(rows()),"all",settings.model,settings.provider);
  const runner=jest.fn(async(_o:DirectAgentOptions)=>({text:"**Решение:** проверить сборку.",sources:[],requests:1}));
  const result=await runDialogueSummary(options(),plan,runner);
  expect(runner).toHaveBeenCalledTimes(1);
  expect(runner.mock.calls[0][0]).toMatchObject({skipLocalMemory:true,maxRequests:1,
    history:[],attachments:[],sections:[]});
  expect(runner.mock.calls[0][0].settings.allowWeb).toBe(false);
  expect(result.body).toContain("4 текстовых сообщений из 4");
  expect(result.body).toContain("Оригиналы 1 вложений не читались");
  expect(result.body).toContain("**Решение:** проверить сборку.");
  expect(result.requests).toBe(1);
});
test("H-SAVE1b: long dialogue covers every source chunk and makes one final synthesis",async()=>{
  const c=conversation([{id:"u",role:"user",text:"А".repeat(28_000)}]);
  const plan=planDialogueSummary(c,"all",settings.model,settings.provider);
  expect(plan.calls).toBe(plan.parts.length+1);
  expect(plan.parts.map(p=>p.text).join("")).toBe(plan.source);
  const prompts:string[]=[];
  const runner=jest.fn(async(o:DirectAgentOptions)=>{
    prompts.push(o.prompt); return {text:o.prompt.includes("ВТОРИЧНЫЙ итог")?"# Общий итог":"Краткий вывод",sources:[],requests:1};
  });
  const result=await runDialogueSummary(options(10),plan,runner);
  expect(runner).toHaveBeenCalledTimes(plan.calls);
  expect(prompts.at(-1)).toContain("Часть 3/");
  expect(result.body).toContain("Итог основан на промежуточных выводах");
});
test("H-SAVE1b: a call limit fails before any LLM request",async()=>{
  const plan=planDialogueSummary(conversation([{id:"u",role:"user",text:"Б".repeat(28_000)}]),
    "all",settings.model,settings.provider);
  const runner=jest.fn();
  await expect(runDialogueSummary(options(2),plan,runner)).rejects.toThrow("Ничего не отправлено");
  expect(runner).not.toHaveBeenCalled();
});
test("H-SAVE1b: truncated intermediate reply and cancellation never produce a note",async()=>{
  const plan=planDialogueSummary(conversation([{id:"u",role:"user",text:"А".repeat(28_000)}]),
    "all",settings.model,settings.provider);
  const truncated=jest.fn(async()=>({text:"Начало"+TRUNCATED_NOTE,sources:[],requests:1}));
  await expect(runDialogueSummary(options(8),plan,truncated)).rejects.toThrow("обрезанный");
  expect(truncated).toHaveBeenCalledTimes(1);
  const abort=new AbortController();
  const stops=jest.fn(async()=>{abort.abort();return {text:"часть",sources:[],requests:1};});
  await expect(runDialogueSummary(options(8,abort.signal),plan,stops)).rejects.toThrow("остановлено");
  expect(stops).toHaveBeenCalledTimes(1);
});
test("H-SAVE1b: oversized source is refused instead of silently clipping",()=>{
  const c=conversation([{id:"u",role:"user",text:"X".repeat(240_000)}]);
  expect(()=>planDialogueSummary(c,"all",settings.model,settings.provider)).toThrow("240 000");
});
test("H-SAVE1b: summary provenance round-trips through the existing encrypted chat parser and editor",()=>{
  const origin={scope:"all" as const,includedRows:4,totalRows:4,omittedAttachments:1,
    sourceChars:123,parts:1,firstRowId:"u1",lastRowId:"a2",model:"gpt-4.1",
    provider:"openai",createdAt:"2026-11-03T08:00:00.000Z"};
  const c=conversation([...rows(),{id:"summary",role:"assistant",text:"# Итог\n\nПолный текст",
    dialogueSummary:origin}]);
  const restored=parseConversation(JSON.stringify(c));
  expect(restored?.rows.at(-1)?.dialogueSummary).toEqual(origin);
  const prepared=prepareAssistantReplyNote([restored!],{conversationId:c.id,rowId:"summary"});
  expect(prepared.title).toBe("Итог диалога · Диалог об обработке PDF");
  expect(prepared.provenance).toMatchObject({kind:"dialogue_summary",scope:"all",includedRows:4});
  expect(prepared.body).toBe("# Итог\n\nПолный текст");
  const planned=planDialogueSummary(restored!,"all",settings.model,settings.provider);
  expect(planned.includedRows).toBe(4); // earlier generated summaries do not contaminate selection
});
