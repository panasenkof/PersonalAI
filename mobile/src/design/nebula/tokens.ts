/**
 * PersAI Nebula foundation. Visual requirements:
 * docs/design/NEBULA_VISUAL_CONTRACT.md, REF-ICON-A / REF-ORB-B.
 *
 * These semantic tokens DO NOT represent the finished artwork.
 * Never replace the approved orb with a simple gradient circle.
 */
export const nebulaPalette = {
  dark: {
    canvas: "#070D20",
    canvasElevated: "#101B35",
    surface: "#14213D",
    surfaceElevated: "#1D2E51",
    surfaceMuted: "#26395C",
    border: "#445574",
    text: "#F6F8FF",
    textSecondary: "#ABBAD8",
    accent: "#7051DB",
    cyan: "#30CAED",
    electric: "#376BF2",
    focus: "#72E2FA",
    success: "#2FD3A4",
    warning: "#FFC074",
    danger: "#FF9FAF",
    textOnAccent: "#FFFFFF",
    scrim: "rgba(4, 7, 19, 0.78)",
  },
  light: {
    canvas: "#F7F8FD",
    canvasElevated: "#FFFFFF",
    surface: "#FFFFFF",
    surfaceElevated: "#EDF0FA",
    surfaceMuted: "#E5E9F6",
    border: "#8993AB",
    text: "#18213B",
    textSecondary: "#535D78",
    accent: "#5541CE",
    cyan: "#067AA0",
    electric: "#3359C2",
    focus: "#2049AC",
    success: "#087456",
    warning: "#7E4B05",
    danger: "#A32345",
    textOnAccent: "#FFFFFF",
    scrim: "rgba(21, 28, 55, 0.42)",
  },
} as const;

export type NebulaThemeName = keyof typeof nebulaPalette;
export type NebulaColors = { [K in keyof typeof nebulaPalette.dark]: string };
export const nebulaColors = (scheme: NebulaThemeName): NebulaColors => nebulaPalette[scheme];

export const nebulaSpacing = {
  xxs: 4, xs: 8, sm: 12, md: 16, lg: 20, xl: 24, xxl: 32, section: 40,
} as const;
export const nebulaRadii = { chip: 12, field: 16, card: 20, sheet: 26, composer: 22, pill: 999 } as const;
export const nebulaTypography = {
  caption: { fontSize: 11, lineHeight: 16 },
  label: { fontSize: 13, lineHeight: 20 },
  body: { fontSize: 16, lineHeight: 24 },
  subtitle: { fontSize: 18, lineHeight: 26 },
  heading: { fontSize: 24, lineHeight: 32 },
} as const;
export const nebulaTouch = { minimum: 48, compactVisual: 36 } as const;
export const nebulaLayout = {
  referenceWidths: [320, 360, 390, 430] as const,
  composerMinHeight: 56,
  composerMaxLines: 6,
  headerTargetHeight: 60,
  contentGutter: 16,
  maxContentWidth: 720,
} as const;

/** Relative luminance per WCAG. Deterministic pure functions for token tests. */
export function relativeLuminance(hex: string): number {
  if (!/^#[0-9a-f]{6}$/i.test(hex)) throw new Error("Expected #RRGGBB");
  const rgb = [1, 3, 5].map(index => {
    const channel = Number.parseInt(hex.slice(index, index + 2), 16) / 255;
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722;
}
export function contrastRatio(foreground: string, background: string): number {
  const a = relativeLuminance(foreground), b = relativeLuminance(background);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}
