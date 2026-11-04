import { useFocusEffect, useNavigation, useRoute } from "@react-navigation/native";
import type { RouteProp } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { useHeaderHeight } from "@react-navigation/elements";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import React, { useCallback, useState } from "react";
import { KeyboardAvoidingView, Platform, ScrollView, Text } from "react-native";
import type { RootStackParams } from "../navigation";
import { useProfile } from "../profile/ProfileContext";
import { useTheme } from "../theme";
import { loadDirectConnections, type DirectConnection } from "../direct-agent/settings";
import { MediaSettings } from "../media/MediaSettings";
import { VoiceModelCard } from "../components/VoiceModelCard";
import { SmartSearchCard } from "../components/SmartSearchCard";
import { AgentLimitsCard } from "../components/AgentLimitsCard";
import { VisionModelCard } from "../components/VisionModelCard";
import { PhotoResultsSettings } from "../components/PhotoResultsSettings";
import { NebulaAction, NebulaSection } from "../design/nebula/components";
import { nebulaSpacing, nebulaTypography } from "../design/nebula/tokens";

export type SettingsTopic = "voice" | "smart-search" | "limits" | "photos" | "media";

export function SettingsDetailScreen() {
  const route = useRoute<RouteProp<RootStackParams, "SettingsDetail">>();
  return <SettingsDetailContent topic={route.params.topic} />;
}

/** Historical camera/photo-search route uses the SAME owner, not a duplicate model editor. */
export function PhotoSearchSettingsScreen() {
  return <SettingsDetailContent topic="photos" />;
}

function SettingsDetailContent({ topic }: { topic: SettingsTopic }) {
  const profile = useProfile();
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParams>>();
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const header = useHeaderHeight();
  const [connections, setConnections] = useState<DirectConnection[]>([]);
  const [mediaState, setMediaState] = useState<"loading" | "ready" | "error">("loading");

  useFocusEffect(useCallback(() => {
    if (topic !== "media") return;
    let active = true;
    setConnections([]);
    setMediaState("loading");
    if (!profile) { setMediaState("error"); return; }
    void loadDirectConnections(profile).then(saved => {
      if (active) { setConnections(saved.connections); setMediaState("ready"); }
    }).catch(() => { if (active) setMediaState("error"); });
    return () => { active = false; };
  }, [profile, topic]));

  return <KeyboardAvoidingView style={{ flex: 1, backgroundColor: t.bg }}
    behavior={Platform.OS === "ios" ? "padding" : "height"} keyboardVerticalOffset={Platform.OS === "ios" ? header : 0}>
    <ScrollView testID="settings-detail" style={{ flex: 1 }}
      keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag"
      contentContainerStyle={{ padding: nebulaSpacing.md, gap: nebulaSpacing.sm,
        paddingBottom: insets.bottom + nebulaSpacing.xl }}>
      {topic === "voice" ? <VoiceModelCard defaultOpen /> : null}
      {topic === "smart-search" ? <SmartSearchCard defaultOpen /> : null}
      {topic === "limits" ? <AgentLimitsCard key={profile} defaultOpen /> : null}
      {topic === "photos" ? <>
        <VisionModelCard defaultOpen />
        <PhotoResultsSettings key={profile} defaultOpen />
      </> : null}
      {topic === "media" ? <NebulaSection title="Распознавание файлов">
        {mediaState === "ready" && profile && connections.length > 0
          ? <MediaSettings profile={profile} connections={connections} />
          : <Text accessibilityLiveRegion="polite"
              style={{ color: t.muted, ...nebulaTypography.label }}>
              {mediaState === "loading" ? "Загружаю подключения…" :
                mediaState === "error" ? "Не удалось прочитать подключения." :
                "Сначала настройте хотя бы одно подключение модели."}
            </Text>}
        {(mediaState === "error" || (mediaState === "ready" && !connections.length))
          ? <NebulaAction icon="cpu" label="Открыть модели и подключения"
              onPress={() => navigation.navigate("ModelConnections")} />
          : null}
      </NebulaSection> : null}
    </ScrollView>
  </KeyboardAvoidingView>;
}
