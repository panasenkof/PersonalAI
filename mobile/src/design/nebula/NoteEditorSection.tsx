import Feather from "@expo/vector-icons/Feather";
import React from "react";
import { Pressable, Text, View } from "react-native";
import { useTheme } from "../../theme";
import { nebulaRadii, nebulaSpacing, nebulaTouch, nebulaTypography } from "./tokens";

/** Controlled disclosure. Note data stays in the editor's in-memory state;
 * this presentational component has no persistence or external side effects. */
export function NoteEditorSection({ title, summary, expanded, onToggle, children, testID }: {
  title: string;
  summary?: string;
  expanded: boolean;
  onToggle: () => void;
  children: React.ReactNode;
  testID?: string;
}) {
  const t = useTheme();
  return <View style={{ borderRadius: nebulaRadii.card, borderWidth: 1, borderColor: t.line, backgroundColor: t.panel, overflow: "hidden" }}>
    <Pressable testID={testID} accessibilityRole="button" accessibilityLabel={title}
      accessibilityState={{ expanded }} onPress={onToggle}
      style={{ minHeight: nebulaTouch.minimum, flexDirection: "row", alignItems: "center",
        paddingHorizontal: nebulaSpacing.md, paddingVertical: nebulaSpacing.sm, gap: nebulaSpacing.sm }}>
      <View style={{ flex: 1, minWidth: 0, gap: nebulaSpacing.xxs }}>
        <Text style={{ color: t.text, fontWeight: "700", ...nebulaTypography.body }}>{title}</Text>
        {!expanded && summary ? <Text numberOfLines={2} style={{ color: t.muted, ...nebulaTypography.label }}>{summary}</Text> : null}
      </View>
      <Feather name={expanded ? "chevron-up" : "chevron-down"} size={21} color={t.accent} />
    </Pressable>
    {expanded ? <View style={{ paddingHorizontal: nebulaSpacing.md, paddingBottom: nebulaSpacing.md, gap: nebulaSpacing.sm }}>{children}</View> : null}
  </View>;
}
