import { presentChatRows } from "../chatPresentation";
import type { ChatRow } from "../../../direct-agent/conversations";
const user: ChatRow = { id: "u1", role: "user", text: "Вопрос" };
const answer: ChatRow = { id: "db-id", role: "assistant", text: "Ответ", memory: [{ id: "note", title: "Запись", via: "search" }] };
it("reconciles streamed and saved reply as the SAME cell, including busy completion publication", () => {
  const streamed = presentChatRows([user], true, "От");
  const completing = presentChatRows([user, answer], true, "От");
  const completed = presentChatRows([user, answer], false);
  expect(streamed).toHaveLength(2);
  expect(completing).toHaveLength(2);
  expect(completed).toEqual(completing);
  expect(streamed[1].viewKey).toBe(completed[1].viewKey);
  expect(completed[1].memory).toEqual(answer.memory);
  expect(completed[1].id).toBe("db-id");
});
it("keeps per-turn keys unique across history, notices, multiple assistant rows and the next Send", () => {
  const rows: ChatRow[] = [user, answer, { ...answer, id: "extra" }, { id: "u2", role: "user", text: "Ещё" }, { id: "info", role: "info", text: "Ищу" }];
  const result = presentChatRows(rows, true, "Начало");
  expect(new Set(result.map(row => row.viewKey)).size).toBe(result.length);
  expect(result.at(-1)?.viewKey).toBe("reply:u2:0");
  expect(rows).toHaveLength(5);
});
it("removes an ephemeral reply after cancellation without inventing persisted content", () => {
  expect(presentChatRows([user], false, "partial")).toHaveLength(1);
  expect(presentChatRows([], true, "partial")).toEqual([]);
});
