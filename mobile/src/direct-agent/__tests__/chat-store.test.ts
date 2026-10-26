import { DirectChatStore } from "../chat-store";
import type { ConversationRepository, SavedConversation } from "../conversations";
import { defaultDirectPreferences } from "../settings";
import { saveApprovedNote } from "../memory";
import { waitForApplicationSession } from "../../local-memory/storage";
import { loadModelCallLimit } from "../agent-preferences";

jest.mock("../../local-memory/storage", () => ({ waitForApplicationSession: jest.fn(async () => {}), withLocalMemoryDatabase: jest.fn() }));
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
