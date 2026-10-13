import * as SecureStore from "expo-secure-store";
import { toByteArray } from "base64-js";
/** The JWT is only a hint to locate a device-local legacy key, not an account
 * authorization decision. Actual server authentication remains in AuthProvider.
 */
export async function savedMemoryProfile(): Promise<string> {
  if (await SecureStore.getItemAsync("pia.offlineMemoryMode") === "yes") return "guest";
  try {
    const raw = await SecureStore.getItemAsync("pia.tokens");
    const token = raw ? JSON.parse(raw).access_token : null;
    if (typeof token !== "string" || token.length > 16000) return "guest";
    let segment = token.split(".")[1]?.replace(/-/g, "+").replace(/_/g, "/") || "";
    segment += "=".repeat((4 - segment.length % 4) % 4);
    const payload = JSON.parse(Array.from(toByteArray(segment), n => String.fromCharCode(n)).join(""));
    if (typeof payload.sub === "string" && /^[a-f0-9-]{8,64}$/i.test(payload.sub)) return payload.sub;
  } catch { /* a bad server token never bypasses application authentication */ }
  return "guest";
}
