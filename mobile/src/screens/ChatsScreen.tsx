import { useFocusEffect, useNavigation } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import React, { useCallback, useState } from "react";
import { Alert, FlatList, Pressable, RefreshControl, StyleSheet, Text, View } from "react-native";

import { authError } from "../ux";
import { api } from "../api/client";
import { useTheme } from "../theme";
import type { Conversation } from "../types";
import type { RootStackParams } from "../navigation";

const CHANNEL_ICON: Record<string, string> = {
  telegram: "✈️", slack: "💬", whatsapp: "🟢", discord: "🎮", mobile: "📱", web: "🌐",
};

function when(iso: string): string {
  const d = new Date(iso);
  const today = new Date();
  return d.toDateString() === today.toDateString()
    ? d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
    : d.toLocaleDateString([], { day: "numeric", month: "short" });
}

export function ChatsScreen() {
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParams>>();
  const t = useTheme();
  const [items, setItems] = useState<Conversation[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState("");
  const [pending, setPending] = useState(0);

  const load = useCallback(async () => {
    setRefreshing(true);
    try {
      const [convs, facts] = await Promise.all([api.conversations(), api.facts().catch(() => ({ facts: [] }))]);
      setItems(convs);
      setPending(facts.facts.length);
      setError("");
    } catch (e) {
      setError(authError(String((e as Error).message)));
    } finally {
      setRefreshing(false);
    }
  }, []);

  useFocusEffect(useCallback(() => { void load(); }, [load]));

  function remove(c: Conversation) {
    Alert.alert("Удалить чат?", c.title ?? "Без названия", [
      { text: "Отмена", style: "cancel" },
      {
        text: "Удалить",
        style: "destructive",
        onPress: async () => {
          await api.deleteConversation(c.id).catch((e) => setError(authError(String((e as Error).message))));
          void load();
        },
      },
    ]);
  }

  return (
    <View style={{ flex: 1, backgroundColor: t.bg }}>
      {pending > 0 ? (
        <Pressable style={[styles.banner, { backgroundColor: t.warn, borderColor: t.line }]} onPress={() => navigation.navigate("Chat", {})}>
          <Text style={{ color: t.text }}>📝 Ждут подтверждения: {pending}. Откройте чат, чтобы проверить.</Text>
        </Pressable>
      ) : null}
      {error ? <View style={{ padding: 16, gap: 8 }}><Text accessibilityRole="alert" style={{ color: t.err }}>{error}</Text><Pressable accessibilityRole="button" onPress={load} style={{ minHeight: 44, justifyContent: "center" }}><Text style={{ color: t.accent }}>Повторить загрузку</Text></Pressable></View> : null}
      <FlatList
        data={items}
        keyExtractor={(c) => c.id}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={load} tintColor={t.accent} />}
        contentContainerStyle={items.length ? undefined : { flexGrow: 1, justifyContent: "center" }}
        ListEmptyComponent={refreshing || error ? null : <View style={{ padding: 28, gap: 16 }}>
          <Text style={{ color: t.text, fontSize: 26, fontWeight: "700" }}>С чего начнём?</Text>
          <Text style={{ color: t.muted }}>Задайте вопрос, сохраните заметку или прикрепите документ. Распознанные факты попадут в базу знаний после вашего подтверждения.</Text>
          <Pressable accessibilityRole="button" style={{ backgroundColor: t.accent, borderRadius: 12, padding: 16 }} onPress={() => navigation.navigate("Chat", {})}><Text style={{ color: "white", fontWeight: "600" }}>Начать первый чат</Text></Pressable>
          <View style={{ minHeight: 44 }}><Text style={{ color: t.muted }}>Настройте модель во вкладке «Настройки», если владелец сервера не настроил её заранее. Ответы ИИ могут содержать ошибки.</Text></View>
        </View>}
        ItemSeparatorComponent={() => <View style={{ height: StyleSheet.hairlineWidth, backgroundColor: t.line }} />}
        renderItem={({ item }) => (
          <Pressable
            style={[styles.row, { backgroundColor: t.panel }]}
            onPress={() => navigation.navigate("Chat", { conversationId: item.id, title: item.title ?? undefined })}
            onLongPress={() => remove(item)}
          >
            <Text style={styles.icon}>{CHANNEL_ICON[item.channel] ?? "💬"}</Text>
            <View style={{ flex: 1 }}>
              <Text style={{ color: t.text, fontSize: 16 }} numberOfLines={1}>{item.title || "Без названия"}</Text>
              <Text style={{ color: t.muted, fontSize: 12 }}>{item.channel}</Text>
            </View>
            <Text style={{ color: t.muted, fontSize: 12 }}>{when(item.updated_at)}</Text>
          </Pressable>
        )}
      />
      <Pressable accessibilityRole="button" accessibilityLabel="Новый чат" style={[styles.fab, { backgroundColor: t.accent }]} onPress={() => navigation.navigate("Chat", {})}>
        <Text style={{ color: "#fff", fontSize: 28, marginTop: -2 }}>＋</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  row: { flexDirection: "row", alignItems: "center", gap: 12, paddingHorizontal: 16, paddingVertical: 14 },
  icon: { fontSize: 22 },
  banner: { margin: 12, padding: 12, borderRadius: 10, borderWidth: 1 },
  fab: { position: "absolute", right: 20, bottom: 24, width: 56, height: 56, borderRadius: 28, alignItems: "center", justifyContent: "center", elevation: 4 },
});
