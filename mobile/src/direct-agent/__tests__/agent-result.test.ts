import { assistantRowFromResult, interruptedAssistantPatch } from "../agent-result";
import type { DirectResult } from "../engine";
import type { SavedConversation } from "../conversations";
import type { MemorySection } from "../fact-tool";

const sections = [{ name: "Заметки", slug: "notes" }] as MemorySection[];
const conversation = (): SavedConversation => ({
  id: "dialogue-1",
  title: "Заметки",
  createdAt: "2026-11-13T10:00:00.000Z",
  updatedAt: "2026-11-13T10:00:00.000Z",
  rows: [],
  drafts: [{ id: "draft-1", title: "Запомнить факт", body: "Тестовая запись" }],
  question: "",
});
const result = (): DirectResult => ({
  text: "Тестовый ответ", sources: ["https://example.org"], requests: 1,
});

test("ARCH-6a: pure answer mapper keeps notice order, proposals and canonical row fields", () => {
  const c = conversation();
  const before = JSON.stringify(c);
  const answer = assistantRowFromResult({
    ...result(), proposalIds: ["draft-1"], notice: "Интернет недоступен",
    photoAction: "prepare",
    contextCandidate: { topic: "Новый вопрос", sectionSlug: "notes", reason: "Пользователь сменил тему" },
  }, c, sections, "2026-11-13T11:00:00.000Z");
  expect(answer.notices).toEqual([
    "Запись подготовлена, но ещё не сохранена. Подтвердите её в карточке предложения.",
    "Интернет недоступен",
  ]);
  expect(answer.row).toMatchObject({
    role: "assistant", text: "Тестовый ответ", sources: ["https://example.org"],
    photoAction: "prepare",
    contextChange: { topic: "Новый вопрос", sectionSlug: "notes", at: "2026-11-13T11:00:00.000Z" },
  });
  expect(answer.context).toMatchObject({ topic: "Новый вопрос", sectionSlug: "notes", pinned: false });
  expect(JSON.stringify(c)).toBe(before);
});

test("ARCH-6a: bad or unavailable section cannot rewrite the persisted dialogue context", () => {
  const c = conversation();
  c.context = { topic: "Старый вопрос", sectionSlug: "notes", pinned: true };
  const answer = assistantRowFromResult({
    ...result(), contextCandidate: { topic: "Новый вопрос", sectionSlug: "missing", reason: "Новый контекст" },
  }, c, sections, "2026-11-13T11:00:00.000Z");
  expect(answer.context).toBeUndefined();
  expect(answer.change).toBeUndefined();
  expect(answer.row.contextChange).toBeUndefined();
  expect(c.context.pinned).toBe(true);
});

test("ARCH-6a: Stop retains the streamed fragment and does not restore submitted draft", () => {
  const c = conversation();
  const calls: string[] = [];
  const patch = interruptedAssistantPatch({
    conversation: { ...c, busy: true, progress: "" },
    taskState: { turnStatus: "running" } as any,
    internetPhotoId: false, intentPreserveDraft: false, modelStarted: true,
    beforeModelError: "Не удалось сохранить историю",
    prompt: "Запрос", draftFiles: [], signalAborted: true,
    latest: "Частичный ответ    ", error: new Error("aborted"),
    newId: () => { const id = "row-" + (calls.length + 1); calls.push(id); return id; },
  });
  expect(calls).toEqual(["row-1", "row-2"]);
  expect(patch.rows?.slice(-2)).toMatchObject([
    { id: "row-2", role: "assistant", text: "Частичный ответ" },
    { id: "row-1", role: "info", text: "Ответ остановлен" },
  ]);
  expect(patch.question).toBeUndefined();
  expect(patch.taskState?.turnStatus).toBe("interrupted");
});

test("ARCH-6a: pre-model failure preserves the draft without claiming an answer", () => {
  const c = conversation();
  const patch = interruptedAssistantPatch({
    conversation: { ...c, busy: true, progress: "" },
    taskState: { turnStatus: "running" } as any,
    internetPhotoId: false, intentPreserveDraft: false, modelStarted: false,
    beforeModelError: "Не удалось сохранить историю",
    prompt: "Запрос", draftFiles: [], signalAborted: false,
    latest: "", error: new Error("disk error"), newId: () => "failure-row",
  });
  expect(patch.question).toBe("Запрос");
  expect(patch.attachments).toEqual([]);
  expect(patch.rows?.at(-1)).toMatchObject({ id: "failure-row", role: "info", error: true, text: "Не удалось сохранить историю" });
});
