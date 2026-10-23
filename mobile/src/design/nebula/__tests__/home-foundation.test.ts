import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(__dirname, "..", "..", "..");
const home = readFileSync(join(root, "screens", "HomeScreen.tsx"), "utf8");
const header = readFileSync(join(__dirname, "..", "NebulaHomeHeader.tsx"), "utf8");
const orb = readFileSync(join(__dirname, "..", "NebulaHomeArtwork.tsx"), "utf8");
const liveOrb = readFileSync(join(__dirname, "..", "NebulaHomeArtwork.native.tsx"), "utf8");

describe("Nebula Home native B+C screen contracts", () => {
  it("uses one compact header with working native navigation paths", () => {
    expect(home).toContain("<NebulaHomeHeader");
    expect(home).toContain("onHistory={() => setHistoryOpen(true)}");
    expect(home).toContain("onNewChat={() => store.create()}");
    expect(home).toContain("statusText={statusText}");
    expect(header).toContain('accessibilityLabel="История диалогов"');
    expect(header).toContain('accessibilityLabel="Новый диалог"');
    expect(header).toContain('testID="nebula-home-status"');
    expect(header).not.toContain("Выбрать модель и подключение");
  });
  it("retains selected B+C original in idle, never a generic flat orb or a welcome billboard", () => {
    expect(home).toContain('testID="nebula-home-empty-state"');
    expect(home).toContain("<NebulaHomeArtwork size={artworkSize} phase={orbPhase} />");
    expect(liveOrb).toContain("<NebulaSkiaExperiment");
    expect(liveOrb).toContain("clipToCircle={false}");
    expect(home).toContain("<NebulaHomeThemeProvider>");
    expect(orb).toContain('require("./assets/nebula-orb-ref-b.png")');
    expect(home).not.toContain("Чем помочь сегодня?");
    expect(home).not.toContain("Составить план");
    expect(home).not.toContain("Написать текст");
    expect(home).not.toContain("Объяснить идею");
  });
  it("preserves the currently working Android IME, voice/normalization and memory operations", () => {
    expect(home).toContain("<KeyboardAvoidingView");
    expect(home).toContain("<PromptInput");
    expect(home).toContain("<VoiceInput");
    expect(home).toContain("normalization.toggle(settings)");
    expect(home).toContain("void store.send(settings)");
    expect(home).toContain('navigation.navigate("MemoryImport")');
    expect(home).toContain('navigation.navigate("MemoryImport", { camera: true })');
    expect(home).toContain('navigation.navigate("MemoryNote", { entityId: m.id })');
    expect(home).toContain("needsSetup");
    expect(home).toContain("PROVIDER_PRESETS.slice(0, 4)");
    expect(home).toContain("active?.streamText");
    expect(header).not.toContain("keyboard");
  });
});
