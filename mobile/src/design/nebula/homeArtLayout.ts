/** Layout-only model. No pixel density / network / LLM / Skia assumptions. */
export interface NebulaHomeArtLayout {
  /** The list's actual visible height, measured by onLayout. Zero before mount. */
  listHeight: number;
  /** Current device window's height, only for the first pre-layout frame. */
  windowHeight: number;
  windowWidth: number;
  /** The software keyboard is shown or the message composer is focused. */
  composerOccluded: boolean;
}

export function nebulaEmptyOrbSize(layout: NebulaHomeArtLayout): number {
  const widthBudget = Math.max(0, layout.windowWidth - 48);
  // Before onLayout, be conservative; after it, trust the real FlatList
  // viewport (not a static ratio of a device's full screen).
  const heightBudget = Math.max(
    0,
    (layout.listHeight > 0 ? layout.listHeight : layout.windowHeight * 0.5) -
      (layout.composerOccluded ? 48 : 64),
  );
  const maxArt = layout.composerOccluded ? 96 : 320;
  const size = Math.floor(Math.min(maxArt, widthBudget, heightBudget));
  // A cramped viewport is better left for the user's prompt than for an orb.
  return size >= (layout.composerOccluded ? 64 : 96) ? size : 0;
}

export function nebulaConversationOrbSize(layout: NebulaHomeArtLayout): number {
  if (layout.composerOccluded) {
    // A status indicator is optional; prioritize conversation lines while
    // Gboard is visible on narrow devices.
    return layout.listHeight >= 190 ? Math.min(80, Math.max(0, layout.windowWidth - 48)) : 0;
  }
  return layout.listHeight > 0 && layout.listHeight < 155 ? 0 : 116;
}

export function shouldScrollNebulaChatToEnd(rowCount: number, streamText?: string | null): boolean {
  // Never scroll the empty-state art offscreen when the keyboard opens.
  return rowCount > 0 || Boolean(streamText?.trim());
}
