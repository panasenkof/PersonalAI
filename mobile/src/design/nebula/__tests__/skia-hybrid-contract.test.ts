import { isSupportedSkiaPhase, NEBULA_ENERGY, NEBULA_HYBRID_SKSL } from "../hybridShader";
import { resolveNebulaScene, type NebulaPhase } from "../motion";

describe("approved B + C Skia visual contract", () => {
  it("uses the original texture, multiple membranes and a changing silhouette, not a flat circle", () => {
    expect(NEBULA_HYBRID_SKSL).toContain("uniform shader source;");
    expect(NEBULA_HYBRID_SKSL).toContain("source.eval(uv)");
    expect(NEBULA_HYBRID_SKSL).toContain("float deformation");
    for (const name of ["membraneA", "membraneB", "membraneC", "membraneD", "membraneE"]) {
      expect(NEBULA_HYBRID_SKSL).toContain(name);
    }
    expect(NEBULA_HYBRID_SKSL).not.toContain("makeImageFromView");
  });
  it("maps all supported phases to dynamic intensity without inventing mic progress", () => {
    const states: NebulaPhase[] = ["idle", "listening", "transcribing", "thinking", "responding", "offline", "error"];
    for (const state of states) {
      expect(isSupportedSkiaPhase(state)).toBe(true);
      expect(Number.isFinite(NEBULA_ENERGY[state])).toBe(true);
      expect(resolveNebulaScene(state, {
        reduceMotion: true, appActive: true, powerConstrained: false, preferredQuality: "full",
      }).animateCore).toBe(false);
    }
    expect(isSupportedSkiaPhase("recordingWhenNoPermission")).toBe(false);
  });
});
