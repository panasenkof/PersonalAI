import * as SecureStore from "expo-secure-store";
import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";

import { api, ApiError, configureApi } from "../api/client";
import { normalizeServer } from "../ux";
import { DEFAULT_API_BASE } from "../config";
import type { Me, Tokens } from "../types";

const TOKENS_KEY = "pia.tokens";
const BASE_KEY = "pia.apiBase";

type Ctx = {
  ready: boolean;
  me: Me | null;
  apiBase: string;
  setApiBase: (url: string) => Promise<void>;
  /** Throws ApiError("otp_required") when the account has 2FA and no code was supplied. */
  login: (email: string, password: string, otp?: string) => Promise<void>;
  register: (email: string, password: string) => Promise<void>;
  changePassword: (current: string, next: string, otp?: string) => Promise<void>;
  logout: () => Promise<void>;
  refreshMe: () => Promise<void>;
};

const AuthContext = createContext<Ctx | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [ready, setReady] = useState(false);
  const [me, setMe] = useState<Me | null>(null);
  const [apiBase, setBase] = useState(DEFAULT_API_BASE);
  const tokens = useRef<Tokens | null>(null);
  const base = useRef(DEFAULT_API_BASE);

  const setTokens = useCallback(async (t: Tokens | null) => {
    tokens.current = t;
    if (t) await SecureStore.setItemAsync(TOKENS_KEY, JSON.stringify(t));
    else {
      await SecureStore.deleteItemAsync(TOKENS_KEY);
      setMe(null); // drops to the login screen
    }
  }, []);

  useEffect(() => {
    configureApi({ getBase: () => base.current, getTokens: () => tokens.current, setTokens });
    (async () => {
      const savedBase = await SecureStore.getItemAsync(BASE_KEY);
      if (savedBase) {
        base.current = savedBase;
        setBase(savedBase);
      }
      const raw = await SecureStore.getItemAsync(TOKENS_KEY);
      if (raw) {
        try { tokens.current = JSON.parse(raw) as Tokens; }
        catch { await setTokens(null); }
        try {
          setMe(await api.me());
        } catch (e) {
          // 401 → request() already cleared the session; network errors keep the tokens for a later retry
          if (e instanceof ApiError && e.status !== 401) console.warn("me() failed", e.detail);
        }
      }
      setReady(true);
    })().catch(() => setReady(true));
  }, [setTokens]);

  const refreshMe = useCallback(async () => setMe(await api.me()), []);

  const value = useMemo<Ctx>(
    () => ({
      ready,
      me,
      apiBase,
      setApiBase: async (url) => {
        const clean = normalizeServer(url);
        if (clean !== base.current) await setTokens(null);
        base.current = clean;
        setBase(clean);
        await SecureStore.setItemAsync(BASE_KEY, clean);
      },
      login: async (email, password, otp) => {
        await setTokens(await api.login(email, password, otp));
        setMe(await api.me());
      },
      register: async (email, password) => {
        const registered = await api.register(email, password);
        if (registered.email_verification_required) throw new ApiError(403, "email_not_verified");
        await setTokens(registered);
        setMe(await api.me());
      },
      changePassword: async (current, next, otp) => { await setTokens(await api.changePassword(current, next, otp)); },
      logout: async () => setTokens(null),
      refreshMe,
    }),
    [ready, me, apiBase, setTokens, refreshMe],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): Ctx {
  const c = useContext(AuthContext);
  if (!c) throw new Error("AuthProvider missing");
  return c;
}
