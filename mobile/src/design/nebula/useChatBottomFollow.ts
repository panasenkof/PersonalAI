import { useCallback, useLayoutEffect, useRef, useState } from "react";
import type { FlatList } from "react-native";
import type { PresentedChatRow } from "./chatPresentation";
import { isNebulaChatNearBottom } from "./homeArtLayout";

type Mode = "latest" | "reading";
type Metrics = { contentOffset: { y: number }; contentSize: { height: number }; layoutMeasurement: { height: number } };
/** One owner for every scroll command. IME events never switch the reading mode.
 * Owner decision 05.11.2026: a submitted turn follows the answer to its end, so a
 * streamed answer is never left hidden below the fold. The reader keeps control
 * from the first manual scroll until a deliberate return to the bottom.
 */
export function useChatBottomFollow(conversationId: string | undefined, focused: boolean, turnId?: string, hasRows = true) {
  const list = useRef<FlatList<PresentedChatRow>>(null);
  const state = useRef({ mode: "latest" as Mode, content: 0, viewport: 0, offset: 0,
    gesture: false, enabled: focused, turnId });
  const contentPresent = useRef(hasRows);
  contentPresent.current = hasRows;
  const frame = useRef<number | null>(null);
  const [showJumpToLatest, setShowJumpToLatest] = useState(false);
  const cancel = useCallback(() => {
    if (frame.current !== null) cancelAnimationFrame(frame.current);
    frame.current = null;
  }, []);
  const schedule = useCallback(() => {
    if (!state.current.enabled || frame.current !== null) return;
    frame.current = requestAnimationFrame(() => {
      frame.current = null;
      const s = state.current;
      if (!s.enabled || s.gesture || s.viewport <= 0 || !contentPresent.current) return;
      if (s.mode === "latest") {
        const bottom = Math.max(0, s.content - s.viewport);
        if (Math.abs(bottom - s.offset) > 1) {
          list.current?.scrollToOffset({ offset: bottom, animated: false });
          s.offset = bottom;
        }
      }
      setShowJumpToLatest(!isNebulaChatNearBottom(s.content, s.offset, s.viewport));
    });
  }, []);
  useLayoutEffect(() => {
    cancel();
    Object.assign(state.current, { mode: "latest", content: 0, viewport: 0, offset: 0, gesture: false, turnId });
    setShowJumpToLatest(false);
  }, [conversationId, cancel]);
  useLayoutEffect(() => {
    const s = state.current;
    if (s.turnId !== turnId) {
      // A new question always returns to following; the reading position of a
      // previous turn is not inherited.
      s.turnId = turnId; s.mode = "latest"; s.gesture = false;
      schedule();
      setShowJumpToLatest(false);
    }
  }, [turnId, schedule]);
  useLayoutEffect(() => {
    state.current.enabled = focused;
    if (focused) schedule();
    return () => { state.current.enabled = false; state.current.gesture = false; cancel(); };
  }, [conversationId, focused, cancel, schedule]);
  const onViewport = useCallback((height: number) => { state.current.viewport = height; schedule(); }, [schedule]);
  const onContent = useCallback((_width: number, height: number) => { state.current.content = height; schedule(); }, [schedule]);
  const beginDrag = useCallback(() => {
    cancel(); state.current.gesture = true; state.current.mode = "reading";
  }, [cancel]);
  const onScroll = useCallback((metrics: Metrics) => {
    const s = state.current;
    s.offset = metrics.contentOffset.y;
    // Native offsets update geometry, but only fingers express reading intent.
    if (s.gesture) setShowJumpToLatest(!isNebulaChatNearBottom(metrics.contentSize.height, s.offset, metrics.layoutMeasurement.height));
  }, []);
  const endDrag = useCallback((metrics: Metrics) => {
    onScroll(metrics);
    const s = state.current;
    s.gesture = false;
    s.mode = isNebulaChatNearBottom(metrics.contentSize.height, metrics.contentOffset.y, metrics.layoutMeasurement.height) ? "latest" : "reading";
  }, [onScroll]);
  const jumpToLatest = useCallback(() => {
    state.current.mode = "latest"; state.current.gesture = false; schedule();
  }, [schedule]);
  return { list, showJumpToLatest, onViewport, onContent, beginDrag, onScroll, endDrag, jumpToLatest };
}
