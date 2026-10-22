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
  // Opening Gboard changes the viewport over several Android frames. A 96dp
  // orb used to pop in/out as that height crossed a threshold mid-animation.
  // Keep the composer completely unobstructed throughout focus and IME.
  if (layout.composerOccluded) return 0;
  const widthBudget = Math.max(0, layout.windowWidth - 48);
  // Before onLayout, be conservative; after it, trust the real FlatList
  // viewport (not a static ratio of a device's full screen).
  const heightBudget = Math.max(
    0, (layout.listHeight > 0 ? layout.listHeight : layout.windowHeight * 0.5) - 64,
  );
  const size = Math.floor(Math.min(320, widthBudget, heightBudget));
  return size >= 96 ? size : 0;
}

export function nebulaConversationOrbSize(layout: NebulaHomeArtLayout): number {
  // A small phase indicator is INSIDE the existing busy-progress row, not a
  // separate 116dp footer that pushes the scrolling conversation around.
  // The Gboard/composer always gets priority over decorative content.
  if (layout.composerOccluded || (layout.listHeight > 0 && layout.listHeight < 155)) return 0;
  return Math.min(56, Math.max(0, layout.windowWidth - 48));
}

export function shouldScrollNebulaChatToEnd(
  rowCount: number, streamText?: string | null, nearBottom = true,
): boolean {
  // Follow incoming content only when the user has not scrolled up. Never
  // scroll an empty art view just because the keyboard has resized its list.
  return nearBottom && (rowCount > 0 || Boolean(streamText?.trim()));
}

/** Distance is measured in native layout points, not screenshot pixels. */
export function isNebulaChatNearBottom(
  contentHeight: number, offsetY: number, viewportHeight: number,
  tolerance = 96,
): boolean {
  if (![contentHeight, offsetY, viewportHeight].every(Number.isFinite)) return false;
  if (viewportHeight <= 0) return true; // Before the first measured layout.
  return contentHeight - (Math.max(0, offsetY) + viewportHeight) <= tolerance;
}
