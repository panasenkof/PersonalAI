import { useNavigation } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import Constants from "expo-constants";
import React from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { useAuth } from "../auth/AuthContext";
import type { RootStackParams } from "../navigation";
import { useTheme } from "../theme";
import { SettingsScreen } from "./SettingsScreen";
export function DeviceSettingsScreen() {
  const { offlineMode, closeOffline } = useAuth();
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParams>>();
  const t = useTheme();
  if (!offlineMode) return <SettingsScreen />;
  const card = { backgroundColor: t.panel, padding: 20, gap: 12, borderRadius: 22, borderWidth: 1, borderColor: t.line };
  return <ScrollView style={{ flex: 1, backgroundColor: t.bg }} contentContainerStyle={{ padding: 18, gap: 16, paddingBottom: 44 }}>
    <Text style={{ color: t.text, fontSize: 28, fontWeight: "800" }}>Настройки</Text>
    <Pressable accessibilityRole="button" accessibilityLabel="Настроить подключение ИИ" style={card} onPress={() => navigation.navigate("DirectAgentSettings")}>
      <Text style={{ color: t.text, fontSize: 18, fontWeight: "700" }}>Модели и подключения →</Text>
      <Text style={{ color: t.muted, lineHeight: 20 }}>Сохранённые сервисы, локальные модели, поиск и доступ ассистента к памяти.</Text>
    </Pressable>
    <View style={card}>
      <Text style={{ color: t.text, fontSize: 18, fontWeight: "700" }}>Безопасность</Text>
      <Text style={{ color: t.muted, lineHeight: 21 }}>Вход во всё приложение защищён биометрией. При сворачивании доступ блокируется. Заметки зашифрованы на телефоне.</Text>
    </View>
    <View style={card}>
      <Text style={{ color: t.text, fontSize: 18, fontWeight: "700" }}>Работа на телефоне</Text>
      <Text style={{ color: t.muted, lineHeight: 21 }}>Сервер PersAI не требуется. Модель может работать у провайдера или в вашей локальной сети. Резервные копии доступны в разделе «Память».</Text>
      <Pressable accessibilityRole="button" accessibilityLabel="Войти на сервер" onPress={() => void closeOffline()} style={{ minHeight: 46, justifyContent: "center" }}>
        <Text style={{ color: t.accent, fontWeight: "600" }}>Подключить серверный аккаунт →</Text>
      </Pressable>
    </View>
    <Text style={{ color: t.muted, fontSize: 12 }}>PersAI {Constants.expoConfig?.version || "—"} · {String(Constants.expoConfig?.extra?.buildSha || "—").slice(0, 7)}</Text>
  </ScrollView>;
}
