import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  nebulaConversationOrbSize,
  nebulaEmptyOrbSize,
  shouldScrollNebulaChatToEnd,
} from "../homeArtLayout";

const base = { listHeight: 520, windowHeight: 820, windowWidth: 390, composerOccluded: false };
describe("Nebula Home keyboard and visual viewport", () => {
  it("renders an uncropped large B+C sphere while Gboard is hidden", () => {
    expect(nebulaEmptyOrbSize(base)).toBe(320);
    expect(nebulaEmptyOrbSize({ ...base, windowWidth: 320 })).toBe(272);
    expect(nebulaEmptyOrbSize({ ...base, listHeight: 260 })).toBe(196);
    expect(nebulaEmptyOrbSize({ ...base, listHeight: 80 })).toBe(0);
  });
  it("reduces the orb to 96dp or less as soon as the composer is focused", () => {
    expect(nebulaEmptyOrbSize({ ...base, composerOccluded: true, listHeight: 220 })).toBe(96);
    expect(nebulaEmptyOrbSize({ ...base, composerOccluded: true, listHeight: 105 })).toBe(0);
    expect(nebulaEmptyOrbSize({ ...base, composerOccluded: true, listHeight: 130 })).toBe(82);
    expect(nebulaEmptyOrbSize({ ...base, composerOccluded: false })).toBe(320);
  });
  it("keeps a small status orb only if conversation viewport allows it", () => {
    expect(nebulaConversationOrbSize(base)).toBe(116);
    expect(nebulaConversationOrbSize({ ...base, composerOccluded: true, listHeight: 250 })).toBe(80);
    expect(nebulaConversationOrbSize({ ...base, composerOccluded: true, listHeight: 160 })).toBe(0);
    expect(nebulaConversationOrbSize({ ...base, composerOccluded: false, listHeight: 110 })).toBe(0);
  });
  it("never scrolls an empty screen to a clipped artwork during IME changes", () => {
    expect(shouldScrollNebulaChatToEnd(0, "")).toBe(false);
    expect(shouldScrollNebulaChatToEnd(0, "   ")).toBe(false);
    expect(shouldScrollNebulaChatToEnd(1)).toBe(true);
    expect(shouldScrollNebulaChatToEnd(0, "partial streamed reply")).toBe(true);
  });
  it("passes keyboard/focus and viewport signals without replacing any chat actions", () => {
    const root = join(__dirname, "..", "..", "..");
    const home = readFileSync(join(root, "screens", "HomeScreen.tsx"), "utf8");
    const composer = readFileSync(join(root, "components", "PromptInput.tsx"), "utf8");
    expect(home).toContain('Keyboard.addListener("keyboardDidShow"');
    expect(home).toContain('Keyboard.addListener("keyboardDidHide"');
    expect(home).toContain("onFocusChange={setComposerFocused}");
    expect(home).toContain("onLayout={event =>");
    expect(home).toContain("nebulaEmptyOrbSize(artLayout)");
    expect(home).toContain("nebulaConversationOrbSize(artLayout)");
    expect(home).toContain("shouldScrollNebulaChatToEnd(");
    expect(home).toContain("artworkSize > 0 ? <NebulaHomeArtwork");
    expect(home).toContain("store.send(settings)");
    expect(home).toContain("store.stop()");
    expect(home).toContain("store.select(c.id)");
    expect(composer).toContain("onFocus={() => onFocusChange?.(true)}");
    expect(composer).toContain("onBlur={() => onFocusChange?.(false)}");
  });
});
