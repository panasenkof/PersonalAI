import { historyWithoutLargeDocuments, planDocumentSynthesis, runDocumentSynthesis } from "../document-synthesis";
import { chatContent, type ChatAttachment } from "../chat-attachments";
import { defaultDirectPreferences } from "../settings";
import type { DirectAgentOptions } from "../engine";

const text=(id:string,data:string):ChatAttachment=>({id,name:id+".txt",kind:"text",mime:"text/plain",data,size:data.length*3});
const settings={...defaultDirectPreferences,apiKey:"test-token",webSearchKey:""};
function options(files:ChatAttachment[],calls=5,signal?:AbortSignal):DirectAgentOptions {
  return {settings,prompt:"Сделай вывод по обоим файлам",history:[],attachments:files,signal,
    lookup:async()=>[],propose:()=>undefined,maxRequests:calls};
}
test("H-DOC1b2: a small 24k source still uses the existing single-shot route",()=>{
  expect(planDocumentSynthesis([text("small","а".repeat(24_000))],settings.model)).toBeNull();
  const files=[text("a","а".repeat(20_000)),text("b","б".repeat(20_000))];
  const plan=planDocumentSynthesis(files,settings.model)!;
  expect(plan.files).toBe(2);
  expect(plan.textChars).toBe(40_000);
  expect(plan.parts.map(p=>p.file)).toEqual(["a.txt","a.txt","b.txt","b.txt"]);
  expect(plan.calls).toBe(5);
  expect(plan.parts.filter(p=>p.file==="a.txt").map(p=>p.text).join("")).toBe(files[0].data);
  expect(plan.parts.filter(p=>p.file==="b.txt").map(p=>p.text).join("")).toBe(files[1].data);
  expect(()=>chatContent("Сравни",files,"chat")).toThrow("big_document_requires_explicit_synthesis");
});
test("H-DOC1b2: all parts are analyzed via same provider with explicit final synthesis",async()=>{
  const files=[text("first","И".repeat(20_000)),text("second","Б".repeat(20_000))];
  const plan=planDocumentSynthesis(files,settings.model)!;
  const calls:DirectAgentOptions[]=[];
  const runner=jest.fn(async(args:DirectAgentOptions)=>{
    calls.push(args);
    return {text:args.prompt.includes("ПРОВЕРЕННЫЕ МЕТКИ")?"Отдельные выводы и общий итог":"Краткий пересказ части",sources:[],requests:1};
  });
  const statuses:string[]=[];
  const answer=await runDocumentSynthesis({...options(files),status:s=>statuses.push(s)},plan,runner);
  expect(runner).toHaveBeenCalledTimes(5);
  expect(answer.requests).toBe(5);
  expect(answer.text).toContain("общий итог");
  expect(answer.notice).toContain("4 частей 2 файлов");
  expect(statuses).toHaveLength(5);
  expect(calls.every(c=>c.settings.model===settings.model&&c.settings.allowWeb===false)).toBe(true);
  expect(calls.every(c=>c.attachments?.length===0 && c.skipLocalMemory===true && c.maxRequests===1)).toBe(true);
  expect(calls[4].prompt).toContain("first.txt");
  expect(calls[4].prompt).toContain("second.txt");
  expect(calls[4].prompt).toContain("Сделай вывод по обоим файлам");
});
test("H-DOC1b2: insufficient call budget forbids any paid request or partial result",async()=>{
  const files=[text("a","а".repeat(20_000)),text("b","б".repeat(20_000))];
  const plan=planDocumentSynthesis(files,settings.model)!;
  const runner=jest.fn();
  await expect(runDocumentSynthesis(options(files,4),plan,runner)).rejects.toThrow("5 обращений");
  expect(runner).not.toHaveBeenCalled();
});
test("H-DOC1b2: a changed source after consent is rejected before any request",async()=>{
  const files=[text("first","A".repeat(26_000))];
  const plan=planDocumentSynthesis(files,settings.model)!;
  const runner=jest.fn();
  await expect(runDocumentSynthesis(options([text("first","B".repeat(26_001))]),plan,runner))
    .rejects.toThrow("изменились");
  expect(runner).not.toHaveBeenCalled();
});
test("H-DOC1b2: cancellation prevents later parts and prohibits a fabricated final answer",async()=>{
  const controller=new AbortController();
  const files=[text("long","Z".repeat(28_000))];
  const plan=planDocumentSynthesis(files,settings.model)!;
  const runner=jest.fn(async()=>{controller.abort();return {text:"Результат одной части",sources:[],requests:1};});
  await expect(runDocumentSynthesis(options(files,4,controller.signal),plan,runner))
    .rejects.toThrow("остановлена");
  expect(runner).toHaveBeenCalledTimes(1);
});
test("H-DOC1b2: encrypted history keeps originals, but does not silently resend long text",()=>{
  const sources=[text("alpha","А".repeat(20_000)),text("beta","Б".repeat(20_000))];
  const row={content:"Сравни файлы",attachments:sources};
  const [safe]=historyWithoutLargeDocuments([row]);
  expect(safe.attachments).toEqual([]);
  expect(safe.content).toContain("не передаются повторно");
  expect(safe.content).toContain("alpha.txt");
  expect(row.attachments).toHaveLength(2);
});

test("H-DOC1b2: truncated intermediate response must never be promoted to full final synthesis",async()=>{
  const files=[text("one","A".repeat(25_000))];
  const plan=planDocumentSynthesis(files,settings.model)!;
  const runner=jest.fn(async()=>({text:"Частичный текст\n\n(Ответ обрезан по лимиту длины. Попросите продолжить, если нужно.)",sources:[],requests:1}));
  await expect(runDocumentSynthesis(options(files,5),plan,runner)).rejects.toThrow("оборвала");
  expect(runner).toHaveBeenCalledTimes(1);
});

test("large multi-part synthesis keeps question focus and budgets every final metadata wrapper",async()=>{
  const files=[text("manual","А".repeat(216_000))];
  const plan=planDocumentSynthesis(files,settings.model)!;
  expect(plan.parts.length).toBe(18);
  expect(plan.calls).toBe(19);
  const prompts:string[]=[];
  const runner=jest.fn(async(args:DirectAgentOptions)=>{
    prompts.push(args.prompt);
    return {text:args.prompt.includes("ПРОВЕРЕННЫЕ МЕТКИ")
      ? "Итог по всем 18 частям" : "Найден релевантный проверяемый факт.",
      sources:[],requests:1};
  });
  const answer=await runDocumentSynthesis({
    ...options(files,20),prompt:"Какие конкретно ограничения и исключения описаны?",
  },plan,runner);
  expect(answer.requests).toBe(19);
  expect(runner).toHaveBeenCalledTimes(19);
  expect(prompts[0]).toContain("Вопрос пользователя");
  expect(prompts[0]).toContain("Какие конкретно ограничения");
  expect(prompts[18].length).toBeLessThanOrEqual(24_000);
  expect(prompts[18]).toContain("part");
  expect(answer.text).toContain("всем 18 частям");
});

test("final-size preflight rejects impossible question before any paid document calls",async()=>{
  const files=[text("manual","Б".repeat(36_000))];
  const plan=planDocumentSynthesis(files,settings.model)!;
  const runner=jest.fn();
  await expect(runDocumentSynthesis({
    ...options(files,20),prompt:"В".repeat(23_000),
  },plan,runner)).rejects.toThrow("Недостаточно места");
  expect(runner).not.toHaveBeenCalled();
});
