import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getFilamentUniforms, NEBULA_FILAMENT, NEBULA_LAB_SPEED } from "../phaseFilament";
import { NEBULA_HYBRID_SKSL } from "../hybridShader";
import type { NebulaPhase } from "../motion";

const phases: NebulaPhase[] = [
  "idle", "listening", "transcribing", "thinking", "responding", "offline", "error",
];

describe("Nebula approved neon contour contract (22.10.2026)", () => {
  it("uses 1× by default and 5× only for laboratory acceleration", () => {
    expect(NEBULA_LAB_SPEED.default).toBe(1);
    expect(NEBULA_LAB_SPEED.accelerated).toBe(5);
  });
  it("does not draw a filament in the idle phase", () => {
    expect(NEBULA_FILAMENT.idle.colorHex).toBeNull();
    expect(NEBULA_FILAMENT.idle.intensity).toBe(0);
    expect(getFilamentUniforms("idle", true).uLineIntensity).toBe(0);
  });
  it("assigns exact approved color and brightness to six non-idle phases", () => {
    const expected: Partial<Record<NebulaPhase, [string, number]>> = {
      listening: ["#3DE7DB", .55],
      transcribing: ["#529CFF", .45],
      thinking: ["#BE6DFF", .70],
      responding: ["#39D1FF", .60],
      offline: ["#7288A9", .25],
      error: ["#FF6195", .75],
    };
    expect(phases).toHaveLength(7);
    const colors = new Set<string>();
    for (const phase of phases.filter(p => p !== "idle")) {
      const profile = NEBULA_FILAMENT[phase];
      expect(profile.colorHex).toEqual(expected[phase]?.[0]);
      expect(profile.intensity).toBeCloseTo(expected[phase]![1]);
      expect(profile.color.every(v => Number.isFinite(v) && v >= 0 && v <= 1)).toBe(true);
      expect(profile.pulseHz).toBeGreaterThanOrEqual(0);
      colors.add(profile.colorHex!);
    }
    expect(colors.size).toBe(6);
  });
  it("turns phase wave off when reduced motion is required", () => {
    for (const phase of phases) {
      expect(getFilamentUniforms(phase, false).uLineAnimate).toBe(0);
    }
    for (const phase of ["listening", "transcribing", "thinking", "responding"] as NebulaPhase[]) {
      expect(getFilamentUniforms(phase, true).uLineAnimate).toBe(1);
      expect(getFilamentUniforms(phase, true).uLinePulseHz).toBeGreaterThan(0);
    }
    for (const phase of ["offline", "error"] as NebulaPhase[]) {
      expect(NEBULA_FILAMENT[phase].animated).toBe(false);
      expect(getFilamentUniforms(phase, true).uLineAnimate).toBe(0);
      expect(getFilamentUniforms(phase, true).uLinePulseHz).toBe(0);
    }
  });
  it("paints a narrow neon core and two halos on the SAME deformed boundary", () => {
    for (const name of [
      "uLineR", "uLineG", "uLineB", "uLineIntensity",
      "uLinePulseHz", "uLineWave", "uLineAnimate",
    ]) expect(NEBULA_HYBRID_SKSL).toContain(`uniform float ${name};`);
    expect(NEBULA_HYBRID_SKSL).toContain("contourDistance = abs(d -");
    expect(NEBULA_HYBRID_SKSL).toContain("float core =");
    expect(NEBULA_HYBRID_SKSL).toContain("float haloNear =");
    expect(NEBULA_HYBRID_SKSL).toContain("float haloFar =");
    expect(NEBULA_HYBRID_SKSL.indexOf("float3 outputColor = mix(bg, plasma, mask);"))
      .toBeLessThan(NEBULA_HYBRID_SKSL.indexOf("outputColor += filamentColor"));
    // Keep the original image-backed B details and multi-layer C dynamics.
    expect(NEBULA_HYBRID_SKSL).toContain("source.eval(uv)");
    for (const name of ["membraneA", "membraneB", "membraneC", "membraneD", "membraneE"])
      expect(NEBULA_HYBRID_SKSL).toContain(name);
  });
  it("accelerates elapsed TIME, not core energy or brightness", () => {
    const component = readFileSync(join(__dirname, "..", "NebulaSkiaExperiment.tsx"), "utf8");
    const lab = readFileSync(join(__dirname, "..", "NebulaSkiaLabScreen.tsx"), "utf8");
    expect(component).toContain("clock.value * 0.001 * speed");
    expect(component).toContain("const energy = NEBULA_ENERGY[phase];");
    expect(component).toContain('previewSpeed?: NebulaLabSpeed;');
    expect(component).toContain('function StaticSkiaOrb(');
    expect(component).toContain('...getFilamentUniforms(phase, false)');
    expect(lab).toContain("NEBULA_LAB_SPEED.accelerated");
    expect(lab).toContain("Проверка движения ×5");
    expect(lab).not.toContain("×2,5");
  });
});
