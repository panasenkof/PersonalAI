import React from "react";
export function useAuth() { return { offlineMode: true, ready: true, me: null, closeOffline: async () => {}, apiBase: "", logout: async () => {} }; }
export function AuthProvider({ children }: { children: React.ReactNode }) { return <>{children}</>; }
