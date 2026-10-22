import Feather from "@expo/vector-icons/Feather";
import React from "react";
import { Pressable, Text, View } from "react-native";
import { useTheme } from "../../theme";
import { nebulaRadii, nebulaSpacing, nebulaTouch } from "./tokens";
import { IconAction } from "../../components/IconAction";

/**
 * Phase A of the approved Home v0.3 migration: compact functional header.
 * Preserves exactly the same navigation actions and accessible labels.
 * Model configuration and history logic stay owned by HomeScreen.
 */
export function NebulaHomeHeader({
  connectionName,
  model,
  onConnections,
  onHistory,
  onNewChat,
  newChatEnabled,
}: {
  connectionName: string;
  model: string | undefined;
  onConnections: () => void;
  onHistory: () => void;
  onNewChat: () => void;
  newChatEnabled: boolean;
}) {
  const t = useTheme();
  return <View testID="nebula-home-header" style={{
    minHeight: 60, flexDirection: "row", alignItems: "center",
    gap: nebulaSpacing.xs, backgroundColor: t.panel,
    borderBottomWidth: 1, borderColor: t.line,
    paddingHorizontal: nebulaSpacing.sm, paddingVertical: nebulaSpacing.xs,
  }}>
    <Text accessibilityRole="header" style={{ color: t.text, fontWeight: "800", fontSize: 18, letterSpacing: -0.5 }}>
      Pers<Text style={{ color: t.accent }}>AI</Text>
    </Text>
    <Pressable accessibilityRole="button" accessibilityLabel="Выбрать модель и подключение"
      accessibilityHint="Открыть выбранное подключение и его настройки"
      onPress={onConnections} style={{
        flex: 1, minWidth: 0, minHeight: nebulaTouch.minimum, borderRadius: nebulaRadii.pill,
        backgroundColor: t.soft, paddingHorizontal: nebulaSpacing.sm,
        alignItems: "center", justifyContent: "center",
      }}>
      <Text numberOfLines={1} style={{ width: "100%", color: t.text, fontSize: 12, fontWeight: "600" }}>
        {connectionName || "Выбрать модель"} · {model || "Нет подключения"} ▾
      </Text>
    </Pressable>
    {/* Keep IconAction's existing in-place hint contract: browser and
        accessibility tests expect the explanatory text on first activation. */}
    <IconAction icon="clock" label="" accessibilityLabel="История диалогов"
      hint="Открыть сохранённые диалоги и найти прошлые сообщения."
      onPress={onHistory} />
    <IconAction icon="edit" label="" accessibilityLabel="Новый диалог"
      hint="Начать пустой диалог. Предыдущие диалоги останутся в истории."
      disabled={!newChatEnabled} onPress={onNewChat} />
  </View>;
}
