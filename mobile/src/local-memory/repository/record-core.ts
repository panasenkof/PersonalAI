/** Shared pure guards from the original canonical memory repository. */
export const clone = (value: Record<string, unknown>): Record<string, unknown> => JSON.parse(JSON.stringify(value));

export function safeReason(reason: string) {
  if (!reason.trim() || reason.length > 512) throw new Error("invalid_revision_reason");
}
export function kindAllowed(kind: string) {
  if (!/^[a-z][a-z0-9_]{0,63}$/.test(kind)) throw new Error("invalid_relation_kind");
}

export function validPayload(payload: Record<string, unknown>) {
  if (payload === null || Array.isArray(payload) || typeof payload !== "object") {
    throw new Error("invalid_memory_payload");
  }
  return JSON.stringify(payload);
}

