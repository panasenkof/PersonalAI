import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_NEBULA_VISUAL_MODE, NEBULA_VISUAL_MODE_KEY, nebulaVisualModeDescription, parseNebulaVisualMode } from "../visualMode";
import { getNebulaVisualMode, setNebulaVisualMode } from "../visualPreference";

describe("Nebula Home A/B performance switch", () => {
  it("defaults safely to live mode, accepts only the two supported values", () => {
    expect(DEFAULT_NEBULA_VISUAL_MODE).toBe("live");
    expect(parseNebulaVisualMode(undefined)).toBe("live");
    expect(parseNebulaVisualMode(null)).toBe("live");
    expect(parseNebulaVisualMode("corrupt")).toBe("live");
    expect(parseNebulaVisualMode("")).toBe("live");
    expect(parseNebulaVisualMode("static")).toBe("static");
    expect(parseNebulaVisualMode("live")).toBe("live");
    expect(NEBULA_VISUAL_MODE_KEY).toContain("nebula");
    expect(nebulaVisualModeDescription.live).toContain("×5");
    expect(nebulaVisualModeDescription.static).toContain("без таймера");
  });
  it("can switch reversible web QA preference without changing chat data", async () => {
    await setNebulaVisualMode("static");
    expect(await getNebulaVisualMode()).toBe("static");
    await setNebulaVisualMode("live");
    expect(await getNebulaVisualMode()).toBe("live");
    await expect(setNebulaVisualMode("broken" as any)).rejects.toThrow("Invalid");
  });
  it("uses persisted native storage only for graphics, never SQLCipher", () => {
    const native = readFileSync(join(__dirname, "..", "visualPreference.native.ts"), "utf8");
    expect(native).toContain('from "expo-sqlite/kv-store"');
    expect(native).toContain("Storage.getItem(");
    expect(native).toContain("Storage.setItem(");
    expect(native).not.toContain("local-memory");
    expect(native).not.toContain("secure-store");
  });
  it("fully removes the animation clock when static Home is chosen", () => {
    const nativeHome = readFileSync(join(__dirname, "..", "NebulaHomeArtwork.native.tsx"), "utf8");
    const skia = readFileSync(join(__dirname, "..", "NebulaSkiaExperiment.tsx"), "utf8");
    expect(nativeHome).toContain("getNebulaVisualMode()");
    expect(nativeHome).toContain("useFocusEffect(");
    expect(nativeHome).toContain('pauseAnimation={mode === "static"}');
    expect(skia).toContain("!pauseAnimation && scene.animateCore");
    expect(skia).toContain("function StaticSkiaOrb");
    expect(skia).toContain("...getFilamentUniforms(phase, false)");
  });
  it("places an accessible A/B toggle in developer diagnostics, not on Home", () => {
    const diagnostics = readFileSync(join(__dirname, "..", "..", "..", "screens", "DiagnosticLogsScreen.tsx"), "utf8");
    const home = readFileSync(join(__dirname, "..", "..", "..", "screens", "HomeScreen.tsx"), "utf8");
    expect(diagnostics).toContain('control("Анимация Nebula на главной"');
    expect(diagnostics).toContain("setNebulaVisualMode(enabled");
    expect(diagnostics).toContain("nebulaMode === \"live\"");
    expect(home).not.toContain("setNebulaVisualMode");
  });
});
