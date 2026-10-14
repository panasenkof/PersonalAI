import * as LocalAuthentication from "expo-local-authentication";
import React, { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, AppState, Linking, Pressable, Text, View } from "react-native";
import { FloatingBrand } from "../components/FloatingBrand";
import { onApplicationLockRequest, withBiometricPrompt } from "../local-memory/authentication";
import { biometricPromptActive } from "../local-memory/authentication";
import { APP_SESSION_TIMEOUT_MS, sessionExpired, sessionNow } from "./session";
import type { SessionTimestamp } from "./session";
import { nativeInteractionActive, onNativeInteractionEnd } from "./native-interaction";
import { savedMemoryProfile } from "./active-profile";
import { authenticateExistingMemory, authorizeLocalMemorySession, revokeLocalMemorySession, closeLocalMemory } from "../local-memory/storage";
import { useTheme } from "../theme";
import { ApplicationVisibility, applicationModalActive } from "./visibility";

/** One application boundary owns the session. Keep work mounted behind an
 * opaque privacy cover; briefly switching apps never destroys chats or jobs.
 */
export function AppLock({ children }: { children: React.ReactNode }) {
  const t = useTheme();
  const [unlocked, setUnlocked] = useState(false);
  const [opened, setOpened] = useState(false);
  const [covered, setCovered] = useState(AppState.currentState !== "active");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const authenticating = useRef(false);
  const sessionUnlocked = useRef(false);
  const alive = useRef(true);
  const epoch = useRef(0);
  const closing = useRef<Promise<void>>(Promise.resolve());
  const leftAt = useRef<SessionTimestamp | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lock = useCallback(() => {
    if (!sessionUnlocked.current) return;
    sessionUnlocked.current = false;
    epoch.current++; revokeLocalMemorySession(); setUnlocked(false); setCovered(true);
    closing.current = closeLocalMemory();
    void closing.current.catch(() => { if (alive.current) setNotice("Не удалось завершить сеанс. Повторите вход."); });
  }, []);
  const unlock = useCallback(async () => {
    if (authenticating.current || AppState.currentState !== "active") return;
    authenticating.current = true; setBusy(true); setNotice("");
    const requestEpoch = epoch.current;
    try {
      try { await closing.current; } catch { closing.current = closeLocalMemory(); await closing.current; }
      if (!(await LocalAuthentication.hasHardwareAsync()) || !(await LocalAuthentication.isEnrolledAsync())) {
        setNotice("Настройте отпечаток пальца или распознавание лица в настройках телефона, затем повторите вход."); return;
      }
      const migratedUnlock = await authenticateExistingMemory(await savedMemoryProfile());
      const result = migratedUnlock ? { success: true } : await withBiometricPrompt(() => LocalAuthentication.authenticateAsync({
        promptMessage: "Войти в PersAI", cancelLabel: "Отмена", disableDeviceFallback: true,
        biometricsSecurityLevel: "strong", fallbackLabel: "",
      }));
      if (!alive.current || requestEpoch !== epoch.current) return;
      if (result.success && AppState.currentState === "active") {
        leftAt.current = null;
        if (timer.current) clearTimeout(timer.current);
        sessionUnlocked.current = true;
        authorizeLocalMemorySession(); setCovered(false); setUnlocked(true); setOpened(true);
      }
      else setNotice("Вход не подтверждён. Нажмите «Разблокировать», чтобы повторить.");
    } catch { if (alive.current) setNotice("Не удалось разблокировать приложение. Повторите вход."); }
    finally { authenticating.current = false; if (alive.current) setBusy(false); }
  }, []);
  useEffect(() => {
    alive.current = true;
    void unlock();
    const app = AppState.addEventListener("change", state => {
      if (state !== "active") {
        setCovered(true);
        // A biometric sheet can transiently inactivate its own Activity.
        if (!biometricPromptActive() && leftAt.current === null) {
          leftAt.current = sessionNow();
          timer.current = setTimeout(() => { if (sessionExpired(leftAt.current)) lock(); }, APP_SESSION_TIMEOUT_MS);
        }
      } else {
        if (sessionExpired(leftAt.current)) lock();
        leftAt.current = null;
        if (timer.current) clearTimeout(timer.current);
        setCovered(nativeInteractionActive());
      }
    });
    const requested = onApplicationLockRequest(() => {
      lock();
      setNotice("Для обновления защиты этого профиля войдите в приложение. Заметки сохранятся.");
    });
    const native = onNativeInteractionEnd(() => {
      if (sessionExpired(leftAt.current)) lock();
      setCovered(AppState.currentState !== "active");
    });
    const blur = AppState.addEventListener("blur", () => {
      // Our Modal is a different Android window, not a departure from the app.
      // Unmounting it here restores Activity focus, remounts it, and loops forever.
      if (!applicationModalActive()) setCovered(true);
    });
    const focus = AppState.addEventListener("focus", () => { if (AppState.currentState === "active" && !nativeInteractionActive()) setCovered(false); });
    return () => { if (timer.current) clearTimeout(timer.current); revokeLocalMemorySession(); alive.current = false; app.remove(); blur.remove(); focus.remove(); native(); requested(); };
  }, [unlock, lock]);
  const lockScreen = (
    <View style={{ flex: 1, backgroundColor: t.bg, justifyContent: "center", alignItems: "center", padding: 28, gap: 18 }}>
      <FloatingBrand size={144} motion={false} />
      <Text style={{ color: t.text, fontSize: 30, fontWeight: "800" }}>PersAI</Text>
      <Text style={{ color: t.muted, textAlign: "center", lineHeight: 22 }}>Ваш личный помощник. Вход защищён биометрией телефона.</Text>
      {busy ? <ActivityIndicator accessibilityLabel="Проверка биометрии" /> : <Pressable accessibilityRole="button" accessibilityLabel="Разблокировать приложение"
        style={{ minHeight: 52, minWidth: 230, alignItems: "center", justifyContent: "center", backgroundColor: t.accent, borderRadius: 18 }} onPress={() => void unlock()}>
        <Text style={{ color: "#fff", fontWeight: "700" }}>Разблокировать</Text>
      </Pressable>}
      {notice ? <Text accessibilityRole="alert" style={{ color: t.err, textAlign: "center" }}>{notice}</Text> : null}
      <Pressable accessibilityRole="button" onPress={() => void Linking.openSettings().catch(() => setNotice("Откройте настройки телефона и настройте биометрию."))} style={{ minHeight: 44, justifyContent: "center" }}>
        <Text style={{ color: t.accent }}>Настройки телефона</Text>
      </Pressable>
    </View>
  );
  const hidden = !unlocked || covered;
  return <View style={{ flex: 1 }}>{opened ? <View style={{ flex: 1 }} pointerEvents={hidden ? "none" : "auto"} accessibilityElementsHidden={hidden} importantForAccessibility={hidden ? "no-hide-descendants" : "auto"}><ApplicationVisibility.Provider value={!hidden}>{children}</ApplicationVisibility.Provider></View> : null}
    {hidden ? <View style={{ position: opened ? "absolute" : "relative", flex: 1, top: 0, left: 0, right: 0, bottom: 0, backgroundColor: t.bg }} accessibilityViewIsModal>
      {!unlocked ? lockScreen : <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}><Text style={{ color: t.text, fontSize: 26, fontWeight: "700" }}>PersAI · Защищено</Text></View>}
    </View> : null}
  </View>;
}
