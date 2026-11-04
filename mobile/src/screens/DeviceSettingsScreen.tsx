import { useFocusEffect, useNavigation } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import Constants from "expo-constants";
import React, { useCallback, useState } from "react";
import { ScrollView, Text } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useProfile } from "../profile/ProfileContext";
import { loadDirectConnections } from "../direct-agent/settings";
import { loadModelCallLimit } from "../direct-agent/agent-preferences";
import { loadPhotoResultCount } from "../media/photo-result-preferences";
import { resolveVoiceEngine, useVoiceEngine } from "../media/voice-engine";
import type { RootStackParams } from "../navigation";
import type { SettingsTopic } from "./SettingsDetailScreen";
import { NebulaSettingRow, NebulaSection } from "../design/nebula/components";
import { nebulaSpacing, nebulaTypography } from "../design/nebula/tokens";
import { useTheme } from "../theme";

/** Short settings index. Editors remain canonical on their own pages, so the
 * user never scrolls through several model cards to reach a single option. */
export function DeviceSettingsScreen() {
  const profile = useProfile();
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParams>>();
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const voice = useVoiceEngine();
  const [model, setModel] = useState("Выберите подключение");
  const [limit, setLimit] = useState<number | null>(null);
  const [photoCount, setPhotoCount] = useState<number | null>(null);

  useFocusEffect(useCallback(() => {
    let alive = true;
    if (!profile) {
      setModel("Выберите подключение"); setLimit(null); setPhotoCount(null);
      return () => { alive = false; };
    }
    void loadDirectConnections(profile).then(value => {
      const active = value.connections.find(c => c.id === value.activeId);
      if (alive) setModel(active ? active.name + " · " + active.model : "Выберите подключение");
    }).catch(() => { if (alive) setModel("Открыть подключения"); });
    void loadModelCallLimit(profile).then(value => { if (alive) setLimit(value); })
      .catch(() => { if (alive) setLimit(null); });
    void loadPhotoResultCount(profile).then(value => { if (alive) setPhotoCount(value); })
      .catch(() => { if (alive) setPhotoCount(null); });
    return () => { alive = false; };
  }, [profile]));

  const open = (topic: SettingsTopic) => navigation.navigate("SettingsDetail", { topic });
  const engine = voice.pending ?? resolveVoiceEngine(voice.preference, false);
  const voiceSummary = !voice.loaded ? "Загружаю способ ввода…" :
    engine === "whisper" ? "Whisper · распознавание на телефоне" :
    "Google · системное распознавание";

  return <ScrollView testID="settings-overview" style={{ flex: 1, backgroundColor: t.bg }}
    keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag"
    contentContainerStyle={{ padding: nebulaSpacing.md, gap: nebulaSpacing.xl,
      paddingBottom: insets.bottom + nebulaSpacing.xl }}>
    <NebulaSection title="Помощник">
      <NebulaSettingRow icon="cpu" title="Модели и подключения" summary={model}
        onPress={() => navigation.navigate("ModelConnections")} />
      <NebulaSettingRow icon="mic" title="Голосовой ввод" summary={voiceSummary} onPress={() => open("voice")} />
      <NebulaSettingRow icon="sliders" title="Работа ИИ"
        summary={limit !== null ? `До ${limit} обращений к LLM на сообщение` : "Лимит обращений к модели"}
        onPress={() => open("limits")} />
      <NebulaSettingRow icon="search" title="Умный поиск по памяти"
        summary="Поиск по смыслу и дополнительные слова" onPress={() => open("smart-search")} />
    </NebulaSection>
    <NebulaSection title="Мультимедиа">
      <NebulaSettingRow icon="image" title="Фото и поиск"
        summary={photoCount !== null ? `До ${photoCount} результатов · модели поиска` : "Модели и результаты поиска"}
        onPress={() => open("photos")} />
      <NebulaSettingRow icon="file-text" title="Распознавание файлов"
        summary="Фото, PDF, аудио и видео · выбор подключений" onPress={() => open("media")} />
    </NebulaSection>
    <NebulaSection title="Данные">
      <NebulaSettingRow icon="archive" title="Резервные копии"
        summary="Записи и диалоги · перенос на другой телефон"
        onPress={() => navigation.navigate("MemoryBackup")} />
    </NebulaSection>
    <NebulaSection title="Обслуживание">
      <NebulaSettingRow icon="activity" title="Диагностика диалогов"
        summary="Журналы работы и разбор ошибок" onPress={() => navigation.navigate("DiagnosticLogs")} />
      <Text selectable style={{ color: t.muted, ...nebulaTypography.label }}>
        PersAI {Constants.expoConfig?.version || "—"} · {String(Constants.expoConfig?.extra?.buildSha || "—").slice(0, 7)}
      </Text>
    </NebulaSection>
  </ScrollView>;
}
