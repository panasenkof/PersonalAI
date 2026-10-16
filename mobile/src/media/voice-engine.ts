import * as SecureStore from "expo-secure-store";
import { useSyncExternalStore } from "react";

export type VoiceEngine = "system" | "whisper";
type Preference = VoiceEngine | "auto";
type VoiceEngineState = { loaded: boolean; preference: Preference; saving: boolean; error: string };
const KEY = "pia.voice.engine.v1";
let state: VoiceEngineState = { loaded: false, preference: "auto", saving: false, error: "" };
let initialized: Promise<void> | null = null;
let writes: Promise<void> = Promise.resolve();
let revision = 0;
const listeners = new Set<() => void>();
const publish = (patch: Partial<VoiceEngineState>) => { state = { ...state, ...patch }; listeners.forEach(fn => fn()); };
export const getVoiceEngine = () => state;

/** Existing installations retain their automatic choice until the user makes
 * an explicit choice. Preferences are independent of the downloaded model. */
export function resolveVoiceEngine(preference: Preference, whisperReady: boolean): VoiceEngine {
  return preference === "auto" ? (whisperReady ? "whisper" : "system") : preference;
}
export function initVoiceEngine(): Promise<void> {
  return initialized ??= (async () => {
    try {
      const saved = await SecureStore.getItemAsync(KEY);
      publish({ loaded: true, preference: saved === "system" || saved === "whisper" ? saved : "auto", error: "" });
    } catch {
      publish({ loaded: true, error: "Не удалось прочитать способ распознавания. Выберите его снова: Настройки → Голосовой ввод." });
    }
  })();
}
export function useVoiceEngine(): VoiceEngineState {
  return useSyncExternalStore(listener => {
    listeners.add(listener); void initVoiceEngine(); return () => { listeners.delete(listener); };
  }, getVoiceEngine, getVoiceEngine);
}
export async function setVoiceEngine(engine: VoiceEngine): Promise<void> {
  await initVoiceEngine();
  const request = ++revision;
  publish({ saving: true, error: "" });
  const write = writes.catch(() => {}).then(() => SecureStore.setItemAsync(KEY, engine));
  writes = write;
  try {
    await write;
    publish({ preference: engine, ...(request === revision ? { saving: false } : {}) });
  } catch {
    const message = "Не удалось сохранить способ распознавания. Попробуйте выбрать его ещё раз.";
    if (request === revision) publish({ saving: false, error: message });
    throw new Error(message);
  }
}
