import * as SecureStore from "expo-secure-store";
import { toByteArray } from "base64-js";

/** The single on-device profile that owns the encrypted memory database. */
export const PROFILE_KEY = "pia.profile.v1";
/** Storage keys from the removed server mode, read once for the upgrade. */
const LEGACY_TOKENS_KEY = "pia.tokens";
const LEGACY_SERVER_KEYS = [LEGACY_TOKENS_KEY, "pia.apiBase", "pia.offlineMemoryMode"];
const VALID_PROFILE = /^(guest|[a-f0-9-]{8,64})$/i;

/** Profile used before the upgrade. A former server account kept its notes in a
 * database named after the account id; the JWT is only a hint to locate that
 * device-local database, never an authorization decision. */
async function legacyProfile(): Promise<string> {
  if (await SecureStore.getItemAsync("pia.offlineMemoryMode") === "yes") return "guest";
  try {
    const raw = await SecureStore.getItemAsync(LEGACY_TOKENS_KEY);
    const token = raw ? JSON.parse(raw).access_token : null;
    if (typeof token !== "string" || token.length > 16000) return "guest";
    let segment = token.split(".")[1]?.replace(/-/g, "+").replace(/_/g, "/") || "";
    segment += "=".repeat((4 - segment.length % 4) % 4);
    const payload = JSON.parse(Array.from(toByteArray(segment), n => String.fromCharCode(n)).join(""));
    if (typeof payload.sub === "string" && /^[a-f0-9-]{8,64}$/i.test(payload.sub)) return payload.sub;
  } catch { /* an unreadable old token falls back to the guest database */ }
  return "guest";
}

let pending: Promise<string> | null = null;

/** Returns the stable device profile, choosing it once from pre-upgrade state.
 * Server tokens and addresses are deleted only after the choice is persisted. */
export function savedMemoryProfile(): Promise<string> {
  pending ??= (async () => {
    const stored = await SecureStore.getItemAsync(PROFILE_KEY);
    if (stored && VALID_PROFILE.test(stored)) return stored;
    const profile = await legacyProfile();
    await SecureStore.setItemAsync(PROFILE_KEY, profile, { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY });
    for (const key of LEGACY_SERVER_KEYS) {
      try { await SecureStore.deleteItemAsync(key); } catch { /* retried harmlessly on a later start */ }
    }
    return profile;
  })().catch(error => { pending = null; throw error; });
  return pending;
}

/** Test hook: forget the cached choice. */
export function resetSavedMemoryProfileForTests(): void { pending = null; }
