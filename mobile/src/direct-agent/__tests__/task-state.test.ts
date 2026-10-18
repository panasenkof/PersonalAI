import { beginTask, parseTaskState, updateTaskInterpretation, mergeTaskReceipts, recordEvidence } from "../task-state";
import { createToolCatalog } from "../tool-catalog";
import { webAllowed } from "../dialogue";
import { defaultDirectPreferences } from "../settings";
const options = () => ({ settings: { ...defaultDirectPreferences, apiKey: "test", webSearchKey: "", allowWeb: true }, prompt: "Продолжай", history: [], lookup: jest.fn(async () => []), propose: jest.fn(() => "draft-1") });
test("selection and network denial survive trimmed history and restoration", () => {
  const state = { ...updateTaskInterpretation(beginTask(undefined, "Ужин"), { goal: "Выбрать ужин", selection: "Форель", openQuestions: ["Порции?"] }), webPreference: "deny" as const };
  const restored = beginTask(parseTaskState(JSON.parse(JSON.stringify(state))), "На двоих");
  expect(restored).toMatchObject({ selection: "Форель", openQuestions: ["Порции?"], lastRequest: "На двоих" });
  expect(webAllowed({ ...options(), taskState: restored })).toBe(false);
  expect(webAllowed({ ...options(), taskState: restored, prompt: "Теперь поищи в интернете" })).toBe(true);
  expect(beginTask(undefined, "Новая тема").selection).toBe("");
});
test("invalid state is ignored and restored data stays bounded", () => {
  expect(parseTaskState({ version: 2 })).toBeUndefined(); expect(parseTaskState(null)).toBeUndefined();
  const state = parseTaskState({ version: 1, goal: "x".repeat(2000), evidence: [null, { outcome: "invented" }], openQuestions: Array(20).fill("q") })!;
  expect(state.goal).toHaveLength(600); expect(state.openQuestions).toHaveLength(5); expect(state.evidence).toEqual([]);
});
test("model cannot forge saved receipts or network permission", async () => {
  const catalog = createToolCatalog(options(), [], [], []);
  for (const extra of [{ evidence: [{ outcome: "saved" }] }, { webPreference: "allow" }]) {
    expect(await catalog.run("update_task_state", { goal: "Dinner", selection: "Fish", openQuestions: [], ...extra })).toHaveProperty("error");
  }
  expect(catalog.finish().taskState?.evidence.some(e => e.outcome === "saved")).toBe(false);
});
test("proposals deduplicate within and across turns without claiming save", async () => {
  const opts = options(); const args = { title: "Ужин", body: "Форель" };
  const catalog = createToolCatalog(opts, [], [], []);
  expect(await catalog.run("draft_memory_fact", args)).toMatchObject({ saved: false, outcome: "pending_confirmation", proposalId: "draft-1" });
  expect(await catalog.run("draft_memory_fact", args)).toHaveProperty("duplicate", true);
  const next = createToolCatalog({ ...opts, pendingNotes: [{ ...args, id: "draft-1" }] }, [], [], []);
  expect(await next.run("draft_memory_fact", args)).toHaveProperty("duplicate", true);
  expect(opts.propose).toHaveBeenCalledTimes(1);
});
test("failed proposal produces no confirmation; malformed memory fails", async () => {
  const catalog = createToolCatalog({ ...options(), propose: () => { throw Error("disk"); }, lookup: jest.fn(async () => null as any) }, [], [], []);
  expect(await catalog.run("draft_memory_fact", { title: "Test", body: "Test" })).toHaveProperty("error");
  expect(catalog.finish().proposalIds).toEqual([]);
  expect(await catalog.run("search_local_notes", { query: "ужин" })).toHaveProperty("error", "invalid_memory_result");
});
test("cancelled lookup records no success and cannot run following tools", async () => {
  const controller = new AbortController(); const opts = options();
  const catalog = createToolCatalog({ ...opts, signal: controller.signal, lookup: async () => { controller.abort(); return []; } }, [], [], []);
  await expect(catalog.run("search_local_notes", { query: "ужин" })).rejects.toThrow();
  await expect(catalog.run("draft_memory_fact", { title: "x", body: "y" })).rejects.toThrow(); expect(opts.propose).not.toHaveBeenCalled();
});
test.each(["saved", "dismissed"] as const)("late state cannot downgrade %s", outcome => {
  const pending = recordEvidence(beginTask(undefined, "Ужин"), { tool: "draft_memory_fact", outcome: "pending_confirmation", subject: "d", excerpt: "Ужин" });
  const current = recordEvidence(pending, { ...pending.evidence[0], outcome });
  expect(mergeTaskReceipts(pending, current).evidence).toEqual(current.evidence);
});
