/** Ephemeral library position: scoped to a profile and the exact list query.
 * Nothing here is saved, indexed or included in backup/diagnostic exports. */
export type MemoryScrollAnchor = {
  scope: string;
  id: string;
  index: number;
  loaded: number;
};

export function memoryScrollScope(
  profile: string, collectionId: string | undefined,
  status: "active" | "archived" | "trashed", term: string,
): string {
  return JSON.stringify([profile, collectionId ?? null, status, term]);
}

/** Restore the same entity if present; otherwise use the nearest surviving item.
 * FlatList with numColumns accepts ROW indexes, not per-note indexes. */
export function memoryScrollRowIndex(
  notes: readonly { id: string }[], anchor: MemoryScrollAnchor | null,
  scope: string, columns: number,
): number | null {
  if (!anchor || anchor.scope !== scope || !notes.length) return null;
  const found = notes.findIndex(note => note.id === anchor.id);
  const noteIndex = found >= 0
    ? found
    : Math.max(0, Math.min(notes.length - 1, anchor.index));
  return Math.floor(noteIndex / Math.max(1, Math.floor(columns)));
}

/** The repository accepts at most 100 per call; the screen reads this count in
 * bounded pages, so a return from a note does not throw away loaded pages. */
export function memoryScrollReloadCount(
  anchor: MemoryScrollAnchor | null | undefined, scope: string,
): number {
  if (!anchor || anchor.scope !== scope) return 50;
  return Math.max(50, Math.max(anchor.loaded, anchor.index + 1));
}
