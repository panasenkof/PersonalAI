import { editNote, mayEditNoteText, parseNoteEdit } from "../edit-note";
import { defaultDirectPreferences } from "../settings";
const settings = { ...defaultDirectPreferences, provider: "openai-compatible" as const, baseUrl: "https://llm.example.org/v1", model: "test", apiKey: "secret", webSearchKey: "" };
const draft = { title: "Рецепт", body: "Испечь хлеб" };
const output = { title: "Рецепт", body: "1. Испечь хлеб." };
const response = (finish_reason = "stop") => ({ ok: true, json: async () => ({ choices: [{ finish_reason, message: { content: JSON.stringify(output) } }] }) });
test("one explicit edit sends only note and instruction, with no tools or memory", async () => {
  const transport = jest.fn(async () => response());
  expect(await editNote(settings, draft, "Оформи списком", { allowed: true, transport: transport as any })).toEqual(output);
  expect(transport).toHaveBeenCalledTimes(1);
  const [, init] = transport.mock.calls[0] as unknown as [string, RequestInit];
  const body = JSON.parse(String(init.body));
  expect(body.messages).toHaveLength(2);
  expect(JSON.parse(body.messages[1].content)).toEqual({ instruction: "Оформи списком", note: draft });
  expect(body.tools).toBeUndefined();
  expect(String(init.body)).not.toContain(settings.apiKey);
  expect(draft.body).toBe("Испечь хлеб");
});
test("private and oversized drafts cannot make a model call", async () => {
  const transport = jest.fn();
  await expect(editNote(settings, draft, "Сократи", { allowed: false, transport })).rejects.toThrow("закрыта");
  await expect(editNote(settings, { ...draft, body: "a".repeat(16001) }, "Сократи", { allowed: true, transport })).rejects.toThrow("не обрезан");
  expect(transport).not.toHaveBeenCalled();
});
test("cutoff never becomes a partial saved edit and is not retried", async () => {
  const transport = jest.fn(async () => response("length"));
  await expect(editNote(settings, draft, "Сократи", { allowed: true, transport: transport as any })).rejects.toThrow("обрезан");
  expect(transport).toHaveBeenCalledTimes(1);
});
test("aborted operation rejects even if the transport completes later", async () => {
  const controller = new AbortController();
  const transport = jest.fn(async () => { controller.abort(); return response(); });
  await expect(editNote(settings, draft, "Сократи", { allowed: true, signal: controller.signal, transport: transport as any })).rejects.toThrow();
});
test.each(["{}", "[]", 'null', '{"title":"a","body":""}', '```oops```'])("invalid output is rejected: %s", input => expect(() => parseNoteEdit(input)).toThrow());
test("inherit uses collection access and unsaved move never makes a private note public", () => {
  expect(mayEditNoteText("inherit", "standard", "standard")).toBe(true);
  expect(mayEditNoteText("standard", "standard", "sensitive")).toBe(false);
  expect(mayEditNoteText("secret", "standard", "standard")).toBe(false);
  expect(mayEditNoteText("inherit", undefined)).toBe(false);
});
test("Anthropic follows the same contract", async () => {
  const transport = jest.fn(async () => ({ ok: true, json: async () => ({ content: [{ type: "text", text: JSON.stringify(output) }] }) }));
  expect(await editNote({ ...settings, provider: "anthropic" }, draft, "Оформи", { allowed: true, transport: transport as any })).toEqual(output);
  expect(String((transport.mock.calls[0] as unknown[])[0])).toMatch(/messages$/);
});
