/** Background vectors of memory chunks (п. 13): after the model is downloaded,
 * after a record is saved and on app start. Batches of 16 chunks; stops when
 * the app locks, on an error, or when the model is deleted. Computed on the
 * phone, so every section is indexed — «Документы» included. */
import { useSyncExternalStore } from "react";
import { localMemoryRepository } from "../local-memory/repository";
import { localMemorySessionUnlocked, onLocalMemorySessionChange } from "../local-memory/storage";
import { embedTexts, embedderReady, verifiedVectorSpace } from "./embedder";

export type VectorState = { running: boolean; done: number; total: number; error: string; perChunkMs?: number };
let state: VectorState = { running: false, done: 0, total: 0, error: "" };
const listeners = new Set<() => void>();
const publish = (patch: Partial<VectorState>) => { state = { ...state, ...patch }; listeners.forEach(l => l()); };
export const getVectorState = () => state;
export function useVectorState(): VectorState {
  return useSyncExternalStore(l => { listeners.add(l); return () => { listeners.delete(l); }; }, getVectorState, getVectorState);
}

export async function refreshVectorStatus(profile: string): Promise<void> {
  try {
    if (!(await embedderReady())) return;
    const space = await verifiedVectorSpace();
    publish(await (await localMemoryRepository(profile)).vectorStatus(space));
  } catch { /* locked, absent or unverified model: normal lexical search remains */ }
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
    // The exact SHA-256-identified namespace is shared with foreground queries.
    // Verify before claiming work; a tampered model cannot complete jobs.
    const space = await verifiedVectorSpace();
    const repo = await localMemoryRepository(profile);
    publish(await repo.vectorStatus(space));
    // Four chunks per native batch bound the time a foreground semantic query
    // waits behind background indexing on the shared on-device embedder.
    for (let batch = 0; batch < 2000 && !aborter.signal.aborted; batch++) {
      again = false;
      const jobs = await repo.claimVectorJobs(space, 4);
      if (!jobs.length) {
        const wake = await repo.nextVectorWakeMs(space);
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
          await repo.releaseVectorJobs(space, jobs).catch(() => undefined);
          break;
        }
        await repo.completeVectorJobs(space,
          jobs.map((job, i) => ({ job, vector: vectors[i] })));
        if (batch % 8 === 0) {
          publish({ ...(await repo.vectorStatus(space)),
            perChunkMs: Math.round((Date.now() - started) / jobs.length) });
        }
      } catch (error) {
        if (aborter.signal.aborted) {
          await repo.releaseVectorJobs(space, jobs).catch(() => undefined);
          break;
        }
        // Retry is bounded and persisted; no hot-loop or loss on process death.
        await repo.failVectorJobs(space, jobs).catch(() => undefined);
        throw error;
      }
      if (batch === 1999) again = true; // bounded work per invocation
    }
    if (!aborter.signal.aborted) publish(await repo.vectorStatus(space));
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
