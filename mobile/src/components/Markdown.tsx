import React from "react";
import { Linking, Platform, Text } from "react-native";
import type { TextStyle } from "react-native";
import { hasMarkdown, parseMarkdown } from "./markdown-parse";
import type { Span } from "./markdown-parse";
import { useTheme } from "../theme";

/** Renders a model answer as one selectable text: copying still takes it whole. */
export function MarkdownText({ text, style }: { text: string; style?: TextStyle }) {
  const t = useTheme();
  const mono = Platform.OS === "ios" ? "Menlo" : "monospace";
  if (!hasMarkdown(text)) return <Text selectable style={style}>{text}</Text>;
  const plain = (s: Span) => !s.bold && !s.italic && !s.code && !s.url;
  const spans = (items: Span[], prefix: string) => items.length === 1 && plain(items[0]) ? items[0].text : items.map((s, i) => plain(s) ? s.text : <Text key={prefix + i}
    onPress={s.url ? () => void Linking.openURL(s.url!).catch(() => undefined) : undefined}
    style={{ ...(s.bold ? { fontWeight: "700" as const } : {}), ...(s.italic ? { fontStyle: "italic" as const } : {}),
      ...(s.code ? { fontFamily: mono, backgroundColor: t.soft } : {}), ...(s.url ? { color: t.accent, textDecorationLine: "underline" as const } : {}) }}>{s.text}</Text>);
  const blocks = parseMarkdown(text);
  return <Text selectable style={style}>
    {blocks.map((b, i) => {
      const nl = i < blocks.length - 1 ? "\n" : "";
      const key = "b" + i;
      switch (b.kind) {
        case "blank": return <Text key={key}>{nl}</Text>;
        case "rule": return <Text key={key} style={{ color: t.muted }}>{"──────────" + nl}</Text>;
        case "code": return <Text key={key} style={{ fontFamily: mono, backgroundColor: t.soft }}>{b.text + nl}</Text>;
        case "heading": return <Text key={key} style={{ fontWeight: "800", fontSize: b.level <= 2 ? 19 : 17 }}>{spans(b.spans, key)}{nl}</Text>;
        case "bullet": return <Text key={key}>{"   ".repeat(b.depth) + "•  "}{spans(b.spans, key)}{nl}</Text>;
        case "numbered": return <Text key={key}>{"   ".repeat(b.depth) + b.number + ".  "}{spans(b.spans, key)}{nl}</Text>;
        case "quote": return <Text key={key} style={{ color: t.muted, fontStyle: "italic" }}>{"│ "}{spans(b.spans, key)}{nl}</Text>;
        default: return <Text key={key}>{spans(b.spans, key)}{nl}</Text>;
      }
    })}
  </Text>;
}
