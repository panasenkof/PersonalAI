import { useColorScheme } from "react-native";
import React, { createContext, useContext } from "react";

/** PersAI tokens: calm Aurora surfaces and the turquoise / indigo / orchid mark. */
const light = {
  bg: "#F8FAFF", panel: "#FFFFFF", line: "#E8EAF7", text: "#111C3D", muted: "#6D779D",
  accent: "#5966F8", secondary: "#10CFE4", violet: "#BD59F2",
  soft: "#F1F3FF", glow: "#C8CBFF", orbA: "#89E7FC", orbB: "#EAB3FF",
  userBubble: "#655DEA", userText: "#FFFFFF", ok: "#159D80", err: "#D5456B", warn: "#FFF2DA",
};
const dark: typeof light = {
  bg: "#0E1024", panel: "#191C39", line: "#32365A", text: "#F3F3FF", muted: "#ADB3D3",
  accent: "#A49BFF", secondary: "#52DFEF", violet: "#E09DFF",
  soft: "#252A4F", glow: "#584A9F", orbA: "#267AAE", orbB: "#81539F",
  userBubble: "#4B428E", userText: "#FFFFFF", ok: "#4FCFB1", err: "#FF8EAD", warn: "#463D29",
};
export type Theme = typeof light;

/** Home-only theme boundary; Memory and Settings keep their own OS theme. */
const ThemeOverride = createContext<Theme | null>(null);
export function NebulaHomeThemeProvider({ children }: { children: React.ReactNode }) {
  return React.createElement(ThemeOverride.Provider, { value: dark }, children);
}
export const nebulaHomeColors = dark;

export function useTheme(): Theme {
  const override = useContext(ThemeOverride);
  const scheme = useColorScheme();
  return override ?? (scheme === "dark" ? dark : light);
}
