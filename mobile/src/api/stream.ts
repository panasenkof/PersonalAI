import EventSource from "react-native-sse";

import type { JobOut, StreamEvent } from "../types";
import { accessToken, api, baseUrl } from "./client";
import { emptyRun, reduceRun, type RunState } from "./reduce";

export { emptyRun, reduceRun, type RunState } from "./reduce";

type Custom = "status" | "token" | "reset" | "tool_call" | "tool_start" | "tool" | "done" | "cancelled" | "error";
const EVENTS: Custom[] = ["status", "token", "reset", "tool_call", "tool_start", "tool", "done", "cancelled", "error"];

/**
 * Follow a job. Uses SSE (tokens + tool calls live); if the stream breaks it falls back to polling.
 * Returns a function that detaches the listener (the job itself keeps running — use api.cancelJob to stop it).
 */
export function followJob(jobId: string, onUpdate: (s: RunState) => void): { promise: Promise<RunState>; close: () => void } {
  let state = emptyRun();
  let closed = false;
  let es: EventSource<Custom> | null = null;
  const push = (next: RunState) => {
    state = next;
    if (!closed) onUpdate(state);
  };

  const promise = new Promise<RunState>((resolve) => {
    const finish = () => {
      es?.close();
      resolve(state);
    };

    const poll = async () => {
      for (let i = 0; i < 180 && !closed; i++) {
        await new Promise((r) => setTimeout(r, 1000));
        let job: JobOut;
        try {
          job = await api.job(jobId);
        } catch {
          continue;
        }
        if (job.status === "completed" || job.status === "awaiting_confirm") {
          push({ ...state, text: job.result?.assistant_text ?? state.text, facts: job.pending_facts, finished: "done" });
          return finish();
        }
        if (job.status === "cancelled") {
          push({ ...state, finished: "cancelled" });
          return finish();
        }
        if (job.status === "failed") {
          push({ ...state, finished: "error", error: job.error ?? "failed" });
          return finish();
        }
      }
      push({ ...state, finished: "error", error: "timeout" });
      finish();
    };

    es = new EventSource<Custom>(`${baseUrl()}/v1/jobs/${jobId}/events`, {
      headers: { Authorization: `Bearer ${accessToken() ?? ""}` },
    });
    for (const name of EVENTS) {
      es.addEventListener(name, (e) => {
        const data = (e as { data?: string | null }).data;
        if (!data) return;
        try {
          const ev = JSON.parse(data) as StreamEvent;
          push(reduceRun(state, ev));
          if (state.finished) finish();
        } catch {
          /* ignore malformed frame */
        }
      });
    }
    // native connection errors (no payload): switch to polling
    es.addEventListener("error" as never, (e: unknown) => {
      if ((e as { data?: string }).data || state.finished) return;
      es?.close();
      void poll();
    });
  });

  return {
    promise,
    close: () => {
      closed = true;
      es?.close();
    },
  };
}
