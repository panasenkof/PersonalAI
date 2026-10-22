import { isNebulaLabForeground, nebulaRendererReason, nebulaRendererLabels } from "../rendererDiagnostics";
import type { NebulaRendererSignals } from "../rendererDiagnostics";

const active: NebulaRendererSignals = {
  phase: "idle",
  quality: "full",
  appActive: true,
  reduceMotion: false,
  powerConstrained: false,
  enableNativeShader: true,
  compiled: true,
  imageReady: true,
};

describe("Nebula shader/static fallback diagnostic", () => {
  it("does not freeze forever when React Native has not yet initialized AppState", () => {
    expect(isNebulaLabForeground(null)).toBe(true);
    expect(isNebulaLabForeground(undefined)).toBe(true);
    expect(isNebulaLabForeground("active")).toBe(true);
    expect(isNebulaLabForeground("background")).toBe(false);
    expect(isNebulaLabForeground("inactive")).toBe(false);
  });
  it("reports genuine animation only after shader compilation and texture load", () => {
    expect(nebulaRendererReason(active)).toBe("animated");
    expect(nebulaRendererReason({ ...active, compiled: false })).toBe("shader-compilation-failed");
    expect(nebulaRendererReason({ ...active, imageReady: false })).toBe("source-image-loading");
    expect(nebulaRendererReason({ ...active, enableNativeShader: false })).toBe("shader-disabled");
  });
  it("prefers system accessibility and power-safe freeze reasons over shader", () => {
    expect(nebulaRendererReason({ ...active, reduceMotion: true })).toBe("reduce-motion");
    expect(nebulaRendererReason({ ...active, appActive: false })).toBe("app-background");
    expect(nebulaRendererReason({ ...active, powerConstrained: true })).toBe("low-power");
    expect(nebulaRendererReason({ ...active, phase: "offline" })).toBe("nonanimated-phase");
    expect(nebulaRendererReason({ ...active, phase: "error" })).toBe("nonanimated-phase");
  });
  it("always renders a localized reason rather than silently showing a poster", () => {
    for (const reason of [
      "animated", "shader-compilation-failed", "source-image-loading",
      "shader-disabled", "app-background", "reduce-motion", "low-power",
      "nonanimated-phase",
    ] as const) expect(nebulaRendererLabels[reason].length).toBeGreaterThan(15);
  });
});
