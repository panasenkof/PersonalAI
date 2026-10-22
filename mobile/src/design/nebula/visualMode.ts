/** Non-sensitive device-only Nebula graphics setting (not the encrypted memory). */
export type NebulaVisualMode = "live" | "static";
export const DEFAULT_NEBULA_VISUAL_MODE: NebulaVisualMode = "live";
export const NEBULA_VISUAL_MODE_KEY = "persai.nebula.home-render-mode.v1";

export function parseNebulaVisualMode(value: unknown): NebulaVisualMode {
  return value === "static" ? "static" : DEFAULT_NEBULA_VISUAL_MODE;
}

export const nebulaVisualModeDescription: Record<NebulaVisualMode, string> = {
  live: "Живая Skia B+C (основа ×5, неоновая нить ×1)",
  static: "Та же Skia B+C неподвижна, без таймера",
};
