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
    expect(NEBULA_HYBRID_SKSL).toContain("float isHeader = 1.0 - step(96.0, uSize)");
    expect(NEBULA_HYBRID_SKSL).toContain("float3 homeComposited = mix(homeBase, outputColor, orbAlpha)");
    expect(NEBULA_HYBRID_SKSL).toContain("return half4(half3(clamp(finalColor, 0.0, 1.0)), 1.0)");
    const experiment = require("node:fs").readFileSync(require("node:path").join(__dirname, "..", "NebulaSkiaExperiment.tsx"), "utf8");
    expect(experiment).toContain('backgroundColor: homeCanvas ? "transparent" : colors.canvas');
    expect(experiment).toContain('const surface = size < 96 ? nebulaHomeColors.panel : nebulaHomeColors.bg');
    expect(experiment).toContain('mask={<Circle');
    expect(experiment).toContain('colors={["white", "white", "black"]}');
    expect(experiment).not.toContain('testID="nebula-skia-poster"');
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
