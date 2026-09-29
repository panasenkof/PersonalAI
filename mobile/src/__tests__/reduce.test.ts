import { emptyRun, reduceRun } from "../api/reduce";
import type { StreamEvent } from "../types";

const fold = (events: StreamEvent[]) => events.reduce(reduceRun, emptyRun());

describe("reduceRun", () => {
  it("accumulates tokens and resets on demand", () => {
    const s = fold([
      { type: "token", content: "При" },
      { type: "token", content: "вет" },
    ]);
    expect(s.text).toBe("Привет");
    expect(reduceRun(s, { type: "reset" }).text).toBe("");
  });

  it("shows a tool call while it is being composed, then running, then done", () => {
    let s = fold([
      { type: "tool_call", index: 0, name: "kb_search", arguments_delta: '{"query":' },
      { type: "tool_call", index: 0, name: "kb_search", arguments_delta: ' "oil"}' },
    ]);
    expect(s.steps).toHaveLength(1);
    expect(s.steps[0]).toMatchObject({ state: "composing", args: '{"query": "oil"}' });

    s = reduceRun({ ...s, text: "Сейчас проверю" }, { type: "tool_start", name: "kb_search", arguments: '{"query": "oil"}' });
    expect(s.steps).toHaveLength(1); // same chip, not a duplicate
    expect(s.steps[0].state).toBe("running");
    expect(s.text).toBe(""); // preamble dropped

    s = reduceRun(s, { type: "tool", name: "kb_search", ok: true, summary: "3 найдено", ms: 12 });
    expect(s.steps[0]).toMatchObject({ state: "ok", summary: "3 найдено", ms: 12 });
  });

  it("marks failed tools and keeps facts from the done event", () => {
    const s = fold([
      { type: "tool_start", name: "labs_record_report", arguments: "{}" },
      { type: "tool", name: "labs_record_report", ok: false, summary: "vision_parse_failed" },
      { type: "done", text: "Не вышло", pending_facts: [{ id: "f1", status: "pending_user_confirm", summary: "x" }] },
    ]);
    expect(s.steps[0].state).toBe("error");
    expect(s.text).toBe("Не вышло");
    expect(s.facts.map((f) => f.id)).toEqual(["f1"]);
    expect(s.finished).toBe("done");
  });

  it("handles cancel and error terminals", () => {
    expect(fold([{ type: "token", content: "част" }, { type: "cancelled" }]).finished).toBe("cancelled");
    const e = fold([{ type: "error", text: "boom" }]);
    expect(e.finished).toBe("error");
    expect(e.error).toBe("boom");
  });
});
