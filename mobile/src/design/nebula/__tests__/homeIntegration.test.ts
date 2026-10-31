import { readFileSync } from "node:fs";
import { join } from "node:path";
import { resolveNebulaHomePhase, type NebulaHomeSignals } from "../homePhase";

const defaults: NebulaHomeSignals = {
  voicePhase: "idle", busy: false, streamText: "", error: null, ready: true,
};

describe("Nebula Home real chat and dictation status routing", () => {
  it("does not report listening before microphone is actually active", () => {
    expect(resolveNebulaHomePhase({ ...defaults, voicePhase: "starting" })).toBe("idle");
    expect(resolveNebulaHomePhase({ ...defaults, voicePhase: "listening" })).toBe("listening");
    expect(resolveNebulaHomePhase({ ...defaults, voicePhase: "finishing" })).toBe("transcribing");
  });
  it("maps real model busy to thinking and streamed text to responding", () => {
    expect(resolveNebulaHomePhase({ ...defaults, busy: true })).toBe("thinking");
    expect(resolveNebulaHomePhase({ ...defaults, busy: true, streamText: "  " })).toBe("thinking");
    expect(resolveNebulaHomePhase({ ...defaults, busy: true, streamText: "Часть ответа" })).toBe("responding");
    expect(resolveNebulaHomePhase(defaults)).toBe("idle");
  });
  it("does not invent an offline state when a model has not yet been configured", () => {
    expect(resolveNebulaHomePhase({ ...defaults, ready: false })).toBe("idle");
    expect(resolveNebulaHomePhase({ ...defaults, error: "Ошибка сохранения базы" })).toBe("error");
    expect(resolveNebulaHomePhase({ ...defaults, error: "Сеть недоступна" })).toBe("offline");
    expect(resolveNebulaHomePhase({ ...defaults, error: "network unavailable" })).toBe("offline");
  });
  it("keeps actual dictation above LLM status, never fabricates amplitude", () => {
    expect(resolveNebulaHomePhase({ ...defaults, voicePhase: "listening", busy: true, streamText: "Ответ" })).toBe("listening");
  });
});

describe("Native Home integration remains isolated and accessible", () => {
  const base = join(__dirname, "..");
  const home = readFileSync(join(base, "..", "..", "screens", "HomeScreen.tsx"), "utf8");
  const header = readFileSync(join(base, "NebulaHomeHeader.tsx"), "utf8");
  const native = readFileSync(join(base, "NebulaHomeArtwork.native.tsx"), "utf8");
  const web = readFileSync(join(base, "NebulaHomeArtwork.tsx"), "utf8");
  const skia = readFileSync(join(base, "NebulaSkiaExperiment.tsx"), "utf8");
  const theme = readFileSync(join(base, "..", "..", "theme.ts"), "utf8");
  const voice = readFileSync(join(base, "..", "..", "components", "VoiceInput.tsx"), "utf8");
  const tabs = readFileSync(join(base, "..", "..", "navigation.tsx"), "utf8");

  it("uses actual Skia native animation, no circular stage or PNG sticker", () => {
    expect(native).toContain("<NebulaSkiaExperiment");
    expect(native).toContain("clipToCircle={false}");
    expect(native).toContain("homeCanvas");
    expect(native).toContain("useIsFocused()");
    expect(native).not.toContain("borderRadius: size / 2");
    expect(web).toContain("REF-ORB-B");
    expect(skia).toContain("homeCanvas ? 1 : 0");
  });
  it("preserves chat actions while listening/finishing/streaming feed orb", () => {
    expect(home).toContain("resolveNebulaHomePhase");
    expect(home).toContain("onPhaseChange={setVoicePhase}");
    expect(home).toContain('store.send(settings)');
    expect(home).toContain('store.stop()');
    expect(home).toContain('store.select(c.id)');
    expect(home).toContain('VoiceInput key=');
    expect(voice).toContain("onPhaseChange?.(phase)");
    expect(voice).toContain("onActiveChange?.(phase !== \"idle\")");
  });
  it("camera opens directly and shows shared photo actions after capturing", () => {
    expect(home).toContain('onPress={() => void captureToDraft()}');
    expect(home).toContain("await capturePhotoDraft83(controller.signal)");
    expect(home).toContain('testID="photo-context-actions"');
    for(const label of ['В интернете','В моей памяти','Сохранить заметку','Посмотреть']){
      expect(home).toContain('label:"'+label+'"');
    }
    expect(home).toContain("store.searchPhotosLocally(selectedPhoto,active.id)");
    expect(home).toContain("store.send(settings,id)");
    expect(home).toContain('navigation.navigate("MemoryImport",{source:"photo",initialPhotoUri:staged})');
    expect(home).not.toContain("cameraPurposeOpen");
    const importer = readFileSync(join(base, "..", "..", "screens", "MemoryImportScreen.tsx"), "utf8");
    expect(importer).toContain("route.params?.initialPhotoUri");
    expect(importer).toContain("discardCameraPhotoDraft83(uri)");
    expect(importer.split("async function camera()")[1].split("useEffect")[0]).toContain("setKeepOriginal(true)");
  });
  it("uses a dark theme only on Home and matches the bottom tab palette there", () => {
    expect(theme).toContain("NebulaHomeThemeProvider");
    expect(home).toContain("<NebulaHomeThemeProvider>");
    expect(tabs).toContain('route.name === "Home" ? nebulaHomeColors : t');
    expect(home).toContain('testID="nebula-home-empty-state"');
    expect(home).toContain("showOrb={ready}");
    expect(header).toContain('testID="nebula-home-header"');
    expect(header).toContain("<NebulaHomeArtwork size={44} phase={orbPhase} />");
    expect(header).toContain("{statusText}");
    expect(header).not.toContain("connectionName");
    expect(header).not.toContain("model: string");
  });
});
