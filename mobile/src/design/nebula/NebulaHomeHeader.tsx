import React from "react";
import { Text, View } from "react-native";
import { useTheme } from "../../theme";
import { nebulaSpacing } from "./tokens";
import { IconAction } from "../../components/IconAction";
import { NebulaHomeArtwork } from "./NebulaHomeArtwork";
import type { NebulaPhase } from "./motion";

/** Status lives next to the orb. Model/provider selection lives in Settings. */
export function NebulaHomeHeader({
  statusText,
  onHistory,
  onNewChat,
  newChatEnabled,
  showOrb = false,
  orbPhase = "idle",
}: {
  statusText: string;
  onHistory: () => void;
  onNewChat: () => void;
  newChatEnabled: boolean;
  showOrb?: boolean;
  orbPhase?: NebulaPhase;
}) {
  const t = useTheme();
  return <View testID="nebula-home-header" style={{
    height: 72, flexDirection: "row", alignItems: "center",
    gap: nebulaSpacing.xxs, backgroundColor: t.panel,
    borderBottomWidth: 1, borderColor: t.line,
    paddingHorizontal: nebulaSpacing.xxs, paddingVertical: nebulaSpacing.xs,
  }}>
    <Text accessibilityRole="header" style={{ color: t.text, fontWeight: "800", fontSize: 16, letterSpacing: -0.5 }}>
      Pers<Text style={{ color: t.accent }}>AI</Text>
    </Text>
    <View style={{ width: 44, height: 44, justifyContent: "center", alignItems: "center" }}>
      {showOrb ? <NebulaHomeArtwork size={44} phase={orbPhase} /> : null}
    </View>
    <View testID="nebula-home-status" accessible accessibilityRole="text"
      accessibilityLabel={"Статус помощника: " + statusText}
      accessibilityLiveRegion="polite"
      style={{ flex: 1, minWidth: 0, justifyContent: "center", paddingHorizontal: 2 }}>
      <Text numberOfLines={2} ellipsizeMode="tail"
        style={{ color: t.text, fontSize: 12, lineHeight: 16, fontWeight: "600" }}>
        {statusText}
      </Text>
    </View>
    <IconAction icon="clock" label="" accessibilityLabel="История диалогов"
      hint="Открыть сохранённые диалоги и найти прошлые сообщения."
      onPress={onHistory} />
    <IconAction icon="edit" label="" accessibilityLabel="Новый диалог"
      hint="Начать пустой диалог. Предыдущие диалоги останутся в истории."
      disabled={!newChatEnabled} onPress={onNewChat} />
  </View>;
}
