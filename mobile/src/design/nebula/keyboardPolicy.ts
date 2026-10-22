import type { NebulaPhase } from "./motion";

/**
 * IME takes priority over decorative GPU content. Keep these predicates pure
 * for native + browser acceptance; they must never alter the actual chat.
 */
export function shouldShowLargeNebulaArtwork(
  ready: boolean, needsSetup: boolean, busy: boolean, keyboardOpen: boolean,
): boolean {
  return ready && !needsSetup && !busy && !keyboardOpen;
}

export function shouldShowNebulaStatusArtwork(
  busy: boolean, hasChatRows: boolean, phase: NebulaPhase, keyboardOpen: boolean,
): boolean {
  return !keyboardOpen && (busy || (hasChatRows && phase !== "idle"));
}
