import type { NebulaPhase } from "./motion";

/**
 * Approved 22.10.2026: one thin contour filament for every phase except idle.
 * Hex/RGB are explicit semantic identity values, never random gradients.
 * The string follows the SkSL deformation field, NOT a circular RN border.
 */
export interface NebulaFilamentProfile {
  color: readonly [number, number, number];
  colorHex: string | null;
  intensity: number;
  pulseHz: number;
  wave: number;
  animated: boolean;
}

export const NEBULA_FILAMENT: Readonly<Record<NebulaPhase, NebulaFilamentProfile>> = {
  idle:         { color: [0, 0, 0],                    colorHex: null,      intensity: 0,    pulseHz: 0,        wave: 0,    animated: false },
  listening:    { color: [61/255, 231/255, 219/255],   colorHex: "#3DE7DB", intensity: 0.55, pulseHz: 1 / 0.9,  wave: 3.2,  animated: true },
  transcribing: { color: [82/255, 156/255, 255/255],   colorHex: "#529CFF", intensity: 0.45, pulseHz: 1 / 1.65, wave: 2.4,  animated: true },
  thinking:     { color: [190/255, 109/255, 255/255],  colorHex: "#BE6DFF", intensity: 0.70, pulseHz: 1 / 2.25, wave: 4.7,  animated: true },
  responding:   { color: [57/255, 209/255, 255/255],   colorHex: "#39D1FF", intensity: 0.60, pulseHz: 1 / 1.3,  wave: 3.6,  animated: true },
  offline:      { color: [114/255, 136/255, 169/255],  colorHex: "#7288A9", intensity: 0.25, pulseHz: 0,        wave: 0,    animated: false },
  error:        { color: [255/255, 97/255, 149/255],   colorHex: "#FF6195", intensity: 0.75, pulseHz: 0,        wave: 0,    animated: false },
} as const;

/** Match these literal names to SkSL uniforms in hybridShader.ts. */
export function getFilamentUniforms(phase: NebulaPhase, allowAnimation: boolean) {
  const profile = NEBULA_FILAMENT[phase];
  return {
    uLineR: profile.color[0],
    uLineG: profile.color[1],
    uLineB: profile.color[2],
    uLineIntensity: profile.intensity,
    uLinePulseHz: profile.pulseHz,
    uLineWave: profile.wave,
    uLineAnimate: allowAnimation && profile.animated ? 1 : 0,
  };
}

export const NEBULA_LAB_SPEED = {
  default: 1,
  accelerated: 5,
} as const;

export type NebulaLabSpeed = typeof NEBULA_LAB_SPEED[keyof typeof NEBULA_LAB_SPEED];
