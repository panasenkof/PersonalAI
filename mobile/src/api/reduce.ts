import type { Fact, StreamEvent, ToolStep } from "../types";

export type RunState = {
  text: string;
  steps: ToolStep[];
  facts: Fact[];
  finished: null | "done" | "cancelled" | "error";
  error?: string;
};

export const emptyRun = (): RunState => ({ text: "", steps: [], facts: [], finished: null });

/** Pure reducer: folds one server event into the visible run state (unit-testable, no I/O). */
export function reduceRun(state: RunState, ev: StreamEvent): RunState {
  switch (ev.type) {
    case "token":
      return { ...state, text: state.text + ev.content };
    case "reset":
      return { ...state, text: "" };
    case "tool_call": {
      // the model is still composing the call: the name and arguments stream in
      const key = `call${ev.index}`;
      const steps = [...state.steps];
      const i = steps.findIndex((s) => s.key === key);
      const prev = i >= 0 ? steps[i] : { key, name: ev.name, state: "composing" as const, args: "" };
      const next: ToolStep = { ...prev, name: ev.name || prev.name, args: (prev.args || "") + (ev.arguments_delta || "") };
      if (i >= 0) steps[i] = next;
      else steps.push(next);
      return { ...state, steps };
    }
    case "tool_start": {
      // text before a tool call is a preamble; the final answer follows the tool result
      const steps = [...state.steps];
      const i = steps.findIndex((s) => s.state === "composing" && s.name === ev.name);
      const step: ToolStep = { key: i >= 0 ? steps[i].key : `t${steps.length}`, name: ev.name, state: "running", args: ev.arguments };
      if (i >= 0) steps[i] = step;
      else steps.push(step);
      return { ...state, text: "", steps };
    }
    case "tool": {
      const steps = [...state.steps];
      const i = steps.findIndex((s) => s.name === ev.name && s.state === "running");
      const done: ToolStep = {
        key: i >= 0 ? steps[i].key : `t${steps.length}`,
        name: ev.name,
        state: ev.ok ? "ok" : "error",
        summary: ev.summary,
        ms: ev.ms,
      };
      if (i >= 0) steps[i] = done;
      else steps.push(done);
      return { ...state, steps };
    }
    case "done":
      return {
        ...state,
        text: state.text.trim() ? state.text : ev.text || "",
        facts: ev.pending_facts ?? state.facts,
        finished: "done",
      };
    case "cancelled":
      return { ...state, finished: "cancelled" };
    case "error":
      return { ...state, finished: "error", error: ev.text };
    default:
      return state;
  }
}
