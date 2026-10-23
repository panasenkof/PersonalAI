import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  nebulaConversationOrbSize,
  isNebulaChatNearBottom,
  nebulaEmptyOrbSize,
  shouldScrollNebulaChatToEnd,
  shouldAnchorNebulaStreamingReply,
} from "../homeArtLayout";

const base = { listHeight: 520, windowHeight: 820, windowWidth: 390, composerOccluded: false };
describe("Nebula Home keyboard and visual viewport", () => {
  it("renders an uncropped large B+C sphere while Gboard is hidden", () => {
    expect(nebulaEmptyOrbSize(base)).toBe(320);
    expect(nebulaEmptyOrbSize({ ...base, windowWidth: 320 })).toBe(272);
    expect(nebulaEmptyOrbSize({ ...base, listHeight: 260 })).toBe(196);
    expect(nebulaEmptyOrbSize({ ...base, listHeight: 80 })).toBe(0);
  });
  it("hides the big orb through the full Gboard resize and restores it afterward", () => {
    expect(nebulaEmptyOrbSize({ ...base, composerOccluded: true, listHeight: 520 })).toBe(0);
    expect(nebulaEmptyOrbSize({ ...base, composerOccluded: true, listHeight: 220 })).toBe(0);
    expect(nebulaEmptyOrbSize({ ...base, composerOccluded: true, listHeight: 105 })).toBe(0);
    expect(nebulaEmptyOrbSize({ ...base, composerOccluded: true, listHeight: 130 })).toBe(0);
    expect(nebulaEmptyOrbSize({ ...base, composerOccluded: false })).toBe(320);
  });
  it("preserves the legacy orb size limit while the live orb resides in the header", () => {
    expect(nebulaConversationOrbSize(base)).toBe(96);
    expect(nebulaConversationOrbSize({ ...base, composerOccluded: true, listHeight: 250 })).toBe(0);
    expect(nebulaConversationOrbSize({ ...base, composerOccluded: true, listHeight: 160 })).toBe(0);
    expect(nebulaConversationOrbSize({ ...base, composerOccluded: false, listHeight: 110 })).toBe(0);
    expect(nebulaConversationOrbSize({ ...base, windowWidth: 60 })).toBe(12);
  });
  it("never scrolls an empty screen to a clipped artwork during IME changes", () => {
    expect(shouldScrollNebulaChatToEnd(0, "")).toBe(false);
    expect(shouldScrollNebulaChatToEnd(0, "   ")).toBe(false);
    expect(shouldScrollNebulaChatToEnd(1)).toBe(true);
    expect(shouldScrollNebulaChatToEnd(1, "streaming", false)).toBe(false);
    expect(shouldScrollNebulaChatToEnd(1, "streaming", true)).toBe(true);
    expect(isNebulaChatNearBottom(1200, 450, 700)).toBe(true);
    expect(isNebulaChatNearBottom(1200, 0, 700)).toBe(false);
    expect(isNebulaChatNearBottom(1200, 0, 0)).toBe(true);
    expect(isNebulaChatNearBottom(Number.NaN, 100, 300)).toBe(false);
    expect(shouldScrollNebulaChatToEnd(0, "partial streamed reply")).toBe(true);
  });
  it("holds the beginning of a long streamed answer still, but follows short replies", () => {
    expect(shouldAnchorNebulaStreamingReply(160, 500)).toBe(false);
    expect(shouldAnchorNebulaStreamingReply(240, 500)).toBe(true);
    expect(shouldAnchorNebulaStreamingReply(350, 500)).toBe(true);
    expect(shouldAnchorNebulaStreamingReply(499, 500)).toBe(true);
    expect(shouldAnchorNebulaStreamingReply(100, 0)).toBe(false);
    expect(shouldAnchorNebulaStreamingReply(Number.NaN, 500)).toBe(false);

  });
  it("closes Gboard on Send while viewport policy owns all scrolling", () => {
    const home = readFileSync(join(__dirname, "..", "..", "..", "screens", "HomeScreen.tsx"), "utf8");
    expect(home).toContain("Keyboard?.dismiss?.()");
    expect(home).toContain("store.send(settings)");
    expect(home).not.toContain("scrollToEnd(");
    expect(home).not.toContain("streamReadAnchored");
  });
  it("passes keyboard/focus and viewport signals without replacing any chat actions", () => {
    const root = join(__dirname, "..", "..", "..");
    const home = readFileSync(join(root, "screens", "HomeScreen.tsx"), "utf8") + readFileSync(join(__dirname, "..", "useChatBottomFollow.ts"), "utf8");
    const composer = readFileSync(join(root, "components", "PromptInput.tsx"), "utf8");
    expect(home).toContain('Keyboard.addListener("keyboardDidShow"');
    expect(home).toContain('Keyboard.addListener("keyboardDidHide"');
    expect(home).toContain("onFocusChange={setComposerFocused}");
    expect(home).toContain("onLayout={event =>");
    expect(home).toContain("nebulaEmptyOrbSize(artLayout)");
    expect(home).toContain("showOrb={ready}");
    expect(home).toContain("removeClippedSubviews={false}");
    expect(home).toContain('testID="chat-jump-to-latest"');
    expect(home).toContain("onMomentumScrollEnd={event =>");
    expect(home).toContain("viewport.beginDrag(); Keyboard?.dismiss?.();");
    expect(home).toContain('behavior={Platform.OS === "ios" ? "padding" : "height"}');
    expect(home).toContain("onContentSizeChange={viewport.onContent}");
    expect(home).toContain("artworkSize > 0 ? <NebulaHomeArtwork");
    expect(home).toContain("store.send(settings)");
    expect(home).toContain("store.stop()");
    expect(home).toContain("store.select(c.id)");
    expect(composer).toContain("onFocus={() => onFocusChange?.(true)}");
    expect(composer).toContain("onBlur={() => onFocusChange?.(false)}");
  });
});
