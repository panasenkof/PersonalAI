import type { AppStateStatus } from "react-native";
import { nativeInteractionActive } from "../security/native-interaction";
import { biometricPromptActive } from "./authentication";

/** A biometric prompt can transiently blur/inactivate the host Activity.
 * Locking SQLCipher on blur races with SecureStore.getItemAsync and loops auth.
 * Only a real background transition closes the sensitive database connection.
 */
export function shouldLockLocalMemory(state: AppStateStatus): boolean {
  return state === "background" && !biometricPromptActive() && !nativeInteractionActive();
}
