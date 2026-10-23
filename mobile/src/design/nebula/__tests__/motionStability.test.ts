import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isNebulaChatNearBottom, shouldScrollNebulaChatToEnd, nebulaConversationOrbSize } from "../homeArtLayout";

describe("Nebula motion stability regression", () => {
  const root = join(__dirname, "..", "..", "..");
  const home = readFileSync(join(root, "screens", "HomeScreen.tsx"), "utf8") + readFileSync(join(__dirname, "..", "useChatBottomFollow.ts"), "utf8");
  const skia = readFileSync(join(__dirname, "..", "NebulaSkiaExperiment.tsx"), "utf8");
  const nativeArtwork = readFileSync(join(__dirname, "..", "NebulaHomeArtwork.native.tsx"), "utf8");
  const shader = readFileSync(join(__dirname, "..", "hybridShader.ts"), "utf8");

  it("never starts a competing animated chat scroll for each streamed token", () => {
    expect(home).toContain("nearChatBottom.current");
    expect(home).toContain("isNebulaChatNearBottom(");
    expect(home).toContain("scrollToEnd({ animated: false })");
    expect(home).not.toContain("scrollToEnd({ animated: true })");
    expect(shouldScrollNebulaChatToEnd(5, "stream", true)).toBe(true);
    expect(shouldScrollNebulaChatToEnd(5, "stream", false)).toBe(false);
    expect(isNebulaChatNearBottom(1500, 400, 800)).toBe(false);
    expect(isNebulaChatNearBottom(1500, 650, 800)).toBe(true);
  });

  it("draws no large jumpy orb in the chat footer and moves status inside progress", () => {
    expect(home).toContain('testID="nebula-home-live-status"');
    const footer = home.indexOf("ListFooterComponent=");
    const row = home.indexOf("{busy ? <View testID=\"nebula-home-live-status\"");
    expect(footer).toBeGreaterThan(0);
    expect(row).toBeGreaterThan(footer);
    expect(home.substring(footer, row)).not.toContain("<NebulaHomeArtwork");
    expect(home).toContain("statusArtworkSize > 0 && !active?.rows?.length ? <NebulaHomeArtwork");
    expect(home).toContain('testID="nebula-conversation-orb"');
    expect(nebulaConversationOrbSize({
      windowWidth: 390, windowHeight: 820, listHeight: 420, composerOccluded: true,
    })).toBe(0);
    expect(nebulaConversationOrbSize({
      windowWidth: 390, windowHeight: 820, listHeight: 420, composerOccluded: false,
    })).toBe(96);
    expect(nativeArtwork).toContain("showStatusText={size > 100}");
  });

  it("does not wake JS for the hidden Skia clock on production Home", () => {
    expect(skia).toContain("function SkiaClockMeter(");
    expect(skia).toContain("showClockDiagnostics ? <SkiaClockMeter");
    expect(skia).toContain("showClockDiagnostics={showDiagnostics}");
    expect(nativeArtwork).not.toContain("showDiagnostics");
    // Lab retains native clock instrumentation when user asks for it.
    const lab = readFileSync(join(__dirname, "..", "NebulaSkiaLabScreen.tsx"), "utf8");
    expect(lab).toContain("showDiagnostics");
  });

  it("does not flatten the accepted B+C visual identity to hide jank", () => {
    expect(shader).toContain("source.eval(uv)");
    expect(shader).toContain("float deformation =");
    expect(shader).toContain("float contourDistance =");
    expect(shader).toContain("haloNear");
    expect(shader).toContain("haloFar");
    expect(shader).toContain("membraneA");
    expect(shader).toContain("membraneE");
    // No changes to committed 5x core / 1x filament.
    const phase = readFileSync(join(__dirname, "..", "phaseFilament.ts"), "utf8");
    expect(phase).toContain("working: 5");
    expect(phase).toContain("NEBULA_FILAMENT_SPEED = 1");
  });
});
