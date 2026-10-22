import Storage from "expo-sqlite/kv-store";
import { DEFAULT_NEBULA_VISUAL_MODE, NEBULA_VISUAL_MODE_KEY, parseNebulaVisualMode } from "./visualMode";
import type { NebulaVisualMode } from "./visualMode";

/**
 * Native graphics-only A/B preference. This separate SQLite key is not
 * SQLCipher, does not contain secrets, and does not touch user memory.
 */
export async function getNebulaVisualMode(): Promise<NebulaVisualMode> {
  const raw = await Storage.getItem(NEBULA_VISUAL_MODE_KEY);
  return parseNebulaVisualMode(raw ?? DEFAULT_NEBULA_VISUAL_MODE);
}

export async function setNebulaVisualMode(mode: NebulaVisualMode): Promise<void> {
  if (mode !== "live" && mode !== "static") throw new Error("Invalid Nebula graphics mode");
  await Storage.setItem(NEBULA_VISUAL_MODE_KEY, mode);
}
