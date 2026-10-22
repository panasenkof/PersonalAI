import { act, renderHook } from "@testing-library/react-native";
import { useChatBottomFollow } from "../useChatBottomFollow";

describe("chat viewport lifetime", () => {
  let frames: Map<number, FrameRequestCallback>;
  let next: number;
  beforeEach(() => {
    frames = new Map(); next = 0;
    jest.spyOn(global, "requestAnimationFrame").mockImplementation(fn => { frames.set(++next, fn); return next; });
    jest.spyOn(global, "cancelAnimationFrame").mockImplementation(id => { if (id != null) frames.delete(id); });
  });
  afterEach(() => jest.restoreAllMocks());
  const flush = () => act(() => {
    const batch = [...frames.values()]; frames.clear(); batch.forEach(fn => fn(0));
  });
  function setup() {
    const hook = renderHook(({ id, focused }: { id: string; focused: boolean }) => useChatBottomFollow(id, focused),
      { initialProps: { id: "a", focused: true } });
    const scrollToEnd = jest.fn();
    hook.result.current.list.current = { scrollToEnd } as any;
    flush(); scrollToEnd.mockClear();
    return { ...hook, scrollToEnd };
  }
  it("coalesces streaming updates and lets a manual upward gesture win before the frame", () => {
    const { result, scrollToEnd } = setup();
    result.current.scheduleBottomFollow(); result.current.scheduleBottomFollow(); flush();
    expect(scrollToEnd).toHaveBeenCalledTimes(1);
    result.current.scheduleBottomFollow();
    result.current.nearChatBottom.current = false;
    flush(); expect(scrollToEnd).toHaveBeenCalledTimes(1);
  });
  it("cancels a queued Send on leaving Home and ignores later background stream updates", () => {
    const { result, rerender, scrollToEnd } = setup();
    result.current.pendingSendFollow.current = true;
    result.current.scheduleBottomFollow();
    rerender({ id: "a", focused: false });
    result.current.scheduleBottomFollow(); flush();
    expect(scrollToEnd).not.toHaveBeenCalled();
    expect(result.current.pendingSendFollow.current).toBe(false);
  });
  it("preserves reading position across tabs, but resets it for another conversation", () => {
    const { result, rerender, scrollToEnd } = setup();
    result.current.nearChatBottom.current = false;
    rerender({ id: "a", focused: false }); rerender({ id: "a", focused: true }); flush();
    expect(scrollToEnd).not.toHaveBeenCalled();
    rerender({ id: "b", focused: true }); flush();
    expect(scrollToEnd).toHaveBeenCalledWith({ animated: false });
    expect(result.current.nearChatBottom.current).toBe(true);
  });
  it("cancels a queued frame when unmounted", () => {
    const { result, unmount, scrollToEnd } = setup();
    result.current.scheduleBottomFollow(); unmount(); flush();
    expect(scrollToEnd).not.toHaveBeenCalled();
  });
});
