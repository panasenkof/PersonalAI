import { useCallback, useLayoutEffect, useRef, useState } from "react";
import type { FlatList } from "react-native";
import type { PresentedChatRow } from "./chatPresentation";
import { isNebulaChatNearBottom } from "./homeArtLayout";

type Mode = "latest" | "turn" | "reading";
type Metrics = { contentOffset: { y: number }; contentSize: { height: number }; layoutMeasurement: { height: number } };
/** One owner for every scroll command. IME events never switch the reading mode.
 * Turn mode follows up to the submitted question, then holds that reading anchor.
 */
export function useChatBottomFollow(conversationId: string | undefined, focused: boolean, turnId?: string, hasRows = true) {
  const list = useRef<FlatList<PresentedChatRow>>(null);
  const state = useRef({ mode: "latest" as Mode, content: 0, viewport: 0, offset: 0,
    gesture: false, enabled: focused, turnId, locateOffset: null as number | null, anchor: null as null | { y: number; height: number } });
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
      const bottom = Math.max(0, s.content - s.viewport);
      if (s.mode !== "reading") {
        // A long question may exceed the viewport: retain its last 30% above
        // the answer. No thresholds based on a changing streamed bubble height.
        if (s.mode === "turn" && !s.anchor) {
          // A reader may send while hundreds of virtualized rows above the end.
          // Reveal the previous tail once so the new question can be measured.
          // Use the PRE-send geometry, never the bottom of a giant first chunk.
          if (s.locateOffset !== null) {
            list.current?.scrollToOffset({ offset: s.locateOffset, animated: false });
            s.offset = s.locateOffset; s.locateOffset = null;
          }
          return;
        }
        const cap = s.anchor ? s.anchor.y + Math.max(0, s.anchor.height - s.viewport * 0.3) : bottom;
        const offset = s.mode === "turn" ? Math.min(bottom, cap) : bottom;
        if (Math.abs(offset - s.offset) > 1) {
          list.current?.scrollToOffset({ offset, animated: false });
          s.offset = offset;
        }
      }
      setShowJumpToLatest(!isNebulaChatNearBottom(s.content, s.offset, s.viewport));
    });
  }, []);
  useLayoutEffect(() => {
    cancel();
    Object.assign(state.current, { mode: "latest", content: 0, viewport: 0, offset: 0, gesture: false, anchor: null, locateOffset: null, turnId });
    setShowJumpToLatest(false);
  }, [conversationId, cancel]);
  useLayoutEffect(() => {
    const s = state.current;
    if (s.turnId !== turnId) {
      s.locateOffset = Math.max(0, s.content - s.viewport);
      s.turnId = turnId; s.anchor = null; s.mode = "turn"; s.gesture = false;
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
  const onCell = useCallback((id: string, y: number, height: number) => {
    if (id === state.current.turnId) { state.current.anchor = { y, height }; schedule(); }
  }, [schedule]);
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
  return { list, showJumpToLatest, onViewport, onContent, onCell, beginDrag, onScroll, endDrag, jumpToLatest };
}
