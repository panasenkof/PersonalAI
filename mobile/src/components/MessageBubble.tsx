import React from "react";
import { StyleSheet, Text, View } from "react-native";

import { useTheme } from "../theme";

export function MessageBubble({ role, text, pending }: { role: "user" | "assistant"; text: string; pending?: boolean }) {
  const t = useTheme();
  const mine = role === "user";
  return (
    <View
      style={[
        styles.bubble,
        mine
          ? { alignSelf: "flex-end", backgroundColor: t.userBubble }
          : { alignSelf: "flex-start", backgroundColor: t.panel, borderColor: t.line, borderWidth: 1 },
      ]}
    >
      <Text selectable style={{ color: mine ? t.userText : t.text, fontSize: 15, lineHeight: 21 }}>
        {text || (pending ? "…" : "")}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  bubble: { maxWidth: "88%", borderRadius: 14, paddingHorizontal: 12, paddingVertical: 9, marginVertical: 3 },
});
