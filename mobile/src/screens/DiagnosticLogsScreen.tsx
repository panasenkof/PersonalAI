import { useFocusEffect, useNavigation } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import React, { useCallback, useState } from "react";
import { ActivityIndicator, Alert, Pressable, ScrollView, Switch, Text, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useProfile } from "../profile/ProfileContext";
import { useTheme } from "../theme";
import type { RootStackParams } from "../navigation";
import { withNativeInteraction } from "../security/native-interaction";
import { DEFAULT_DIAGNOSTICS, deleteDiagnosticFiles, getDiagnosticSettings, listDiagnosticFiles, setDiagnosticSettings, shareDiagnosticFile } from "../direct-agent/diagnostics";
import type { DiagnosticFile, DiagnosticSettings } from "../direct-agent/diagnostics";

/** Temporary QA-only screen. Files are private; nothing is uploaded automatically. */
export function DiagnosticLogsScreen() {
  const profile = useProfile();
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParams>>();
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const [prefs, setPrefs] = useState<DiagnosticSettings>(DEFAULT_DIAGNOSTICS);
  const [logs, setLogs] = useState<DiagnosticFile[]>([]);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [ready, setReady] = useState(false);
  const card = { backgroundColor: t.panel, borderWidth: 1, borderColor: t.line, borderRadius: 18, padding: 16 };
  const refresh = useCallback(async () => {
    if (!profile) return;
    const [settings, files] = await Promise.all([getDiagnosticSettings(profile), listDiagnosticFiles(profile)]);
    setPrefs(settings); setLogs(files); setReady(true);
  }, [profile]);
  useFocusEffect(useCallback(() => {
    let current = true;
    if (profile) {
      void Promise.all([getDiagnosticSettings(profile), listDiagnosticFiles(profile)]).then(([settings, files]) => {
        if (current) { setPrefs(settings); setLogs(files); setReady(true); }
      }).catch(() => { if (current) setNotice("Не удалось прочитать журналы"); });
    }
    return () => { current = false; };
  }, [profile]));
  const run = async (operation: () => Promise<void>, success?: string) => {
    if (!profile || busy) return;
    setBusy(true); setNotice("");
    try {
      await operation();
      if (success) setNotice(success);
      await refresh();
    } catch { setNotice("Операция с журналом не выполнена. Повторите попытку."); }
    finally { setBusy(false); }
  };
  const update = (next: DiagnosticSettings) => void run(async () => {
    await setDiagnosticSettings(profile!, next);
  });
  const confirmClear = () => Alert.alert("Удалить диагностические журналы?", "Все файлы диагностики этого профиля будут удалены без возможности восстановления.", [
    { text: "Отмена", style: "cancel" },
    { text: "Удалить", style: "destructive", onPress: () => void run(() => deleteDiagnosticFiles(profile!), "Журналы удалены.") },
  ]);
  const control = (title: string, detail: string, checked: boolean, disabled: boolean, change: (v: boolean) => void) =>
    <View style={{ ...card, gap: 10 }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
        <Text style={{ color: t.text, fontSize: 16, fontWeight: "700", flex: 1 }}>{title}</Text>
        <Switch accessibilityLabel={title} disabled={disabled || busy || !ready} value={checked} onValueChange={change} />
      </View>
      <Text style={{ color: t.muted, lineHeight: 20 }}>{detail}</Text>
    </View>;
  return <ScrollView style={{ flex: 1, backgroundColor: t.bg }} contentContainerStyle={{ padding: 18, paddingBottom: insets.bottom + 30, gap: 14 }}>
    <Text style={{ color: t.text, fontSize: 24, fontWeight: "800" }}>Диагностика диалогов</Text>
    <Text style={{ color: t.muted, lineHeight: 21 }}>Временная функция для тестирования PersAI. Журналы JSONL сохраняются только во внутреннем хранилище приложения. Они не отправляются разработчикам автоматически.</Text>
    <View style={{ gap: 8 }}>
      <Text accessibilityRole="header" style={{ color: t.text, fontSize: 18, fontWeight: "700" }}>Для разработчика</Text>
      <Pressable testID="open-nebula-lab" accessibilityRole="button"
        accessibilityLabel="Открыть лабораторию Nebula"
        accessibilityHint="Экспериментальный экран Skia, не влияет на переписку и память"
        onPress={() => navigation.navigate("NebulaLab")}
        style={{ ...card, gap: 6, minHeight: 48 }}>
        <Text style={{ color: t.accent, fontSize: 16, fontWeight: "700" }}>Лаборатория Nebula →</Text>
        <Text style={{ color: t.muted, lineHeight: 20 }}>
          Сфера B+C: состояния, размеры 44/168 dp, отключение движения. Экспериментальная графика Skia, не подключена к чату.
        </Text>
      </Pressable>
    </View>
    {control("Записывать диагностические события",
      "Этапы обработки вопроса, решения о поиске, вызовы LLM, инструменты, время и ошибки. По умолчанию отключено.",
      prefs.enabled, false, enabled => update({ enabled, includeContent: enabled && prefs.includeContent }))}
    {control("Включить тексты запросов и ответов",
      "Для детального анализа LLM. Файл может содержать личные сведения из диалога, поэтому включайте только на время воспроизведения ошибки и проверяйте перед отправкой. Ключи маскируются по типовым шаблонам, но полная автоматическая очистка личных данных не гарантируется.",
      prefs.includeContent, !prefs.enabled, includeContent => update({ enabled: true, includeContent }))}
    <Text style={{ color: t.muted, lineHeight: 21 }}>Хранение: до 7 дней, не более 12 файлов примерно по 2 МБ. После отключения уже собранные журналы сохраняются до удаления или истечения срока хранения.</Text>
    <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginTop: 8 }}>
      <Text style={{ color: t.text, fontSize: 20, fontWeight: "700" }}>Журналы ({logs.length})</Text>
      {busy ? <ActivityIndicator color={t.accent} /> : null}
    </View>
    {!logs.length ? <Text style={{ color: t.muted }}>Файлов пока нет. Включите диагностику и отправьте сообщение помощнику.</Text> : logs.map(file =>
      <Pressable key={file.name} accessibilityRole="button" accessibilityLabel={"Поделиться журналом " + file.name}
        disabled={busy} onPress={() => void run(() => withNativeInteraction(() => shareDiagnosticFile(profile!, file.name)))}
        style={{ ...card, gap: 6 }}>
        <Text style={{ color: t.accent, fontWeight: "700" }}>{file.name} ↗</Text>
        <Text style={{ color: t.muted }}>{Math.max(1, Math.ceil(file.size / 1024))} КБ · нажмите, чтобы передать файл</Text>
      </Pressable>)}
    <Pressable accessibilityRole="button" accessibilityLabel="Обновить список журналов" disabled={busy}
      onPress={() => void run(async () => {})} style={{ ...card, alignItems: "center" }}>
      <Text style={{ color: t.accent, fontWeight: "700" }}>Обновить список</Text>
    </Pressable>
    {logs.length ? <Pressable accessibilityRole="button" accessibilityLabel="Удалить все журналы" disabled={busy}
      onPress={confirmClear} style={{ ...card, alignItems: "center" }}>
      <Text style={{ color: "#bf4545", fontWeight: "700" }}>Удалить все журналы</Text>
    </Pressable> : null}
    {notice ? <Text accessibilityRole="alert" style={{ color: t.muted }}>{notice}</Text> : null}
  </ScrollView>;
}
