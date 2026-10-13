// Android may report background/inactive while showing its own biometric sheet.
// A sheet must not close the connection it is currently unlocking.
let prompts = 0;
export const biometricPromptActive = () => prompts > 0;
export async function withBiometricPrompt<T>(work: () => Promise<T>): Promise<T> {
  prompts++;
  try { return await work(); }
  finally { prompts--; }
}

const lockListeners = new Set<() => void>();
export function requestApplicationLock(): void { for (const listener of lockListeners) listener(); }
export function onApplicationLockRequest(listener: () => void): () => void {
  lockListeners.add(listener); return () => { lockListeners.delete(listener); };
}
