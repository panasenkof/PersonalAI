import { useFocusEffect, useNavigation } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import React, { useCallback, useState } from "react";
import { Alert, FlatList, Pressable, RefreshControl, StyleSheet, Text, View } from "react-native";

import { api } from "../api/client";
import { FloatingBrand } from "../components/FloatingBrand";
import { useTheme } from "../theme";
import { authError } from "../ux";
import type { Conversation } from "../types";
import type { RootStackParams } from "../navigation";

const CHANNEL_ICON: Record<string, string> = {
  telegram: "✈️", max: "✦", slack: "💬", whatsapp: "●",
  discord: "☷", mobile: "◇", web: "◎",
};
const SUGGESTIONS = [
  { symbol: "✦", label: "Помоги составить план", prompt: "Помоги составить план на неделю" },
  { symbol: "✎", label: "Написать текст", prompt: "Помоги написать текст" },
  { symbol: "◈", label: "Разобрать идею", prompt: "Помоги разобрать мою идею" },
];
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
      setItems(convs); setPending(facts.facts.length); setError("");
    } catch (e) { setError(authError(String((e as Error).message))); }
    finally { setRefreshing(false); }
  }, []);
  useFocusEffect(useCallback(() => { void load(); }, [load]));

  function remove(c: Conversation) {
    Alert.alert("Удалить чат?", c.title ?? "Без названия", [
      { text: "Отмена", style: "cancel" },
      { text: "Удалить", style: "destructive", onPress: async () => {
        await api.deleteConversation(c.id).catch((e) => setError(authError(String((e as Error).message))));
        void load();
      } },
    ]);
  }
  const openChat = (initialPrompt?: string) => navigation.navigate("Chat", { initialPrompt });
  return (
    <View style={{ flex: 1, backgroundColor: t.bg }}>
      {pending > 0 && (
        <Pressable accessibilityRole="button" accessibilityLabel="Проверить факты ожидающие подтверждения"
          style={[styles.banner, { backgroundColor: t.warn, borderColor: t.line }]}
          onPress={() => openChat()}>
          <Text style={{ color: t.text }}>◈ Ждут подтверждения: {pending}. Проверить →</Text>
        </Pressable>
      )}
      {error ? (
        <View style={{ padding: 16, gap: 8 }}>
          <Text accessibilityRole="alert" style={{ color: t.err }}>{error}</Text>
          <Pressable accessibilityRole="button" onPress={() => void load()}
            style={{ minHeight: 44, justifyContent: "center" }}>
            <Text style={{ color: t.accent }}>Повторить загрузку</Text>
          </Pressable>
        </View>
      ) : null}
      <FlatList data={items} keyExtractor={c => c.id}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={load} tintColor={t.accent}/>}
        contentContainerStyle={{ paddingHorizontal: 16, paddingTop: 18, paddingBottom: 96, flexGrow: 1 }}
        ListHeaderComponent={items.length ? (
          <View style={{ marginBottom: 18, gap: 8 }}>
            <Text style={{ color: t.accent, letterSpacing: 1.4, fontWeight: "700", fontSize: 12 }}>
              PERSAI · ВАШЕ ПРОСТРАНСТВО
            </Text>
            <Text style={{ color: t.text, fontSize: 28, fontWeight: "800" }}>Мои диалоги</Text>
            <Text style={{ color: t.muted }}>Возвращайтесь к важному в любое время.</Text>
          </View>
        ) : null}
        ListEmptyComponent={refreshing || error ? null : (
          <View style={{ flex: 1, justifyContent: "center", gap: 16 }}>
            <View style={{ alignItems: "center" }}>
              <FloatingBrand size={166} />
              <Text style={{ color: t.text, fontSize: 34, fontWeight: "800",
                letterSpacing: -.8, marginTop: -5 }}>Pers<Text style={{ color: t.violet }}>AI</Text></Text>
              <Text style={{ color: t.muted, fontSize: 15, textAlign: "center",
                lineHeight: 22, marginTop: 4 }}>
                Ваш личный ИИ-ассистент с памятью{"\n"}и свободой выбора модели
              </Text>
            </View>
            <View style={[styles.hero, { backgroundColor: t.soft, borderColor: t.line }]}>
              <View style={[styles.accentBubble, { backgroundColor: t.glow }]} />
              <Text style={{ color: t.text, fontSize: 19, fontWeight: "800", marginBottom: 7 }}>
                Больше, чем ответы ✦
              </Text>
              <Text style={{ color: t.muted, lineHeight: 21, marginBottom: 12 }}>
                Обсуждайте идеи, сохраняйте важное и возвращайтесь к своим знаниям.
              </Text>
              <Pressable accessibilityRole="button" accessibilityLabel="Начать первый чат"
                style={[styles.cta, { backgroundColor: t.accent }]}
                onPress={() => openChat()}>
                <Text style={{ color: "#FFFFFF", fontWeight: "700" }}>Начать разговор  →</Text>
              </Pressable>
            </View>
            <Text style={{ color: t.text, fontSize: 15, fontWeight: "700" }}>С чего начнём?</Text>
            <View style={{ gap: 9 }}>
              {SUGGESTIONS.map(item => (
                <Pressable key={item.label} accessibilityRole="button"
                  accessibilityLabel={item.label}
                  onPress={() => openChat(item.prompt)}
                  style={[styles.suggestion, { backgroundColor: t.panel, borderColor: t.line }]}>
                  <Text style={{ color: t.violet, fontSize: 18 }}>{item.symbol}</Text>
                  <Text style={{ color: t.text, flex: 1, fontWeight: "600" }}>{item.label}</Text>
                  <Text style={{ color: t.accent }}>→</Text>
                </Pressable>
              ))}
            </View>
            <Text style={{ color: t.muted, fontSize: 12, textAlign: "center" }}>
              Ответы ИИ требуют проверки. Память передаётся модели только с вашего разрешения.
            </Text>
          </View>
        )}
        ItemSeparatorComponent={() => <View style={{ height: 9 }} />}
        renderItem={({ item }) => (
          <Pressable accessibilityRole="button"
            accessibilityLabel={"Открыть чат " + (item.title || "Без названия")}
            style={[styles.row, { backgroundColor: t.panel, borderColor: t.line }]}
            onPress={() => navigation.navigate("Chat", {
              conversationId: item.id, title: item.title ?? undefined,
            })}
            onLongPress={() => remove(item)}>
            <View style={[styles.channel, { backgroundColor: t.soft }]}>
              <Text style={{ color: t.accent, fontSize: 19 }}>
                {CHANNEL_ICON[item.channel] ?? "◉"}
              </Text>
            </View>
            <View style={{ flex: 1, gap: 5 }}>
              <Text style={{ color: t.text, fontWeight: "600", fontSize: 16 }}
                numberOfLines={1}>{item.title || "Без названия"}</Text>
              <Text style={{ color: t.muted, fontSize: 12 }}>{item.channel}</Text>
            </View>
            <Text style={{ color: t.muted, fontSize: 12 }}>{when(item.updated_at)}</Text>
          </Pressable>
        )}
      />
      {items.length > 0 && (
        <Pressable accessibilityRole="button" accessibilityLabel="Новый чат"
          style={[styles.fab, { backgroundColor: t.accent }]} onPress={() => openChat()}>
          <Text style={{ color: "#FFFFFF", fontSize: 26 }}>＋</Text>
        </Pressable>
      )}
    </View>
  );
}
const styles = StyleSheet.create({
  hero: { borderWidth: 1, borderRadius: 24, padding: 20, overflow: "hidden" },
  accentBubble: { position: "absolute", height: 125, width: 125, borderRadius: 63, right: -36, top: -45, opacity: .65 },
  cta: { minHeight: 50, borderRadius: 16, alignItems: "center", justifyContent: "center" },
  suggestion: { flexDirection: "row", alignItems: "center", gap: 12, minHeight: 56,
    borderWidth: 1, borderRadius: 16, paddingHorizontal: 16 },
  channel: { width: 44, height: 44, borderRadius: 15, alignItems: "center", justifyContent: "center" },
  row: { flexDirection: "row", alignItems: "center", gap: 12, padding: 14, borderRadius: 18, borderWidth: 1 },
  banner: { margin: 12, padding: 14, borderRadius: 14, borderWidth: 1 },
  fab: { position: "absolute", right: 20, bottom: 24, width: 56, height: 56, borderRadius: 20,
    alignItems: "center", justifyContent: "center", elevation: 4 },
});
