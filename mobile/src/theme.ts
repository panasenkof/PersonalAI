import { useColorScheme } from "react-native";

const light = {
  bg: "#f5f6f8", panel: "#ffffff", line: "#e2e5ea", text: "#15181e", muted: "#6b7280",
  accent: "#2458d3", userBubble: "#2458d3", userText: "#ffffff", ok: "#1f9d63", err: "#d64545", warn: "#fff4d6",
};
const dark: typeof light = {
  bg: "#0f1115", panel: "#171a21", line: "#262b36", text: "#e6e9ef", muted: "#8b93a5",
  accent: "#4f8cff", userBubble: "#27406e", userText: "#ffffff", ok: "#3ecf8e", err: "#ff7b7b", warn: "#2a2412",
};

export type Theme = typeof light;

export function useTheme(): Theme {
  return useColorScheme() === "dark" ? dark : light;
}
