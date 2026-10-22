import type { NebulaPhase } from "./motion";

/** Mirrors actual VoiceInput phases. No simulated microphone activity. */
export type NebulaVoicePhase = "idle" | "starting" | "listening" | "finishing";

export interface NebulaHomeSignals {
  voicePhase: NebulaVoicePhase;
  busy: boolean;
  streamText?: string | null;
  error?: string | null;
  /** Before connection & history initialization there is no real model status. */
  ready: boolean;
}

export function resolveNebulaHomePhase(signals: NebulaHomeSignals): NebulaPhase {
  if (signals.voicePhase === "listening") return "listening";
  if (signals.voicePhase === "finishing") return "transcribing";
  // "starting" waits on permissions / speech service; not yet recording.
  if (signals.busy) return signals.streamText?.trim() ? "responding" : "thinking";
  if (signals.error?.trim()) {
    return /(?:no (?:internet|connection)|network (?:error|unavailable)|offline|нет (?:сети|интернета|соединения)|отсутствует соединение|сеть недоступна)/i
      .test(signals.error) ? "offline" : "error";
  }
  return "idle";
}
