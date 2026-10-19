import { act, renderHook } from "@testing-library/react-native";
import type { DirectChatStore } from "../chat-store";
import { normalizeDraft } from "../normalize-draft";
import { defaultDirectPreferences } from "../settings";
import { useDraftNormalization } from "../use-draft-normalization";

jest.mock("expo-crypto", () => ({ randomUUID: () => "normalization-turn" }));
jest.mock("../diagnostics", () => ({ diagnosticTrace: () => jest.fn() }));
jest.mock("../normalize-draft", () => ({ normalizeDraft: jest.fn() }));
const normalize = normalizeDraft as jest.Mock;
const settings = { ...defaultDirectPreferences, apiKey: "test", webSearchKey: "" };

function fixture() {
  let activeId = "first";
  const questions: Record<string, string> = { first: "  купить молоко  ", second: "другой черновик" };
  const listeners = new Set<() => void>();
  const publish = () => listeners.forEach(fn => fn());
  const store = {
    getSnapshot: () => ({ ready: true, activeId, conversations: Object.entries(questions).map(([id, question]) => ({ id, question })) }),
    subscribe: (fn: () => void) => { listeners.add(fn); return () => { listeners.delete(fn); }; },
    setQuestion: jest.fn((text: string) => { questions[activeId] = text; publish(); }),
  } as unknown as DirectChatStore;
  return { store, select: (id: string) => { activeId = id; publish(); }, text: () => store.getSnapshot().conversations.find(c => c.id === activeId)!.question };
}
function deferred() {
  let resolve!: (text: string) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<string>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
beforeEach(() => { jest.clearAllMocks(); });

test("a user can improve, restore the exact original and reapply without another paid request", async () => {
  const f = fixture(); const notice = jest.fn();
  normalize.mockResolvedValueOnce("Купить молоко.");
  const { result } = renderHook(() => useDraftNormalization(f.store, "profile", notice));
  await act(async () => { await result.current.toggle(settings); });
  expect(f.text()).toBe("Купить молоко."); expect(result.current.normalized).toBe(true);
  await act(async () => { await result.current.toggle(null); });
  expect(f.text()).toBe("  купить молоко  "); expect(result.current.alternate).toBe(true);
  await act(async () => { await result.current.toggle(settings); });
  expect(f.text()).toBe("Купить молоко."); expect(normalize).toHaveBeenCalledTimes(1);
});

test.each(["edit", "edit-and-revert", "clear", "send", "switch-and-return"])("late output cannot overwrite a draft after %s", async action => {
  const f = fixture(); const pending = deferred(); normalize.mockReturnValueOnce(pending.promise);
  const { result } = renderHook(() => useDraftNormalization(f.store, "profile", jest.fn()));
  let running!: Promise<void>;
  act(() => { running = result.current.toggle(settings); });
  const signal = normalize.mock.calls[0][2].signal as AbortSignal;
  act(() => {
    if (action === "edit") f.store.setQuestion("ручная правка");
    else if (action === "edit-and-revert") { f.store.setQuestion("правка"); f.store.setQuestion("  купить молоко  "); }
    else if (action === "switch-and-return") { f.select("second"); f.select("first"); }
    else f.store.setQuestion("");
  });
  const before = f.text();
  expect(signal.aborted).toBe(true);
  await act(async () => { pending.resolve("Купить молоко."); await running; });
  expect(f.text()).toBe(before); expect(result.current.alternate).toBe(false); expect(result.current.busy).toBe(false);
});

test("the same action cancels an in-flight correction; a later failure stays silent", async () => {
  const f = fixture(); const pending = deferred(); normalize.mockReturnValueOnce(pending.promise); const notice = jest.fn();
  const { result } = renderHook(() => useDraftNormalization(f.store, "profile", notice));
  let running!: Promise<void>;
  act(() => { running = result.current.toggle(settings); });
  expect(result.current.busy).toBe(true);
  await act(async () => { await result.current.toggle(settings); });
  expect(result.current.busy).toBe(false);
  await act(async () => { pending.reject(new Error("late failure")); await running; });
  expect(f.text()).toBe("  купить молоко  ");
  expect(notice).not.toHaveBeenCalledWith(expect.stringContaining("late failure"));
});

test("manual edits discard the alternate; a new click corrects the edited text", async () => {
  const f = fixture(); normalize.mockResolvedValueOnce("Купить молоко.").mockResolvedValueOnce("Купить хлеб.");
  const { result } = renderHook(() => useDraftNormalization(f.store, "profile", jest.fn()));
  await act(async () => { await result.current.toggle(settings); });
  act(() => f.store.setQuestion("купить хлеб"));
  expect(result.current.alternate).toBe(false);
  await act(async () => { await result.current.toggle(settings); });
  expect(f.text()).toBe("Купить хлеб."); expect(normalize).toHaveBeenCalledTimes(2);
});

test("a failed correction keeps the original and allows a retry", async () => {
  const f = fixture(); const notice = jest.fn(); normalize.mockRejectedValueOnce(new Error("нет сети"));
  const { result } = renderHook(() => useDraftNormalization(f.store, "profile", notice));
  await act(async () => { await result.current.toggle(settings); });
  expect(f.text()).toBe("  купить молоко  "); expect(result.current.busy).toBe(false);
  expect(notice).toHaveBeenCalledWith(expect.stringContaining("нет сети"));
});

test("new dictation explicitly invalidates the old correction before any transcript arrives", async () => {
  const f = fixture(); const pending = deferred(); normalize.mockReturnValueOnce(pending.promise);
  const { result } = renderHook(() => useDraftNormalization(f.store, "profile", jest.fn()));
  let running!: Promise<void>;
  act(() => { running = result.current.toggle(settings); });
  act(() => result.current.reset());
  await act(async () => { pending.resolve("Купить молоко."); await running; });
  expect(f.text()).toBe("  купить молоко  "); expect(result.current.alternate).toBe(false);
});

test("unmount aborts the operation and a late result never changes the store", async () => {
  const f = fixture(); const pending = deferred(); normalize.mockReturnValueOnce(pending.promise);
  const { result, unmount } = renderHook(() => useDraftNormalization(f.store, "profile", jest.fn()));
  let running!: Promise<void>;
  act(() => { running = result.current.toggle(settings); });
  const signal = normalize.mock.calls[0][2].signal as AbortSignal;
  unmount(); expect(signal.aborted).toBe(true);
  await act(async () => { pending.resolve("Купить молоко."); await running; });
  expect(f.store.setQuestion).not.toHaveBeenCalled();
});
