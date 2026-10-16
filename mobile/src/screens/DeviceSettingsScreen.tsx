import { useFocusEffect, useNavigation } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import Constants from "expo-constants";
import React, { useCallback, useState } from "react";
import { Pressable, ScrollView, Text } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useProfile } from "../profile/ProfileContext";
import { loadDirectConnections } from "../direct-agent/settings";
import type { RootStackParams } from "../navigation";
import { useTheme } from "../theme";
import { VoiceModelCard } from "../components/VoiceModelCard";
import { SmartSearchCard } from "../components/SmartSearchCard";

export function DeviceSettingsScreen() {
  const profile = useProfile();
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParams>>();
  const t = useTheme(); const insets = useSafeAreaInsets();
  const [model, setModel] = useState("Выберите сервис и модель");
  useFocusEffect(useCallback(() => {
    let alive = true;
    if (profile) void loadDirectConnections(profile).then(value => {
      const active = value.connections.find(c => c.id === value.activeId)!;
      if (alive) setModel(active.name + " · " + active.model);
    }).catch(() => { if (alive) setModel("Открыть подключения"); });
    return () => { alive = false; };
  }, [profile]));
  const card = { backgroundColor: t.panel, padding: 20, gap: 10, borderRadius: 22, borderWidth: 1, borderColor: t.line };
  return <ScrollView style={{ flex: 1, backgroundColor: t.bg }} contentContainerStyle={{ padding: 18, gap: 16, paddingBottom: insets.bottom + 24 }}>
    <Text style={{ color: t.muted, lineHeight: 22 }}>Всё для работы вашего помощника.</Text>
    <Pressable accessibilityRole="button" accessibilityLabel="Модели и подключения" style={card} onPress={() => navigation.navigate("ModelConnections")}>
      <Text style={{ color: t.text, fontSize: 19, fontWeight: "700" }}>Модели и подключения →</Text>
      <Text numberOfLines={2} style={{ color: t.accent }}>{model}</Text>
      <Text style={{ color: t.muted, lineHeight: 20 }}>Сохранённые сервисы, адреса, ключи и интернет-поиск.</Text>
    </Pressable>
    <SmartSearchCard />
    <VoiceModelCard />
    <Pressable accessibilityRole="button" accessibilityLabel="Резервные копии" style={card} onPress={() => navigation.navigate("MemoryBackup")}>
      <Text style={{ color: t.text, fontSize: 19, fontWeight: "700" }}>Резервные копии →</Text>
      <Text style={{ color: t.muted, lineHeight: 20 }}>Сохранить записи и диалоги или перенести их на другой телефон.</Text>
    </Pressable>
    <Text style={{ color: t.muted, fontSize: 12 }}>PersAI {Constants.expoConfig?.version || "—"} · {String(Constants.expoConfig?.extra?.buildSha || "—").slice(0, 7)}</Text>
  </ScrollView>;
}
