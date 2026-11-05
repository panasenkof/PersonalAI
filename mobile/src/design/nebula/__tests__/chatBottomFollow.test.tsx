import { act, renderHook } from "@testing-library/react-native";
import { useChatBottomFollow } from "../useChatBottomFollow";

const metrics = (y: number, content = 1600, viewport = 600) => ({ contentOffset: { y }, contentSize: { height: content }, layoutMeasurement: { height: viewport } });
describe("single-owner chat viewport", () => {
  let frames: Map<number, FrameRequestCallback>;
  let next: number;
  beforeEach(() => {
    frames = new Map(); next = 0;
    jest.spyOn(global, "requestAnimationFrame").mockImplementation(fn => { frames.set(++next, fn); return next; });
    jest.spyOn(global, "cancelAnimationFrame").mockImplementation(id => { if (id != null) frames.delete(id); });
  });
  afterEach(() => jest.restoreAllMocks());
  const flush = () => act(() => { const batch = [...frames.values()]; frames.clear(); batch.forEach(fn => fn(0)); });
  function setup() {
    const hook = renderHook(({ id, focused, turn }: { id: string; focused: boolean; turn: string }) => useChatBottomFollow(id, focused, turn),
      { initialProps: { id: "a", focused: true, turn: "u1" } });
    const scrollToOffset = jest.fn();
    hook.result.current.list.current = { scrollToOffset } as any;
    act(() => { hook.result.current.onViewport(600); hook.result.current.onContent(390, 1600); });
    flush(); scrollToOffset.mockClear();
    return { ...hook, scrollToOffset };
  }
  it("never scrolls empty artwork when focus, clear or IME changes its size", () => {
    const { result } = renderHook(() => useChatBottomFollow("empty", true, undefined, false));
    const scrollToOffset = jest.fn(); result.current.list.current = { scrollToOffset } as any;
    act(() => { result.current.onViewport(300); result.current.onContent(390, 800); }); flush();
    act(() => { result.current.onViewport(600); result.current.onContent(390, 900); }); flush();
    expect(scrollToOffset).not.toHaveBeenCalled();
  });
  it("coalesces content changes and cancels a queued command on a finger gesture", () => {
    const { result, scrollToOffset } = setup();
    act(() => { result.current.onContent(390, 1700); result.current.onContent(390, 1800); }); flush();
    expect(scrollToOffset).toHaveBeenCalledTimes(1);
    expect(scrollToOffset).toHaveBeenLastCalledWith({ offset: 1200, animated: false });
    act(() => { result.current.onContent(390, 1900); result.current.beginDrag(); }); flush();
    expect(scrollToOffset).toHaveBeenCalledTimes(1);
  });
  it("keeps the latest message visible on every IME viewport change without content changes", () => {
    const { result, scrollToOffset } = setup();
    act(() => result.current.onViewport(300)); flush();
    expect(scrollToOffset).toHaveBeenLastCalledWith({ offset: 1300, animated: false });
    act(() => result.current.onViewport(600)); flush();
    expect(scrollToOffset).toHaveBeenLastCalledWith({ offset: 1000, animated: false });
  });
  it("follows a streamed answer to its end instead of holding at the question", () => {
    const { result, rerender, scrollToOffset } = setup();
    rerender({ id: "a", focused: true, turn: "u2" });
    act(() => result.current.onContent(390, 2600)); flush();
    expect(scrollToOffset).toHaveBeenLastCalledWith({ offset: 2000, animated: false });
    act(() => result.current.onContent(390, 3100)); flush();
    expect(scrollToOffset).toHaveBeenLastCalledWith({ offset: 2500, animated: false });
    expect(result.current.showJumpToLatest).toBe(false);
  });
  it("holds a manual reading position through stream, IME and tab changes", () => {
    const { result, rerender, scrollToOffset } = setup();
    act(() => { result.current.beginDrag(); result.current.endDrag(metrics(200)); result.current.onContent(390, 2200); result.current.onViewport(300); }); flush();
    rerender({ id: "a", focused: false, turn: "u1" });
    rerender({ id: "a", focused: true, turn: "u1" }); flush();
    expect(scrollToOffset).not.toHaveBeenCalled();
    act(() => result.current.jumpToLatest()); flush();
    expect(scrollToOffset).toHaveBeenLastCalledWith({ offset: 1900, animated: false });
    expect(result.current.showJumpToLatest).toBe(false);
  });
  it("a new question returns to following from a reading position", () => {
    const { result, rerender, scrollToOffset } = setup();
    act(() => { result.current.beginDrag(); result.current.endDrag(metrics(100)); }); flush();
    rerender({ id: "a", focused: true, turn: "u2" }); flush();
    act(() => result.current.onContent(390, 1800)); flush();
    expect(scrollToOffset).toHaveBeenLastCalledWith({ offset: 1200, animated: false });
  });
  it("new chat resets metrics and follows only its own layout", () => {
    const { result, rerender, scrollToOffset } = setup();
    rerender({ id: "b", focused: true, turn: "b1" }); flush();
    expect(scrollToOffset).not.toHaveBeenCalled();
    act(() => { result.current.onViewport(600); result.current.onContent(390, 900); }); flush();
    expect(scrollToOffset).toHaveBeenLastCalledWith({ offset: 300, animated: false });
  });
  it("never scrolls in background or after unmount", () => {
    const { result, rerender, unmount, scrollToOffset } = setup();
    act(() => result.current.onContent(390, 1800));
    rerender({ id: "a", focused: false, turn: "u1" }); flush();
    act(() => result.current.onContent(390, 2000)); flush();
    expect(scrollToOffset).not.toHaveBeenCalled();
    rerender({ id: "a", focused: true, turn: "u1" }); unmount(); flush();
    expect(scrollToOffset).not.toHaveBeenCalled();
  });
  it("resumes following only on a deliberate return to the bottom", () => {
    const { result, scrollToOffset } = setup();
    act(() => { result.current.beginDrag(); result.current.endDrag(metrics(1000)); result.current.onContent(390, 1800); }); flush();
    expect(scrollToOffset).toHaveBeenLastCalledWith({ offset: 1200, animated: false });
  });
});
