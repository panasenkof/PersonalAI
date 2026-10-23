import { useCallback, useLayoutEffect, useRef } from "react";
import type { FlatList } from "react-native";
import type { ChatRow } from "../../direct-agent/conversations";

/** UI lifetime only. Leaving Home never stops the underlying LLM request. */
export function useChatBottomFollow(conversationId: string | undefined, focused: boolean) {
  const list = useRef<FlatList<ChatRow>>(null);
  const nearChatBottom = useRef(true);
  // Programmatic scroll/IME resize is not a user gesture: it must not disable follow.
  const userScrollActive = useRef(false);
  const pendingSendFollow = useRef(false);
  const scrollFrame = useRef<number | null>(null);
  const enabled = useRef(false);
  const previousConversation = useRef(conversationId);
  const scheduleBottomFollow = useCallback(() => {
    if (!enabled.current || scrollFrame.current !== null) return;
    scrollFrame.current = requestAnimationFrame(() => {
      scrollFrame.current = null;
      if (enabled.current && (pendingSendFollow.current || nearChatBottom.current)) {
        list.current?.scrollToEnd({ animated: false });
      }
    });
  }, []);
  useLayoutEffect(() => {
    enabled.current = focused;
    if (previousConversation.current !== conversationId) {
      previousConversation.current = conversationId;
      nearChatBottom.current = true;
      userScrollActive.current = false;
    }
    // The same conversation keeps its reading position across tabs; a newly
    // selected one opens at its latest messages with independent list metrics.
    if (focused && nearChatBottom.current) scheduleBottomFollow();
    return () => {
      enabled.current = false;
      pendingSendFollow.current = false;
      userScrollActive.current = false;
      if (scrollFrame.current !== null) cancelAnimationFrame(scrollFrame.current);
      scrollFrame.current = null;
    };
  }, [conversationId, focused, scheduleBottomFollow]);
  return { list, nearChatBottom, pendingSendFollow, userScrollActive, scheduleBottomFollow };
}
