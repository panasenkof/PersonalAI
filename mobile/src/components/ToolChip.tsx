import React from "react";
import { StyleSheet, Text, View } from "react-native";

import { useTheme } from "../theme";
import type { ToolStep } from "../types";

const ICON: Record<ToolStep["state"], string> = { composing: "⚙", running: "⏳", ok: "✔", error: "✖" };

export function ToolChip({ step }: { step: ToolStep }) {
  const t = useTheme();
  const color = step.state === "ok" ? t.ok : step.state === "error" ? t.err : step.state === "running" ? t.accent : t.muted;
  const detail = step.summary ?? (step.args ? step.args.slice(0, 60) : "");
  return (
    <View style={[styles.chip, { borderColor: color }]}>
      <Text style={{ color, fontSize: 12 }} numberOfLines={1}>
        {ICON[step.state]} {step.name}
        {detail ? ` — ${detail}` : ""}
        {step.ms != null ? `  ${step.ms} мс` : ""}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  chip: { alignSelf: "flex-start", borderWidth: 1, borderRadius: 16, paddingHorizontal: 10, paddingVertical: 3, marginVertical: 2, maxWidth: "90%" },
});
