import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  nebulaConversationOrbSize,
  isNebulaChatNearBottom,
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
  it("hides the big orb through the full Gboard resize and restores it afterward", () => {
    expect(nebulaEmptyOrbSize({ ...base, composerOccluded: true, listHeight: 520 })).toBe(0);
    expect(nebulaEmptyOrbSize({ ...base, composerOccluded: true, listHeight: 220 })).toBe(0);
    expect(nebulaEmptyOrbSize({ ...base, composerOccluded: true, listHeight: 105 })).toBe(0);
    expect(nebulaEmptyOrbSize({ ...base, composerOccluded: true, listHeight: 130 })).toBe(0);
    expect(nebulaEmptyOrbSize({ ...base, composerOccluded: false })).toBe(320);
  });
  it("keeps a visible inline status orb without growing a separate 116dp footer", () => {
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
  it("closes Gboard only on Send, settles LLM thinking below the chat and respects intentional upward scrolling", () => {
    const root = join(__dirname, "..", "..", "..");
    const home = readFileSync(join(root, "screens", "HomeScreen.tsx"), "utf8") + readFileSync(join(__dirname, "..", "useChatBottomFollow.ts"), "utf8");
    const sendBlock = home.slice(
      home.indexOf("const sendOrStop = () => {"),
      home.indexOf("const openConnections =", home.indexOf("const sendOrStop = () => {")),
    );
    expect(sendBlock).toContain("if (busy) { store.stop(); return; }");
    expect(sendBlock).toContain("pendingSendFollow.current = true;");
    expect(sendBlock).toContain("Keyboard?.dismiss?.()");
    expect(sendBlock).toContain("setComposerFocused(false)");
    expect(sendBlock).toContain("store.send(settings)");
    expect(sendBlock).toContain("scheduleBottomFollow()");
    expect(home).toContain("onPress={sendOrStop}");
    expect(home).toContain("Keyboard.addListener(\"keyboardDidHide\"");
    expect(home).toContain("if (pendingSendFollow.current)");
    expect(home).toContain("onScrollBeginDrag={() => {");
    expect(home).toContain("pendingSendFollow.current = false;");
    expect(home).toContain("nearChatBottom.current = false;");
    expect(home).toContain("scrollFrame.current = requestAnimationFrame(");
    expect(home).toContain("cancelAnimationFrame(scrollFrame.current)");
    expect(home).toContain("list.current?.scrollToEnd({ animated: false })");
    expect(home).not.toContain("scrollToEnd({ animated: true })");
    expect(shouldScrollNebulaChatToEnd(12, "incoming answer", false)).toBe(false);
    expect(shouldScrollNebulaChatToEnd(12, "incoming answer", true)).toBe(true);
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
