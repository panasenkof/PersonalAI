import React, { createContext, useContext, useEffect, useMemo, useSyncExternalStore } from "react";
import { useAuth } from "../auth/AuthContext";
import { DirectChatStore } from "./chat-store";

const ChatContext = createContext<DirectChatStore | null>(null);
export function DirectChatProvider({ children }: { children: React.ReactNode }) {
  const { me, offlineMode } = useAuth();
  const profile = offlineMode ? "guest" : me?.id;
  const store = useMemo(() => profile ? new DirectChatStore(profile) : null, [profile]);
  useEffect(() => {
    if (store) void store.initialize();
    return () => store?.dispose();
  }, [store]);
  return <ChatContext.Provider value={store}>{children}</ChatContext.Provider>;
}
export function useDirectChat() {
  const store = useContext(ChatContext);
  if (!store) throw new Error("DirectChatProvider missing");
  const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  return { store, ...snapshot, active: snapshot.conversations.find(c => c.id === snapshot.activeId) };
}
