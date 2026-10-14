import React, { createContext, useContext, useEffect, useMemo, useSyncExternalStore } from "react";
import { useProfile } from "../profile/ProfileContext";
import { DirectChatStore } from "./chat-store";

const ChatContext = createContext<DirectChatStore | null>(null);
export function DirectChatProvider({ children }: { children: React.ReactNode }) {
  const profile = useProfile();
  const store = useMemo(() => new DirectChatStore(profile), [profile]);
  useEffect(() => {
    void store.initialize();
    return () => store.dispose();
  }, [store]);
  return <ChatContext.Provider value={store}>{children}</ChatContext.Provider>;
}
export function useDirectChat() {
  const store = useContext(ChatContext);
  if (!store) throw new Error("DirectChatProvider missing");
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  return { store, ...snapshot, active: snapshot.conversations.find(c => c.id === snapshot.activeId) };
}
