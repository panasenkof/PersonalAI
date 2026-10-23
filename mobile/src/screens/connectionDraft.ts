import type { DirectConnections } from "../direct-agent/settings";
/** Compare locally only. Never log this fingerprint: it may include credentials. */
export function connectionDraftFingerprint(value: DirectConnections, selectedId: string): string {
  return JSON.stringify({ activeId: selectedId, connections: value.connections });
}
