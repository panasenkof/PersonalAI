/** Background vectors of memory chunks (п. 13): after the model is downloaded,
 * after a record is saved and on app start. Batches of 16 chunks; stops when
 * the app locks, on an error, or when the model is deleted. Computed on the
 * phone, so every section is indexed — «Документы» included. */
import { useSyncExternalStore } from "react";
import { localMemoryRepository } from "../local-memory/repository";
import { localMemorySessionUnlocked, onLocalMemorySessionChange } from "../local-memory/storage";
import { VECTOR_MODEL } from "../local-memory/vectors";
import { embedTexts, embedderReady } from "./embedder";

export type VectorState = { running: boolean; done: number; total: number; error: string; perChunkMs?: number };
let state: VectorState = { running: false, done: 0, total: 0, error: "" };
const listeners = new Set<() => void>();
const publish = (patch: Partial<VectorState>) => { state = { ...state, ...patch }; listeners.forEach(l => l()); };
export const getVectorState = () => state;
export function useVectorState(): VectorState {
  return useSyncExternalStore(l => { listeners.add(l); return () => { listeners.delete(l); }; }, getVectorState, getVectorState);
}

export async function refreshVectorStatus(profile: string): Promise<void> {
  try { publish(await (await localMemoryRepository(profile)).vectorStatus(VECTOR_MODEL)); } catch { /* locked */ }
}

let current: AbortController | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;
let again = false;
export function scheduleVectors(profile: string, delayMs = 1500): void {
  if (!profile) return;
  if (current) { again = true; return; }
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => { timer = null; void run(profile); }, delayMs);
}
export function stopVectors(): void { current?.abort(); if (timer) clearTimeout(timer); timer = null; }

async function run(profile: string): Promise<void> {
  if (current || !localMemorySessionUnlocked() || !(await embedderReady())) return;
  const aborter = new AbortController(); current = aborter;
  const unsubscribe = onLocalMemorySessionChange(unlocked => { if (!unlocked) aborter.abort(); });
  publish({ running: true, error: "" });
  try {
    const repo = await localMemoryRepository(profile);
    publish(await repo.vectorStatus(VECTOR_MODEL));
    for (let batch = 0; batch < 2000 && !aborter.signal.aborted; batch++) {
      again = false;
      const pending = await repo.pendingVectorChunks(VECTOR_MODEL, 16);
      if (!pending.length) { if (again) continue; break; }
      const started = Date.now();
      const vectors = await embedTexts(pending.map(p => p.text));
      if (aborter.signal.aborted) break;
      await repo.saveVectors(VECTOR_MODEL, pending.map((p, i) => ({ chunkId: p.chunkId, vector: vectors[i], hash: p.hash })));
      publish({ ...(await repo.vectorStatus(VECTOR_MODEL)), perChunkMs: Math.round((Date.now() - started) / pending.length) });
    }
  } catch (e) {
    if (!aborter.signal.aborted) publish({ error: String((e as Error)?.message || e) });
  } finally {
    unsubscribe(); current = null; publish({ running: false });
  }
}
