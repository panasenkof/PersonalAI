import { scheduleIndexTerms, resetIndexTermsRunner, getEnrichState, setIndexTermsEnabled } from "../enrich-runner";
import { enrichPending } from "../enrich";
import { localMemoryRepository } from "../../local-memory/repository";

let mockUnlocked = true;
const mockListeners = new Set<(unlocked: boolean) => void>();
jest.mock("expo-secure-store", () => ({ getItemAsync: async () => "on", setItemAsync: async () => {} }));
jest.mock("../../local-memory/storage", () => ({
  localMemorySessionUnlocked: () => mockUnlocked,
  onLocalMemorySessionChange: (listener: (value: boolean) => void) => { mockListeners.add(listener); return () => mockListeners.delete(listener); },
}));
jest.mock("../../local-memory/repository", () => ({ localMemoryRepository: jest.fn() }));
jest.mock("../enrich", () => ({
  MODEL_TERMS_SOURCE: "model:auto", canEnrich: () => true, indexTermsModel: (settings: unknown) => settings, enrichPending: jest.fn(),
}));
jest.mock("../settings", () => ({
  ...jest.requireActual("../settings"),
  loadDirectConnections: async () => ({ activeId: "a", connections: [{ id: "a", name: "test", model: "test-model" }] }),
}));

beforeEach(() => { jest.useFakeTimers(); resetIndexTermsRunner(); jest.clearAllMocks(); mockUnlocked = true; mockListeners.clear(); });
afterEach(() => { resetIndexTermsRunner(); jest.useRealTimers(); });

test.each(["lock", "disable", "profile"])("%s cancels the old pass and does not reopen its database for status", async reason => {
  const oldRepo = { indexTermsStatus: jest.fn(async () => ({ done: 0, pending: 1 })) };
  const newRepo = { indexTermsStatus: jest.fn(async () => ({ done: 0, pending: 0 })) };
  (localMemoryRepository as jest.Mock).mockImplementation(async profile => profile === "old" ? oldRepo : newRepo);
  let finish!: () => void;
  let signal!: AbortSignal;
  (enrichPending as jest.Mock).mockImplementationOnce(async (_repo, _settings, options) => {
    signal = options.signal;
    await new Promise<void>(resolve => { finish = resolve; });
    return { done: 0, failed: 0 };
  }).mockResolvedValue({ done: 0, failed: 0 });
  scheduleIndexTerms("old", 0); await jest.advanceTimersByTimeAsync(0);
  expect(getEnrichState().running).toBe(true);
  if (reason === "lock") { mockUnlocked = false; mockListeners.forEach(l => l(false)); }
  if (reason === "disable") await setIndexTermsEnabled(false);
  if (reason === "profile") scheduleIndexTerms("new", 0);
  expect(signal.aborted).toBe(true);
  finish(); await jest.advanceTimersByTimeAsync(1);
  expect(oldRepo.indexTermsStatus).not.toHaveBeenCalled();
  if (reason === "profile") {
    expect(localMemoryRepository).toHaveBeenCalledWith("new");
    expect(newRepo.indexTermsStatus).toHaveBeenCalledTimes(1);
  }
  expect(getEnrichState().running).toBe(false);
});
