import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(__dirname, "..", "..", "..");
// ARCH-6b: the Home screen is now assembled from source-only presentation
// components. Keep inspecting their real content, not comments in HomeScreen.
const home = [
  "screens/HomeScreen.tsx",
  "components/chat/ChatRowView.tsx",
  "components/chat/ChatComposer.tsx",
  "components/chat/ChatListExtras.tsx",
].map(path => readFileSync(join(root, path), "utf8")).join("\n");
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
    expect(home).toContain('accessibilityLabel="Прикрепить файл к сообщению"');
    // A captured photo remains local until a deliberate action. The memory action calls LLM → on-device photo tool.
    expect(home).toContain("onCaptureCamera={() => { void captureToDraft(); }}");
    expect(home).toContain("onPress={onCaptureCamera}");
    expect(home).toContain("capturePhotoDraft83(controller.signal)");
    expect(home).toContain("store.searchPhotosWithAgent(settings,selectedPhoto,active.id)");
    expect(home).toContain("store.send(settings,id)");
    expect(home).toContain('navigation.navigate("MemoryImport",{source:"photo",initialPhotoUri:staged})');
    // Found media still opens the corresponding memory entry, including after results UI extraction.
    expect(home).toContain('onOpenNote(result.id, original ? result.photoAttachmentId : undefined)');
    expect(home).toContain('onOpenNote(m.id)');
    expect(home).toContain('navigation.navigate("MemoryNote",');
    expect(home).toContain("needsSetup");
    expect(home).toContain("PROVIDER_PRESETS.slice(0, 4)");
    expect(home).toContain("active?.streamText");
    expect(header).not.toContain("keyboard");
  });
});
