/** Background index-word passes for one profile: after a record is saved, on
 * app start, and on request from settings. One pass at a time; it stops when
 * the app locks and on the first failure (shown in settings, retried later). */
import * as SecureStore from "expo-secure-store";
import { useSyncExternalStore } from "react";
import { localMemoryRepository } from "../local-memory/repository";
import { localMemorySessionUnlocked, onLocalMemorySessionChange } from "../local-memory/storage";
import { loadDirectConnections } from "./settings";
import { MODEL_TERMS_SOURCE, canEnrich, enrichPending, indexTermsModel } from "./enrich";

export type EnrichState = {
  loaded: boolean; enabled: boolean; running: boolean;
  done: number; pending: number; error: string; model: string;
};
const KEY = "pia.memory.index-terms.v1";
let state: EnrichState = { loaded: false, enabled: true, running: false, done: 0, pending: 0, error: "", model: "" };
const listeners = new Set<() => void>();
const publish = (patch: Partial<EnrichState>) => { state = { ...state, ...patch }; listeners.forEach(l => l()); };
export const getEnrichState = () => state;
export function useEnrichState(): EnrichState {
  return useSyncExternalStore(l => { listeners.add(l); return () => { listeners.delete(l); }; }, getEnrichState, getEnrichState);
}

let loading: Promise<void> | null = null;
export const loadIndexTermsPreference = () => loading ??= SecureStore.getItemAsync(KEY)
  .then(v => publish({ loaded: true, enabled: v !== "off" }))
  .catch(() => publish({ loaded: true }));

export async function setIndexTermsEnabled(enabled: boolean, profile?: string): Promise<void> {
  await SecureStore.setItemAsync(KEY, enabled ? "on" : "off");
  publish({ enabled, ...(enabled ? {} : { error: "" }) });
  if (enabled && profile) scheduleIndexTerms(profile, 0);
  else current?.abort();
}

export async function refreshIndexTermsStatus(profile: string): Promise<void> {
  try { publish(await (await localMemoryRepository(profile)).indexTermsStatus(MODEL_TERMS_SOURCE)); }
  catch { /* locked: keep the last numbers */ }
}

let current: AbortController | null = null;
let currentProfile: string | null = null;
let requestedProfile: string | null = null;
let queuedProfile: string | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;
let again = false;
/** Runs passes until nothing is left, a pass fails, the app locks or the
 * feature is switched off. Repeated calls while running queue one more pass. */
export function scheduleIndexTerms(profile: string, delayMs = 1500): void {
  if (!profile) return;
  requestedProfile = profile;
  if (current) {
    if (currentProfile !== profile || current.signal.aborted) { queuedProfile = profile; current.abort(); }
    else again = true;
    return;
  }
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => { timer = null; void run(profile); }, delayMs);
}

async function run(profile: string): Promise<void> {
  await loadIndexTermsPreference();
  if (!state.enabled || current || profile !== requestedProfile || !localMemorySessionUnlocked()) return;
  const aborter = new AbortController(); current = aborter; currentProfile = profile;
  const unsubscribe = onLocalMemorySessionChange(unlocked => { if (!unlocked) aborter.abort(); });
  publish({ running: true, error: "" });
  try {
    const connections = await loadDirectConnections(profile);
    if (aborter.signal.aborted) return;
    const settings = connections.connections.find(c => c.id === connections.activeId);
    if (!canEnrich(settings)) { publish({ error: "Нет подключения к модели: Настройки → Модели и подключения." }); return; }
    publish({ model: settings.name + " · " + indexTermsModel(settings).model });
    const repo = await localMemoryRepository(profile);
    for (let pass = 0; pass < 50 && !aborter.signal.aborted && state.enabled; pass++) {
      again = false;
      const result = await enrichPending(repo, settings, { limit: 10, signal: aborter.signal });
      if (aborter.signal.aborted) break;
      publish(await repo.indexTermsStatus(MODEL_TERMS_SOURCE));
      if (result.error) { if (!aborter.signal.aborted) publish({ error: result.error }); break; }
      if (!result.done && !again) break;
    }
  } catch (e) {
    if (!aborter.signal.aborted) publish({ error: String((e as Error)?.message || e) });
  } finally {
    unsubscribe();
    if (current === aborter) {
      current = null; currentProfile = null; publish({ running: false });
      const next = queuedProfile; queuedProfile = null;
      if (next && state.enabled && localMemorySessionUnlocked()) scheduleIndexTerms(next, 0);
    }
  }
}

/** Test hook. */
export function resetIndexTermsRunner() { current?.abort(); current = null; loading = null; again = false; if (timer) clearTimeout(timer); timer = null;
  currentProfile = null; requestedProfile = null; queuedProfile = null;
  state = { loaded: false, enabled: true, running: false, done: 0, pending: 0, error: "", model: "" }; }
