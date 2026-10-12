import { useColorScheme } from "react-native";

const light = {
  bg: "#F5F7FC", panel: "#FFFFFF", line: "#E0E7F1", text: "#17233B", muted: "#69768F",
  accent: "#315CF5", userBubble: "#315CF5", userText: "#ffffff", ok: "#1f9d63", err: "#d64545", warn: "#fff4d6",
};
const dark: typeof light = {
  bg: "#0C1424", panel: "#162238", line: "#273650", text: "#EFF4FF", muted: "#9EABC3",
  accent: "#7C9CFF", userBubble: "#314A83", userText: "#ffffff", ok: "#3ecf8e", err: "#ff7b7b", warn: "#2a2412",
};

export type Theme = typeof light;

export function useTheme(): Theme {
  return useColorScheme() === "dark" ? dark : light;
}
