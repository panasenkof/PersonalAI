import * as SecureStore from "expo-secure-store";
import { useSyncExternalStore } from "react";

export type VoiceEngine = "system" | "whisper";
type Preference = VoiceEngine | "auto";
/** `pending` is the choice being saved: the screen shows it at once, so the
 * switch never flickers back to the old engine while the write completes. */
type VoiceEngineState = { loaded: boolean; preference: Preference; saving: boolean; error: string; pending?: VoiceEngine };
const KEY = "pia.voice.engine.v1";
let state: VoiceEngineState = { loaded: false, preference: "auto", saving: false, error: "" };
let initialized: Promise<void> | null = null;
let writes: Promise<void> = Promise.resolve();
let revision = 0;
const listeners = new Set<() => void>();
const publish = (patch: Partial<VoiceEngineState>) => { state = { ...state, ...patch }; listeners.forEach(fn => fn()); };
export const getVoiceEngine = () => state;

/** Auto uses system Google online by default. Whisper is used only when
 * explicitly selected; downloading a model cannot silently change ASR. */
export function resolveVoiceEngine(preference: Preference, _whisperReady: boolean): VoiceEngine {
  return preference === "whisper" ? "whisper" : "system";
}
/** LLM cleanup is useful for rough offline Whisper transcripts, not Google dictation. */
export function showDraftImprove(preference: Preference): boolean {
  return resolveVoiceEngine(preference, false) === "whisper";
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
  publish({ saving: true, error: "", pending: engine });
  const write = writes.catch(() => {}).then(() => SecureStore.setItemAsync(KEY, engine));
  writes = write;
  try {
    await write;
    publish({ preference: engine, ...(request === revision ? { saving: false, pending: undefined } : {}) });
  } catch {
    const message = "Не удалось сохранить способ распознавания. Попробуйте выбрать его ещё раз.";
    if (request === revision) publish({ saving: false, error: message, pending: undefined });
    throw new Error(message);
  }
}

/** Approval for sending speech to the selected system recognizer's online
 * service. Stored separately from ASR engine choice and never auto-granted. */
const ONLINE_CONSENT_KEY = "pia.voice.system-online-consent.v1";
let onlineConsent: boolean | null = null;
let onlineConsentRead: Promise<boolean> | null = null;
export async function hasOnlineSpeechConsent(): Promise<boolean> {
  if (onlineConsent !== null) return onlineConsent;
  onlineConsentRead ??= SecureStore.getItemAsync(ONLINE_CONSENT_KEY)
    .then(saved => (onlineConsent = saved === "true"))
    .catch(() => false);
  return onlineConsentRead;
}
export async function grantOnlineSpeechConsent(): Promise<void> {
  await SecureStore.setItemAsync(ONLINE_CONSENT_KEY, "true");
  onlineConsent = true;
}
