/** Five minutes outside PersAI. Wall time includes deep sleep; monotonic time
 * prevents clock corrections extending an awake session. Cold starts always lock. */
export const APP_SESSION_TIMEOUT_MS = 5 * 60 * 1000;
export type SessionTimestamp = { wall: number; monotonic: number };
export const sessionNow = (): SessionTimestamp => ({ wall: Date.now(), monotonic: globalThis.performance?.now() ?? Date.now() });
export const sessionExpired = (leftAt: SessionTimestamp | null, now = sessionNow()) =>
  leftAt !== null && Math.max(now.wall - leftAt.wall, now.monotonic - leftAt.monotonic) >= APP_SESSION_TIMEOUT_MS;
