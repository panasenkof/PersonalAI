/** Background vectors of memory chunks (п. 13): after the model is downloaded,
 * after a record is saved and on app start. Batches of 16 chunks; stops when
 * the app locks, on an error, or when the model is deleted. Computed on the
 * phone, so every section is indexed — «Документы» included. */
import { useSyncExternalStore } from "react";
import { Platform } from "react-native";
import { localMemoryRepository } from "../local-memory/repository";
import { localMemorySessionUnlocked, onLocalMemorySessionChange } from "../local-memory/storage";
import { vectorSpaceKey } from "../local-memory/vectors";
import { embedTexts, embedderReady } from "./embedder";

// The downloader still identifies the model by its friendly name; persisted
// vectors use a versioned namespace that changes when inference does.
const ACTIVE_VECTOR_SPACE = vectorSpaceKey(Platform.OS === "ios" ? "ios" : "android");

export type VectorState = { running: boolean; done: number; total: number; error: string; perChunkMs?: number };
let state: VectorState = { running: false, done: 0, total: 0, error: "" };
const listeners = new Set<() => void>();
const publish = (patch: Partial<VectorState>) => { state = { ...state, ...patch }; listeners.forEach(l => l()); };
export const getVectorState = () => state;
export function useVectorState(): VectorState {
  return useSyncExternalStore(l => { listeners.add(l); return () => { listeners.delete(l); }; }, getVectorState, getVectorState);
}

export async function refreshVectorStatus(profile: string): Promise<void> {
  try { publish(await (await localMemoryRepository(profile)).vectorStatus(ACTIVE_VECTOR_SPACE)); } catch { /* locked */ }
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
export function stopVectors(): void {
  again = false;
  current?.abort();
  if (timer) clearTimeout(timer);
  timer = null;
}

async function run(profile: string): Promise<void> {
  if (current || !localMemorySessionUnlocked() || !(await embedderReady())) return;
  const aborter = new AbortController();
  current = aborter;
  const unsubscribe = onLocalMemorySessionChange(unlocked => {
    if (!unlocked) aborter.abort();
  });
  let retryDelay: number | null = null;
  publish({ running: true, error: "" });
  try {
    const repo = await localMemoryRepository(profile);
    publish(await repo.vectorStatus(ACTIVE_VECTOR_SPACE));
    // Four chunks per native batch bound the time a foreground semantic query
    // waits behind background indexing on the shared on-device embedder.
    for (let batch = 0; batch < 2000 && !aborter.signal.aborted; batch++) {
      again = false;
      const jobs = await repo.claimVectorJobs(ACTIVE_VECTOR_SPACE, 4);
      if (!jobs.length) {
        const wake = await repo.nextVectorWakeMs(ACTIVE_VECTOR_SPACE);
        if (wake === 0) { again = true; break; } // cursor bootstrap still active
        if (wake !== null) retryDelay = Math.max(1000, wake);
        break;
      }
      const started = Date.now();
      try {
        const vectors = await embedTexts(jobs.map(job => job.text));
        if (aborter.signal.aborted) {
          // A lock may close SQLCipher before this call; the persistent lease
          // expires safely even if the graceful release cannot be committed.
          await repo.releaseVectorJobs(ACTIVE_VECTOR_SPACE, jobs).catch(() => undefined);
          break;
        }
        await repo.completeVectorJobs(ACTIVE_VECTOR_SPACE,
          jobs.map((job, i) => ({ job, vector: vectors[i] })));
        if (batch % 8 === 0) {
          publish({ ...(await repo.vectorStatus(ACTIVE_VECTOR_SPACE)),
            perChunkMs: Math.round((Date.now() - started) / jobs.length) });
        }
      } catch (error) {
        if (aborter.signal.aborted) {
          await repo.releaseVectorJobs(ACTIVE_VECTOR_SPACE, jobs).catch(() => undefined);
          break;
        }
        // Retry is bounded and persisted; no hot-loop or loss on process death.
        await repo.failVectorJobs(ACTIVE_VECTOR_SPACE, jobs).catch(() => undefined);
        throw error;
      }
      if (batch === 1999) again = true; // bounded work per invocation
    }
    if (!aborter.signal.aborted) publish(await repo.vectorStatus(ACTIVE_VECTOR_SPACE));
  } catch (e) {
    if (!aborter.signal.aborted) {
      publish({ error: String((e as Error)?.message || e) });
      retryDelay = 10_000;
    }
  } finally {
    unsubscribe();
    current = null;
    publish({ running: false });
    if (!aborter.signal.aborted && localMemorySessionUnlocked()) {
      if (again) scheduleVectors(profile, 1000);
      else if (retryDelay !== null) scheduleVectors(profile, retryDelay);
    }
  }
}
