import type { NebulaVisualMode } from "./visualMode";
import { DEFAULT_NEBULA_VISUAL_MODE } from "./visualMode";

/** Browser QA fallback only: native resolves visualPreference.native.ts.
 * No Android GPU tests can be inferred from this in-memory preference. */
let current: NebulaVisualMode = DEFAULT_NEBULA_VISUAL_MODE;
export async function getNebulaVisualMode(): Promise<NebulaVisualMode> {
  return current;
}
export async function setNebulaVisualMode(mode: NebulaVisualMode): Promise<void> {
  if (mode !== "live" && mode !== "static") throw new Error("Invalid Nebula graphics mode");
  current = mode;
}
