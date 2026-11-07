import { DirectChatStore } from "../chat-store";
import type { ConversationRepository, SavedConversation } from "../conversations";
import { defaultDirectPreferences } from "../settings";
import { saveApprovedNote } from "../memory";
import { waitForApplicationSession } from "../../local-memory/storage";
import { loadModelCallLimit } from "../agent-preferences";
import { planDocumentSynthesis } from "../document-synthesis";
import { planDialogueSummary } from "../dialogue-summary";

jest.mock("../../local-memory/storage", () => ({ waitForApplicationSession: jest.fn(async () => {}), withLocalMemoryDatabase: jest.fn(), onLocalMemorySessionChange: jest.fn(() => () => {}) }));
jest.mock("../memory", () => ({ searchApprovedNotes: jest.fn(async () => []), saveApprovedNote: jest.fn(async () => "note") }));
jest.mock("expo-crypto", () => ({ randomUUID: () => "id-" + Math.random().toString(36).slice(2) }));
jest.mock("../agent-preferences", () => ({ loadModelCallLimit: jest.fn(async () => 4) }));
const settings = { ...defaultDirectPreferences, apiKey: "secret-key", webSearchKey: "search-secret" };
function repository() {
  const records = new Map<string, SavedConversation>();
  const repo: ConversationRepository = {
    load: jest.fn(async () => [...records.values()].map(c => JSON.parse(JSON.stringify(c)))),
    save: jest.fn(async c => { records.set(c.id, JSON.parse(JSON.stringify(c))); }),
    remove: jest.fn(async id => { records.delete(id); }),
  };
  return { records, repo };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}
const turn = () => deferred<{ text: string; sources: string[]; requests: number }>();
const started = async (runner: jest.Mock) => { for (let i = 0; i < 20 && !runner.mock.calls.length; i++) await Promise.resolve(); expect(runner).toHaveBeenCalledTimes(1); };
beforeEach(() => { jest.clearAllMocks(); (waitForApplicationSession as jest.Mock).mockResolvedValue(undefined); (loadModelCallLimit as jest.Mock).mockResolvedValue(4); });

test("the saved call limit is captured per message and re-read for the next one", async () => {
  const { repo } = repository(); const answer = turn();
  const runner = jest.fn().mockReturnValueOnce(answer.promise).mockResolvedValue({ text: "Ответ", sources: [], requests: 1 });
  const store = new DirectChatStore("guest", repo, runner); await store.initialize();
  (loadModelCallLimit as jest.Mock).mockResolvedValue(2);
  store.setQuestion("Первый"); const first = store.send(settings); await started(runner);
  expect(runner.mock.calls[0][0].maxRequests).toBe(2);
  (loadModelCallLimit as jest.Mock).mockResolvedValue(7);
  expect(runner.mock.calls[0][0].maxRequests).toBe(2);
  answer.resolve({ text: "Ответ", sources: [], requests: 1 }); await first;
  store.setQuestion("Второй"); await store.send(settings);
  expect(runner.mock.calls[1][0].maxRequests).toBe(7); store.dispose();
});
test("an unreadable limit preserves the draft and spends no model call", async () => {
  const { repo } = repository(); const runner = jest.fn();
  const store = new DirectChatStore("guest", repo, runner); await store.initialize();
  (loadModelCallLimit as jest.Mock).mockRejectedValueOnce(new Error("corrupt_limit"));
  store.setQuestion("Вопрос"); await store.send(settings);
  expect(runner).not.toHaveBeenCalled();
  expect(store.getSnapshot().conversations[0].question).toBe("Вопрос");
  expect(store.getSnapshot().conversations[0].rows.at(-1)?.text).toContain("прочитать лимит"); store.dispose();
});

test("retrying a failed history load clears its error and enables a new conversation and message input", async () => {
  const { repo } = repository();
  (repo.load as jest.Mock).mockRejectedValueOnce(new Error("temporary_storage_failure"));
  const store = new DirectChatStore("guest", repo, jest.fn());
  await store.initialize(); expect(store.getSnapshot().ready).toBe(false);
  expect(store.getSnapshot().error).toContain("открыть историю");
  await store.initialize(); expect(store.getSnapshot()).toMatchObject({ ready: true, error: "" });
  store.create(); store.setQuestion("Рабочий ввод");
  expect(store.getSnapshot().conversations).toHaveLength(2);
  expect(store.getSnapshot().conversations[0].question).toBe("Рабочий ввод");
  await store.checkpoint(); store.dispose();
});

test("a detached screen and another conversation never abort work; full history survives a fresh store", async () => {
  const { records, repo } = repository(); const answer = turn();
  const runner = jest.fn((_options: any) => answer.promise); const store = new DirectChatStore("guest", repo, runner);
  await store.initialize(); const firstId = store.getSnapshot().activeId!;
  const unmountScreen = store.subscribe(jest.fn());
  store.setQuestion("Что приготовить?"); const sending = store.send(settings); await started(runner);
  expect(records.get(firstId)?.rows[0].text).toBe("Что приготовить?");
  runner.mock.calls[0][0].propose({ title: "Рецепт", body: "Паста" });
  unmountScreen(); store.create();
  expect(runner.mock.calls[0][0].signal.aborted).toBe(false);
  answer.resolve({ text: "Приготовьте пасту", sources: ["https://example.org/recipe"], requests: 1 }); await sending;
  expect(records.get(firstId)?.rows.at(-1)).toMatchObject({ role: "assistant", text: "Приготовьте пасту", sources: ["https://example.org/recipe"] });
  store.dispose(); const reopened = new DirectChatStore("guest", repo, runner); await reopened.initialize(); reopened.select(firstId);
  expect(reopened.getSnapshot().conversations.find(c => c.id === firstId)?.drafts).toHaveLength(1);
  expect(JSON.stringify([...records.values()])).not.toMatch(/secret-key|search-secret/);
  const note = reopened.getSnapshot().conversations.find(c => c.id === firstId)!.drafts[0];
  await reopened.approve(note); expect(saveApprovedNote).toHaveBeenCalledWith("guest", note);
  await reopened.checkpoint(); expect(records.get(firstId)?.drafts).toEqual([]); reopened.dispose();
});
test("explicit Stop aborts the transport and stores an interrupted turn without erasing messages", async () => {
  const { repo, records } = repository();
  const runner = jest.fn(options => new Promise<never>((_resolve, reject) => options.signal.addEventListener("abort", () => reject(new Error("aborted")))));
  const store = new DirectChatStore("guest", repo, runner); await store.initialize();
  store.setQuestion("Вопрос"); const sending = store.send(settings); await started(runner); store.stop(); await sending;
  const current = store.getSnapshot().conversations[0];
  expect(current.busy).toBe(false); expect(current.rows.map(r => r.text)).toEqual(["Вопрос", "Запрос остановлен"]);
  expect(records.get(current.id)?.interrupted).toBe(false); store.dispose();
});
test("Stop keeps the answer fragment that already arrived", async () => {
  const { repo } = repository();
  const runner = jest.fn(options => new Promise<never>((_resolve, reject) => {
    options.onText("Первые две мысли.");
    options.signal.addEventListener("abort", () => reject(new Error("aborted")));
  }));
  const store = new DirectChatStore("guest", repo, runner); await store.initialize();
  store.setQuestion("Вопрос"); const sending = store.send(settings); await started(runner); store.stop(); await sending;
  const current = store.getSnapshot().conversations[0];
  expect(current.rows.map(r => r.text)).toEqual(["Вопрос", "Первые две мысли.", "Ответ остановлен"]);
  expect(current.rows[1].role).toBe("assistant");
  store.dispose();
});
test("a failed answer is marked so the chat can offer a retry", async () => {
  const { repo } = repository();
  const runner = jest.fn((_options: any) => Promise.reject(new Error("Нет связи с сервером")));
  const store = new DirectChatStore("guest", repo, runner); await store.initialize();
  store.setQuestion("Вопрос"); await store.send(settings);
  const rows = store.getSnapshot().conversations[0].rows;
  expect(rows.at(-1)).toMatchObject({ role: "info", error: true });
  store.dispose();
});
test("retry re-runs the same question without duplicating the user bubble", async () => {
  const { repo } = repository();
  const runner: jest.Mock = jest.fn((_options: any) => Promise.reject(new Error("Нет связи с сервером")));
  const store = new DirectChatStore("guest", repo, runner); await store.initialize();
  store.setQuestion("Вопрос"); await store.send(settings);
  runner.mockImplementationOnce(() => Promise.resolve({ text: "Ответ после повтора", sources: [], requests: 1 }));
  await store.retry(settings);
  const current = store.getSnapshot().conversations[0];
  expect(current.rows.filter(r => r.role === "user")).toHaveLength(1);
  expect(current.rows.at(-1)).toMatchObject({ role: "assistant", text: "Ответ после повтора" });
  store.dispose();
});
test("a completed answer remains in memory through expired auth and is saved on unlock", async () => {
  const { repo, records } = repository(); const answer = turn(); const unlocked = deferred<void>();
  const runner = jest.fn((_options: any) => answer.promise); const store = new DirectChatStore("guest", repo, runner); await store.initialize();
  store.setQuestion("Вопрос"); const sending = store.send(settings); await started(runner);
  (waitForApplicationSession as jest.Mock).mockImplementation(() => unlocked.promise);
  answer.resolve({ text: "Ответ", sources: [], requests: 1 });
  for (let i = 0; i < 10; i++) await Promise.resolve();
  expect(store.getSnapshot().conversations[0].rows.at(-1)?.text).toBe("Ответ");
  expect(records.get(store.getSnapshot().activeId!)?.rows.at(-1)?.text).toBe("Вопрос");
  unlocked.resolve(); await sending; expect(records.get(store.getSnapshot().activeId!)?.rows.at(-1)?.text).toBe("Ответ"); store.dispose();
});
test("failure saving a submitted question spends no model request; history can be retried", async () => {
  const { repo, records } = repository(); const runner = jest.fn(); const store = new DirectChatStore("guest", repo, runner); await store.initialize(); await store.checkpoint();
  (repo.save as jest.Mock).mockRejectedValueOnce(new Error("disk_full")); store.setQuestion("Вопрос"); await store.send(settings);
  expect(runner).not.toHaveBeenCalled(); expect(store.getSnapshot().error).toContain("сохранить историю");
  expect(store.getSnapshot().conversations[0].question).toBe("Вопрос");
  expect(JSON.stringify(store.getSnapshot())).not.toContain("disk_full");
  await store.checkpoint(); expect(records.get(store.getSnapshot().activeId!)?.rows[0].text).toBe("Вопрос"); expect(store.getSnapshot().error).toBe(""); store.dispose();
});
test("cold start keeps the question and offers retry without silently re-spending an interrupted request", async () => {
  const { repo, records } = repository(); records.set("old", { id: "old", title: "Вопрос", createdAt: "2026-10-13", updatedAt: "2026-10-13", rows: [{ id: "u", role: "user", text: "Вопрос" }], drafts: [], question: "", interrupted: true });
  const runner = jest.fn(); const store = new DirectChatStore("guest", repo, runner); await store.initialize();
  expect(store.getSnapshot().conversations[0].rows.at(-1)?.text).toContain("закрылось"); expect(runner).not.toHaveBeenCalled();
  expect(records.get("old")?.interrupted).toBe(false); store.dispose();
});
test("profile disposal aborts pending jobs, and repositories do not mix accounts", async () => {
  const a = repository(), b = repository(); const answer = turn(); const runner = jest.fn((_options: any) => answer.promise);
  const guest = new DirectChatStore("guest", a.repo, runner); await guest.initialize(); guest.setQuestion("Личная переписка"); const sending = guest.send(settings); await started(runner);
  guest.dispose(); expect(runner.mock.calls[0][0].signal.aborted).toBe(true);
  const account = new DirectChatStore("other", b.repo, runner); await account.initialize();
  expect(JSON.stringify(account.getSnapshot())).not.toContain("Личная переписка");
  answer.resolve({ text: "Поздний ответ", sources: [], requests: 1 }); await sending;
  expect(JSON.stringify([...b.records.values()])).not.toContain("Поздний ответ"); account.dispose();
});

test("a checkpoint across multiple chats cannot overwrite a reply completed while another chat saves", async () => {
  const { repo, records } = repository(); const firstAnswer = turn(), secondAnswer = turn();
  const runner = jest.fn().mockImplementationOnce(() => firstAnswer.promise).mockImplementationOnce(() => secondAnswer.promise);
  const store = new DirectChatStore("guest", repo, runner); await store.initialize();
  const first = store.getSnapshot().activeId!; store.setQuestion("Первый"); const sendingFirst = store.send(settings); await started(runner);
  store.create(); store.setQuestion("Второй"); const sendingSecond = store.send(settings);
  for (let i = 0; i < 20 && runner.mock.calls.length < 2; i++) await Promise.resolve();
  expect(runner).toHaveBeenCalledTimes(2);
  const gate = deferred<void>();
  (repo.save as jest.Mock).mockImplementationOnce(async c => { await gate.promise; records.set(c.id, JSON.parse(JSON.stringify(c))); });
  const saving = store.checkpoint();
  firstAnswer.resolve({ text: "Первый ответ", sources: [], requests: 1 });
  for (let i = 0; i < 10; i++) await Promise.resolve();
  gate.resolve(); await saving; await sendingFirst;
  secondAnswer.resolve({ text: "Второй ответ", sources: [], requests: 1 }); await sendingSecond;
  expect(records.get(first)?.rows.at(-1)?.text).toBe("Первый ответ"); expect(records.get(first)?.interrupted).toBe(false); store.dispose();
});

test("an overlong pasted note is rejected before sending and the unsent text stays editable", async () => {
  const { repo } = repository(); const runner = jest.fn(); const store = new DirectChatStore("guest", repo, runner);
  await store.initialize();
  const prompt = "Рецепт ".repeat(3500);
  store.setQuestion(prompt);
  await store.send(settings);
  expect(runner).not.toHaveBeenCalled();
  expect(store.getSnapshot().error).toContain("24 000");
  expect(store.getSnapshot().conversations[0].question).toBe(prompt);
  expect(store.getSnapshot().conversations[0].rows).toHaveLength(0);
  store.dispose();
});

test("confirmation during a model turn survives late state and stale approval", async () => {
  const { beginTask, recordEvidence } = require("../task-state");
  const { repo, records } = repository(); const answer = deferred<any>();
  let pending: any;
  const runner = jest.fn(async (opts: any) => {
    const id = opts.propose({ title: "Ужин", body: "Форель" });
    pending = recordEvidence(beginTask(undefined, "Ужин"), { tool: "draft_memory_fact", outcome: "pending_confirmation", subject: id, excerpt: "Форель" });
    opts.onTaskState(pending); return answer.promise;
  });
  const store = new DirectChatStore("guest", repo, runner); await store.initialize();
  store.setQuestion("Запомни ужин"); const sending = store.send(settings); await started(runner);
  const draft = store.getSnapshot().conversations[0].drafts[0];
  (saveApprovedNote as jest.Mock).mockRejectedValueOnce(new Error("disk"));
  await store.approve(draft);
  expect(store.getSnapshot().conversations[0].taskState?.evidence[0].outcome).toBe("pending_confirmation");
  await store.approve(draft); await store.approve(draft);
  expect(saveApprovedNote).toHaveBeenCalledTimes(2);
  answer.resolve({ text: "Готово", sources: [], requests: 1, taskState: pending, proposalIds: [draft.id] }); await sending;
  const conversation = store.getSnapshot().conversations[0];
  expect(conversation.taskState?.evidence[0].outcome).toBe("saved");
  expect(conversation.rows.some(r => r.text.includes("ещё не сохранена"))).toBe(false);
  expect(records.get(conversation.id)?.taskState?.evidence[0].outcome).toBe("saved"); store.dispose();
});

test("reopened chat restores selection and network denial beyond history window", async () => {
  const { beginTask } = require("../task-state"); const { repo, records } = repository();
  records.set("old", { id: "old", title: "Ужин", createdAt: "2026-10-18", updatedAt: "2026-10-18", question: "", drafts: [],
    rows: Array.from({ length: 20 }, (_, i) => ({ id: String(i), role: i % 2 ? "assistant" as const : "user" as const, text: "Обсуждение" })),
    taskState: { ...beginTask(undefined, "Ужин"), selection: "Форель", webPreference: "deny" } });
  const runner = jest.fn(async () => ({ text: "Ответ", sources: [], requests: 1 }));
  const store = new DirectChatStore("guest", repo, runner); await store.initialize();
  expect(store.getSnapshot().conversations[0].taskState?.turnStatus).toBe("interrupted");
  store.setQuestion("На двоих"); await store.send(settings);
  expect((runner.mock.calls as any)[0][0].taskState).toMatchObject({ selection: "Форель", webPreference: "deny" }); store.dispose();
});

test('attachment drafts survive a new store; picking does not call model or save a note; Send carries bytes', async () => {
  const {repo, records}=repository(); const runner=jest.fn().mockResolvedValue({text:'Файл прочитан',sources:[],requests:1});
  const store=new DirectChatStore('guest',repo,runner);await store.initialize(); const id=store.getSnapshot().activeId!;
  const file={id:'file',name:'note.txt',kind:'text' as const,mime:'text/plain',data:'Содержимое файла',size:30};
  store.setAttachments(id,[file]);await store.checkpoint();expect(runner).not.toHaveBeenCalled();expect(saveApprovedNote).not.toHaveBeenCalled();
  const reopened=new DirectChatStore('guest',repo,runner);await reopened.initialize();
  expect(reopened.getSnapshot().conversations[0].attachments?.[0].data).toBe(file.data);
  await reopened.send(settings);expect(runner.mock.calls[0][0].attachments[0].data).toBe(file.data);
  expect(records.get(id)?.rows[0].attachments?.[0].data).toBe(file.data);expect(records.get(id)?.attachments).toEqual([]);
  reopened.setQuestion('Расскажи подробнее');await reopened.send(settings);
  expect(runner.mock.calls[1][0].history[0].attachments[0].data).toBe(file.data);
  store.dispose();reopened.dispose();
});
test('failure before transport restores files and question; removal affects only the draft',async()=>{
  const {repo}=repository();const runner=jest.fn();const store=new DirectChatStore('guest',repo,runner);await store.initialize();const id=store.getSnapshot().activeId!;
  store.setQuestion('Вопрос');store.setAttachments(id,[{id:'f',name:'x.txt',kind:'text',mime:'text/plain',data:'Text',size:4}]);
  (loadModelCallLimit as jest.Mock).mockRejectedValueOnce(new Error('bad limit'));
  await store.send(settings);expect(runner).not.toHaveBeenCalled();expect(store.getSnapshot().conversations[0].attachments).toHaveLength(1);
  store.setAttachments(id,[]);expect(store.getSnapshot().conversations[0].attachments).toEqual([]);expect(store.getSnapshot().conversations[0].rows[0].attachments).toHaveLength(1);store.dispose();
});

test('external Share appends atomically to the current draft without model invocation or note save',async()=>{
  const {repo,records}=repository(),runner=jest.fn();const store=new DirectChatStore('guest',repo,runner);await store.initialize();const id=store.getSnapshot().activeId!;
  const file={id:'share',name:'x.txt',kind:'text' as const,mime:'text/plain',data:'File',size:12};store.setQuestion('Мой черновик');
  store.sharedDraft(id,'https://example.org',[file]);expect(store.getSnapshot().conversations[0].question).toBe('Мой черновик');
  store.appendSharedDraft(id,'https://example.org',[file]);await store.checkpoint();expect(records.get(id)?.question).toBe('Мой черновик\n\nhttps://example.org');expect(records.get(id)?.attachments).toHaveLength(1);expect(runner).not.toHaveBeenCalled();expect(saveApprovedNote).not.toHaveBeenCalled();
  const before=JSON.stringify(store.getSnapshot());expect(()=>store.appendSharedDraft(id,'x'.repeat(24000),[])).toThrow('24 000');expect(()=>store.appendSharedDraft(id,'new',Array(3).fill(file))).toThrow('3 файлов');expect(JSON.stringify(store.getSnapshot())).toBe(before);
  store.create();expect(()=>store.appendSharedDraft(id,'late',[])).toThrow('недоступен');store.dispose();
});

test("internet photo action sends only selected photo, requests web and preserves the unsent draft",async()=>{
  const {repo,records}=repository();const runner=jest.fn().mockResolvedValue({text:"Информация найдена",sources:["https://example.org/source"],requests:1});
  const store=new DirectChatStore("guest",repo,runner);await store.initialize();
  const id=store.getSnapshot().activeId!;
  const data=Buffer.from([255,216,255,224,1,2,3,4]).toString("base64");
  const image={id:"photo",name:"Снимок.jpg",kind:"image" as const,mime:"image/jpeg",data,size:8};
  const text={id:"note",name:"note.txt",kind:"text" as const,mime:"text/plain",data:"Черновик",size:8};
  store.setAttachments(id,[image,text]);store.setQuestion("Неотправленный вопрос");
  await store.send({...settings,allowWeb:true},"photo");
  expect(runner).toHaveBeenCalledTimes(1);
  const call=runner.mock.calls[0][0];
  expect(call.prompt).toContain("Найди в интернете");
  expect(call.prompt).toContain("проверяемые факты");
  expect(call.attachments).toHaveLength(1);
  expect(call.attachments[0].id).toBe("photo");
  expect(call.history).toEqual([]);
  expect(call.pendingNotes).toEqual([]);
  expect(call.skipLocalMemory).toBe(true);
  expect(call.taskState.webPreference).toBe("allow");
  const result=store.getSnapshot().conversations[0];
  expect(result.question).toBe("Неотправленный вопрос");
  // The selected photo is consumed; unrelated draft files are preserved.
  expect(result.attachments).toHaveLength(1);
  expect(result.attachments?.[0].id).toBe("note");
  expect(result.rows[0].attachments).toHaveLength(1);
  expect(result.rows[0].text).toBe("Что изображено на фото? Найти информацию в интернете");
  expect(result.title).not.toContain("Найди в интернете сведения");
  expect(records.get(id)?.rows.at(-1)?.sources).toEqual(["https://example.org/source"]);
  store.dispose();
});

test("internet photo action needs the exact selected image and enabled web, never silently sends",async()=>{
  const {repo}=repository(),runner=jest.fn();
  const store=new DirectChatStore("guest",repo,runner);await store.initialize();
  const id=store.getSnapshot().activeId!;
  store.setQuestion("Обычный вопрос");
  await store.send({...settings,allowWeb:false},"missing");
  expect(runner).not.toHaveBeenCalled();
  expect(store.getSnapshot().conversations[0].rows).toHaveLength(0);
  store.dispose();
});

const tinyImage={id:"i",name:"bike.png",mime:"image/png" as const,kind:"image" as const,
  data:"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aVz8AAAAASUVORK5CYII=",size:68};
const deepseekPro={...settings,provider:"openai-compatible" as const,baseUrl:"https://api.deepseek.com",model:"deepseek-v4-pro"};
test("H5: switching to a documented text-only model never consumes or uploads a pending photo",async()=>{
  const {repo,records}=repository(),runner=jest.fn();
  const store=new DirectChatStore("guest",repo,runner);await store.initialize();
  const id=store.getSnapshot().activeId!;
  store.setQuestion("Посмотри фото");store.setAttachments(id,[tinyImage]);
  await store.send(deepseekPro);
  expect(runner).not.toHaveBeenCalled();
  const draft=store.getSnapshot().conversations[0];
  expect(draft.question).toBe("Посмотри фото");
  expect(draft.attachments).toEqual([tinyImage]);
  expect(draft.rows).toEqual([]);
  expect(draft.busy).toBe(false);
  expect(store.getSnapshot().notice).toContain("не принимает изображения");
  // Draft can already be encrypted/persisted; only a network/model call is forbidden.
  store.dispose();
});
test("H5: a text-only model can answer a new text turn without uploading historical photos",async()=>{
  const {repo,records}=repository(),runner=jest.fn(async(_opts:any)=>({text:"Без фото ответить нельзя",sources:[],requests:1}));
  records.set("old",{id:"old",title:"Фото",createdAt:"2026-11-02",updatedAt:"2026-11-02",
    rows:[{id:"oldphoto",role:"user",text:"Найди велосипед",attachments:[tinyImage]}],
    drafts:[],question:"",interrupted:false});
  const store=new DirectChatStore("guest",repo,runner);await store.initialize();
  store.setQuestion("О чём говорили?");await store.send(deepseekPro);
  expect(runner).toHaveBeenCalledTimes(1);
  const history=runner.mock.calls[0][0].history;
  expect(history[0].content).toContain("Изображения из этого старого сообщения не переданы");
  expect(JSON.stringify(history)).not.toContain(tinyImage.data);
  expect(records.get("old")!.rows[0].attachments).toEqual([tinyImage]);
  store.dispose();
});
test("H5: explicit supported Flash model can pass a photo to the existing runner",async()=>{
  const {repo}=repository(),runner=jest.fn(async(_opts:any)=>({text:"Велосипед",sources:[],requests:1}));
  const store=new DirectChatStore("guest",repo,runner);await store.initialize();
  const id=store.getSnapshot().activeId!;
  store.setQuestion("Что на фото?");store.setAttachments(id,[tinyImage]);
  await store.send({...deepseekPro,model:"deepseek-flash"});
  expect(runner).toHaveBeenCalledTimes(1);
  expect(runner.mock.calls[0][0].attachments).toEqual([tinyImage]);
  store.dispose();
});

test("H-DOC1b2: long documents require an explicit approval key before store/model mutation",async()=>{
  const {repo,records}=repository();
  const runner=jest.fn(async(args:any)=>({text:args.prompt.includes("ПРОВЕРЕННЫЕ МЕТКИ")?"Общий вывод":"Вывод части",sources:[],requests:1}));
  const store=new DirectChatStore("guest",repo,runner);await store.initialize();
  const id=store.getSnapshot().activeId!;
  const sources=[
    {id:"d1",name:"first.txt",kind:"text" as const,mime:"text/plain",data:"A".repeat(20_000),size:60_000},
    {id:"d2",name:"second.txt",kind:"text" as const,mime:"text/plain",data:"Б".repeat(20_000),size:60_000},
  ];
  store.setQuestion("Перескажи отдельно и вместе");
  store.setAttachments(id,sources);
  await store.send(settings);
  expect(runner).not.toHaveBeenCalled();
  expect(store.getSnapshot().conversations[0].attachments).toEqual(sources);
  expect(store.getSnapshot().conversations[0].rows).toHaveLength(0);
  const plan=planDocumentSynthesis(sources,settings.model)!;
  (loadModelCallLimit as jest.Mock).mockResolvedValueOnce(5);
  await store.send(settings,undefined,plan.approvalKey);
  expect(runner).toHaveBeenCalledTimes(5);
  expect(store.getSnapshot().conversations[0].rows.at(-1)).toMatchObject({role:"assistant",text:"Общий вывод"});
  expect(records.get(id)?.rows[0].attachments).toEqual(sources);
  expect(runner.mock.calls[0][0].settings.apiKey).toBe(settings.apiKey);
  expect(runner.mock.calls[0][0].settings.allowWeb).toBe(false);
  store.dispose();
});

test("H-SAVE1b: confirmed summary is durable in SQLCipher chat, but not a memory note until user saves",async()=>{
  const {repo,records}=repository();
  const original:SavedConversation={id:"summary-chat",title:"Исходный диалог",createdAt:"2026-11-02",
    updatedAt:"2026-11-03",rows:[{id:"u1",role:"user",text:"Выбери из статей главные темы"},
      {id:"a1",role:"assistant",text:"Статьи о машинном обучении"}],question:"",drafts:[]};
  records.set(original.id,original);
  const runner=jest.fn(async(o:any)=>({text:"Кратко: **машинное обучение**.",sources:[],requests:1}));
  const store=new DirectChatStore("guest",repo,runner); await store.initialize();
  const plan=planDialogueSummary(original,"all",settings.model,settings.provider);
  const result=await store.summarizeForNote(original.id,settings,"all",plan.approvalKey);
  const snapshot=records.get(original.id)!;
  expect(result.conversationId).toBe(original.id);
  expect(snapshot.rows.at(-1)).toMatchObject({id:result.rowId,role:"assistant",
    dialogueSummary:{scope:"all",includedRows:2,totalRows:2}});
  expect(snapshot.rows.at(-1)?.text).toContain("2 текстовых сообщений из 2");
  expect(snapshot.interrupted).toBe(false);
  expect(runner).toHaveBeenCalledTimes(1);
  expect(runner.mock.calls[0][0].settings.allowWeb).toBe(false);
  expect(saveApprovedNote).not.toHaveBeenCalled();
  store.dispose();
});
test("H-SAVE1b: stale approval or explicit Stop never adds a misleading summary",async()=>{
  const {repo,records}=repository();
  const original:SavedConversation={id:"summary-chat",title:"Диалог",createdAt:"2026-11-02",
    updatedAt:"2026-11-03",rows:[{id:"u1",role:"user",text:"Что произошло?"}],question:"",drafts:[]};
  records.set(original.id,original);
  const runner=jest.fn((o:any)=>new Promise<never>((_resolve,reject)=>{
    o.signal.addEventListener("abort",()=>reject(new Error("aborted")));
  }));
  const store=new DirectChatStore("guest",repo,runner);await store.initialize();
  const plan=planDialogueSummary(original,"all",settings.model,settings.provider);
  await expect(store.summarizeForNote(original.id,settings,"all","stale-approval")).rejects.toThrow("изменились");
  expect(runner).not.toHaveBeenCalled();
  const pending=store.summarizeForNote(original.id,settings,"all",plan.approvalKey);
  await started(runner);
  store.stop(original.id);
  await expect(pending).rejects.toThrow();
  expect(records.get(original.id)?.rows).toHaveLength(1);
  expect(store.getSnapshot().conversations[0].busy).toBe(false);
  store.dispose();
});

test("context: one model turn commits the topic, section, and source answer together in SQLCipher",async()=>{
  const {repo,records}=repository();
  const runner=jest.fn().mockResolvedValue({
    text:"Возьмите аккумулятор",sources:[],requests:2,
    contextCandidate:{topic:"Выбор аккумулятора",sectionSlug:"projects",reason:"Обсуждение автомобиля"},
  });
  const store=new DirectChatStore("guest",repo,runner);await store.initialize();
  store.setQuestion("Подскажи аккумулятор");await store.send(settings);
  const c=store.getSnapshot().conversations[0],saved=records.get(c.id)!;
  expect(runner.mock.calls[0][0].context).toBeUndefined();
  expect(c.context).toEqual({topic:"Выбор аккумулятора",sectionSlug:"projects",pinned:false});
  expect(c.title).toBe("Выбор аккумулятора");
  expect(c.rows.at(-1)).toMatchObject({role:"assistant",text:"Возьмите аккумулятор",
    contextChange:{previousTopic:null,topic:"Выбор аккумулятора",sectionName:"Дела и проекты"}});
  expect(saved.context).toEqual(c.context);
  expect(saved.rows.at(-1)).toEqual(c.rows.at(-1));
  store.dispose();
});

test("context: a later switch preserves old snapshots, explicit UI pin blocks remote reclassification",async()=>{
  const {repo,records}=repository();const runner=jest.fn()
    .mockResolvedValueOnce({text:"Про авто",sources:[],requests:2,
      contextCandidate:{topic:"Авто",sectionSlug:"projects",reason:"Дела"}})
    .mockResolvedValueOnce({text:"Про рецепт",sources:[],requests:2,
      contextCandidate:{topic:"Лазанья",sectionSlug:"notes",reason:"Смена темы"}})
    .mockResolvedValueOnce({text:"Уточнение",sources:[],requests:2,
      contextCandidate:{topic:"Суп",sectionSlug:"projects",reason:"Новая тема"}});
  const store=new DirectChatStore("guest",repo,runner);await store.initialize();
  store.setQuestion("Авто");await store.send(settings);
  store.setQuestion("Теперь рецепт");await store.send(settings);
  const c=store.getSnapshot().conversations[0];
  const history=c.rows.filter(r=>r.contextChange);
  expect(history.map(row=>row.contextChange?.sectionSlug)).toEqual(["projects","notes"]);
  expect(history[0].contextChange?.topic).toBe("Авто");
  expect(history[1].contextChange?.previousSectionSlug).toBe("projects");
  store.setContextPinned(true);
  expect(store.getSnapshot().conversations[0].context?.pinned).toBe(true);
  store.setQuestion("Новая тема");await store.send(settings);
  const after=records.get(c.id)!;
  expect(runner.mock.calls[2][0].context.pinned).toBe(true);
  expect(after.context).toEqual({topic:"Лазанья",sectionSlug:"notes",pinned:true});
  expect(after.rows.filter(r=>r.contextChange)).toHaveLength(2);
  store.setContextPinned(false);
  expect(store.getSnapshot().conversations[0].context?.pinned).toBe(false);
  store.dispose();
});

test("context: an interrupted/failed model answer never saves a proposed new topic",async()=>{
  const {repo,records}=repository();
  const runner=jest.fn()
    .mockResolvedValueOnce({text:"Готово",sources:[],requests:2,
      contextCandidate:{topic:"Работа",sectionSlug:"projects",reason:"Проект"}})
    .mockRejectedValueOnce(new Error("network failure"));
  const store=new DirectChatStore("guest",repo,runner);await store.initialize();
  store.setQuestion("Проект");await store.send(settings);
  store.setQuestion("А теперь отпуск");await store.send(settings);
  const saved=records.get(store.getSnapshot().activeId!)!;
  expect(saved.context).toMatchObject({topic:"Работа",sectionSlug:"projects"});
  expect(saved.rows.filter(r=>r.contextChange)).toHaveLength(1);
  store.dispose();
});

test("context: an invalid/unknown section cannot be committed despite model claim",async()=>{
  const {repo,records}=repository();
  const runner=jest.fn().mockResolvedValue({text:"Рецепт",sources:[],requests:2,
    contextCandidate:{topic:"Рецепты",sectionSlug:"made-up",reason:"Источник"}});
  const store=new DirectChatStore("guest",repo,runner);await store.initialize();
  store.setQuestion("Готовим");await store.send(settings);
  const saved=records.get(store.getSnapshot().activeId!)!;
  expect(saved.context).toBeUndefined();
  expect(saved.rows.at(-1)?.contextChange).toBeUndefined();
  store.dispose();
});
