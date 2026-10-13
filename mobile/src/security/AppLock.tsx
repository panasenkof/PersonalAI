import * as LocalAuthentication from "expo-local-authentication";
import React, { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, AppState, Linking, Pressable, Text, View } from "react-native";
import { FloatingBrand } from "../components/FloatingBrand";
import { onApplicationLockRequest, withBiometricPrompt } from "../local-memory/authentication";
import { shouldLockLocalMemory } from "../local-memory/lifecycle";
import { nativeInteractionActive, onNativeInteractionEnd } from "./native-interaction";
import { savedMemoryProfile } from "./active-profile";
import { authenticateExistingMemory, authorizeLocalMemorySession, revokeLocalMemorySession, closeLocalMemory } from "../local-memory/storage";
import { useTheme } from "../theme";

/** One application boundary owns background locking. The authenticated tree is
 * unmounted on a real background transition, removing chats, drafts and keys.
 * Inactive/Android blur shows a cover without interrupting the biometric sheet.
 */
export function AppLock({ children }: { children: React.ReactNode }) {
  const t = useTheme();
  const [unlocked, setUnlocked] = useState(false);
  const [covered, setCovered] = useState(AppState.currentState !== "active");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const authenticating = useRef(false);
  const alive = useRef(true);
  const epoch = useRef(0);
  const closing = useRef<Promise<void>>(Promise.resolve());
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
      if (result.success && AppState.currentState === "active") { authorizeLocalMemorySession(); setCovered(false); setUnlocked(true); }
      else setNotice("Вход не подтверждён. Нажмите «Разблокировать», чтобы повторить.");
    } catch { if (alive.current) setNotice("Не удалось разблокировать приложение. Повторите вход."); }
    finally { authenticating.current = false; if (alive.current) setBusy(false); }
  }, []);
  useEffect(() => {
    alive.current = true;
    void unlock();
    const app = AppState.addEventListener("change", state => {
      setCovered(state !== "active" || nativeInteractionActive());
      if (shouldLockLocalMemory(state)) {
        epoch.current++; revokeLocalMemorySession(); setUnlocked(false);
        closing.current = closeLocalMemory();
        void closing.current.catch(() => { if (alive.current) setNotice("Не удалось закрыть память. Повторите вход."); });
      }
    });
    const requested = onApplicationLockRequest(() => {
      epoch.current++; revokeLocalMemorySession(); setUnlocked(false);
      setNotice("Для обновления защиты этого профиля войдите в приложение. Заметки сохранятся.");
      closing.current = closeLocalMemory(); void closing.current.catch(() => {});
    });
    const native = onNativeInteractionEnd(success => {
      setCovered(AppState.currentState !== "active");
      if (!success) { epoch.current++; revokeLocalMemorySession(); setUnlocked(false); closing.current = closeLocalMemory(); void closing.current.catch(() => {}); }
    });
    const blur = AppState.addEventListener("blur", () => setCovered(true));
    const focus = AppState.addEventListener("focus", () => { if (AppState.currentState === "active" && !nativeInteractionActive()) setCovered(false); });
    return () => { revokeLocalMemorySession(); alive.current = false; app.remove(); blur.remove(); focus.remove(); native(); requested(); };
  }, [unlock]);
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
  return <View style={{ flex: 1 }}>{unlocked ? <View style={{ flex: 1 }} pointerEvents={covered ? "none" : "auto"} accessibilityElementsHidden={covered} importantForAccessibility={covered ? "no-hide-descendants" : "auto"}>{children}</View> : lockScreen}
    {unlocked && covered ? <View style={{ position: "absolute", top: 0, left: 0, right: 0, bottom: 0, backgroundColor: t.bg }} accessibilityViewIsModal>
      <View style={{ flex: 1, alignItems: "center", justifyContent: "center" }}><Text style={{ color: t.text, fontSize: 26, fontWeight: "700" }}>PersAI · Защищено</Text></View>
    </View> : null}
  </View>;
}
