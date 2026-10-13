import * as LocalAuthentication from "expo-local-authentication";
import { AppState } from "react-native";
import { withBiometricPrompt } from "../local-memory/authentication";

let active = 0;
const listeners = new Set<(success: boolean) => void>();
export const nativeInteractionActive = () => active > 0;
export function onNativeInteractionEnd(listener: (success: boolean) => void) {
  listeners.add(listener); return () => { listeners.delete(listener); };
}
/** Keep a system picker/share sheet from destroying its requesting screen.
 * Hide app content during it and reauthenticate if it backgrounded the app.
 * Consumers resume database/network work only after this promise succeeds.
 */
export async function withNativeInteraction<T>(work: () => Promise<T>): Promise<T> {
  active++;
  let backgrounded = false;
  let success = false;
  const state = AppState.addEventListener("change", value => { if (value === "background") backgrounded = true; });
  try {
    const result = await work();
    if (backgrounded) {
      if (AppState.currentState !== "active") await new Promise<void>(resolve => {
        const returned = AppState.addEventListener("change", value => { if (value === "active") { clearTimeout(timer); returned.remove(); resolve(); } });
        const timer = setTimeout(() => { returned.remove(); resolve(); }, 2000);
      });
      if (AppState.currentState !== "active") throw new Error("Вернитесь в PersAI и повторите операцию.");
      const auth = await withBiometricPrompt(() => LocalAuthentication.authenticateAsync({
        promptMessage: "Вернуться в PersAI", disableDeviceFallback: true, biometricsSecurityLevel: "strong", cancelLabel: "Отмена",
      }));
      if (!auth.success || AppState.currentState !== "active") throw new Error("Возвращение в приложение не подтверждено.");
    }
    success = true;
    return result;
  } finally {
    state.remove(); active--;
    if (!active) for (const listener of listeners) listener(success || !backgrounded);
  }
}
