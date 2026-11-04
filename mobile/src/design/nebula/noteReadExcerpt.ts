/** The preview is presentation-only; full content remains untouched and
 * selectable on demand. Keep the first bounded Unicode codepoints instead of
 * parsing an entire 60k-character recognition result on every note visit. */
export function noteReadExcerpt(text: string, maxLines: number): {
  preview: string;
  needsFullReading: boolean;
} {
  const lines = Math.max(1, Math.min(8, Math.floor(maxLines)));
  const glyphs = Array.from(text);
  const limit = lines * 85;
  const trimmed = glyphs.length > limit;
  const preview = trimmed ? glyphs.slice(0, limit).join("").trimEnd() + "…" : text;
  // Display layout can wrap sooner than the estimate. Showing an extra read
  // action is safer than trapping content behind an un-expandable truncation.
  const needsFullReading = trimmed || text.split(/\r?\n/).length > lines || glyphs.length > lines * 45;
  return { preview, needsFullReading };
}
