import { useColorScheme } from "react-native";
import React, { createContext, useContext } from "react";
import { nebulaColors, nebulaHomeColors, legacyLightColors, type NebulaThemeName } from "./design/nebula/tokens";
export { nebulaHomeColors } from "./design/nebula/tokens";

/** Compatibility adapter: existing forms share the semantic Nebula palette. */
export function themeFor(scheme: NebulaThemeName) {
  const c = nebulaColors(scheme);
  return {
    bg: c.canvas, panel: c.surface, line: c.border, text: c.text, muted: c.textSecondary,
    accent: c.accent, secondary: c.cyan, violet: c.electric, soft: c.surfaceElevated,
    glow: c.surfaceMuted, orbA: c.cyan, orbB: c.electric,
    userBubble: c.accent, userText: c.textOnAccent, ok: c.success, err: c.danger, warn: c.surfaceMuted,
  };
}
export type Theme = ReturnType<typeof themeFor>;
const ThemeOverride = createContext<Theme | null>(null);
export function NebulaHomeThemeProvider({ children }: { children: React.ReactNode }) {
  return React.createElement(ThemeOverride.Provider, { value: nebulaHomeColors }, children);
}
/** Approved dark brand default; Home retains its exact pre-migration scene colors. */
const appTheme = themeFor("dark");
export function NebulaAppThemeProvider({ children }: { children: React.ReactNode }) {
  return React.createElement(ThemeOverride.Provider, { value: appTheme }, children);
}
export function useTheme(): Theme {
  const override = useContext(ThemeOverride);
  const scheme = useColorScheme();
  return override ?? (scheme === "dark" ? nebulaHomeColors : legacyLightColors);
}
