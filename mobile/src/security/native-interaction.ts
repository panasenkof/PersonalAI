import { registerApplicationModal } from "./visibility";
import { AppState } from "react-native";
import { sessionExpired, sessionNow } from "./session";
import type { SessionTimestamp } from "./session";

let active = 0;
const listeners = new Set<(success: boolean) => void>();
export const nativeInteractionActive = () => active > 0;
export function onNativeInteractionEnd(listener: (success: boolean) => void) {
  listeners.add(listener); return () => { listeners.delete(listener); };
}
/** Keep a system picker/share sheet from destroying its requesting screen.
 * The app boundary owns authentication; a short picker/share never prompts.
 * Consumers resume database/network work only after this promise succeeds.
 */
export async function withNativeInteraction<T>(work: () => Promise<T>, options?: { permissionPrompt?: boolean }): Promise<T> {
  // Only the known runtime-permission window is exempt from Android focus loss.
  // Real inactive/background transitions still hide content and expire sessions.
  const releaseWindow = options?.permissionPrompt ? registerApplicationModal() : undefined;
  active++;
  let backgrounded = false;
  let leftAt: SessionTimestamp | null = null;
  let success = false;
  const state = AppState.addEventListener("change", value => {
    if (value !== "active" && leftAt === null) { backgrounded = true; leftAt = sessionNow(); }
  });
  try {
    const result = await work();
    if (backgrounded) {
      if (AppState.currentState !== "active") await new Promise<void>(resolve => {
        const returned = AppState.addEventListener("change", value => { if (value === "active") { clearTimeout(timer); returned.remove(); resolve(); } });
        const timer = setTimeout(() => { returned.remove(); resolve(); }, 2000);
      });
      if (AppState.currentState !== "active") throw new Error("Вернитесь в PersAI и повторите операцию.");
      if (sessionExpired(leftAt)) throw new Error("Сеанс приложения истёк. Войдите снова и повторите операцию.");
    }
    success = true;
    return result;
  } finally {
    state.remove(); releaseWindow?.(); active--;
    if (!active) for (const listener of listeners) listener(success || !backgrounded);
  }
}
