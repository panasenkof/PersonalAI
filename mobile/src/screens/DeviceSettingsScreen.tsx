import { useFocusEffect, useNavigation } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import Constants from "expo-constants";
import React, { useCallback, useState } from "react";
import { KeyboardAvoidingView, Platform, ScrollView, Text } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useProfile } from "../profile/ProfileContext";
import { loadDirectConnections, type DirectConnection } from "../direct-agent/settings";
import { MediaSettings } from "../media/MediaSettings";
import { Collapsible } from "../components/Collapsible";
import type { RootStackParams } from "../navigation";
import { NebulaSettingRow, NebulaSection } from "../design/nebula/components";
import { nebulaSpacing, nebulaTypography } from "../design/nebula/tokens";
import { useTheme } from "../theme";
import { VoiceModelCard } from "../components/VoiceModelCard";
import { SmartSearchCard } from "../components/SmartSearchCard";
import { VisionModelCard } from "../components/VisionModelCard";
import { AgentLimitsCard } from "../components/AgentLimitsCard";

export function DeviceSettingsScreen() {
  const profile = useProfile();
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParams>>();
  const t = useTheme(); const insets = useSafeAreaInsets();
  const [model, setModel] = useState("Выберите сервис и модель");
  const [connections, setConnections] = useState<DirectConnection[]>([]);
  useFocusEffect(useCallback(() => {
    let alive = true;
    if (profile) void loadDirectConnections(profile).then(value => {
      const active = value.connections.find(c => c.id === value.activeId);
      if (alive) { setModel(active ? active.name + " · " + active.model : "Выберите подключение"); setConnections(value.connections); }
    }).catch(() => { if (alive) { setModel("Открыть подключения"); setConnections([]); } });
    return () => { alive = false; };
  }, [profile]));
  return <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === "ios" ? "padding" : "height"}>
    <ScrollView testID="settings-overview" style={{ flex: 1, backgroundColor: t.bg }} keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag" contentContainerStyle={{ padding: nebulaSpacing.md, gap: nebulaSpacing.xl, paddingBottom: insets.bottom + nebulaSpacing.xl }}>
      <NebulaSection title="Помощник">
        <NebulaSettingRow icon="cpu" title="Модели и подключения" summary={model} onPress={() => navigation.navigate("ModelConnections")} />
        <VoiceModelCard />
        <SmartSearchCard />
        <AgentLimitsCard key={profile} />
      </NebulaSection>
      <NebulaSection title="Мультимедиа">
        <VisionModelCard />
        <Collapsible id="settings.media-routing" icon="image" title="Распознавание файлов"
          summary="Фото, видео и аудио · выбор подключений">
          {profile && connections.length
            ? <MediaSettings profile={profile} connections={connections} />
            : <Text style={{ color: t.muted, ...nebulaTypography.label }}>
                Сначала настройте хотя бы одно подключение в разделе «Модели и подключения».
              </Text>}
        </Collapsible>
      </NebulaSection>
      <NebulaSection title="Данные">
        <NebulaSettingRow icon="archive" title="Резервные копии" summary="Записи и диалоги · перенос на другой телефон" onPress={() => navigation.navigate("MemoryBackup")} />
      </NebulaSection>
      <NebulaSection title="Обслуживание">
        <NebulaSettingRow icon="activity" title="Диагностика диалогов" summary="Журналы работы и разбор ошибок" onPress={() => navigation.navigate("DiagnosticLogs")} />
        <Text selectable style={{ color: t.muted, ...nebulaTypography.label }}>PersAI {Constants.expoConfig?.version || "—"} · {String(Constants.expoConfig?.extra?.buildSha || "—").slice(0, 7)}</Text>
      </NebulaSection>
    </ScrollView></KeyboardAvoidingView>;
}
