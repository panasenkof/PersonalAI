import React, { useEffect, useRef, useState } from "react";
import { Alert, Platform, Pressable, Text, View } from "react-native";
import * as DocumentPicker from "expo-document-picker";
import { onLocalMemorySessionChange } from "../local-memory/storage";
import { nebulaRadii, nebulaSpacing, nebulaTouch, nebulaTypography } from "../design/nebula/tokens";
import { useTheme } from "../theme";
import { runAndroidFileProbe, type AndroidFileProbeResult } from "./android-file-asr-probe";

/** Developer-only feasibility control. NOT a user-selectable ASR engine.
 * No result is automatically saved and the probe is absent from release builds.
 */
export function AndroidFileAsrProbe() {
  const t = useTheme();
  const active = useRef<AbortController | null>(null);
  const mounted = useRef(true);
  const [result, setResult] = useState<AndroidFileProbeResult | null>(null);
  const [running, setRunning] = useState(false);

  useEffect(() => {
    mounted.current = true;
    const off = onLocalMemorySessionChange(unlocked => {
      if (!unlocked) active.current?.abort();
    });
    return () => {
      mounted.current = false;
      active.current?.abort();
      off();
    };
  }, []);

  if (!__DEV__ || Platform.OS !== "android" || Number(Platform.Version) < 33) return null;

  async function start(uri: string) {
    if (active.current) return;
    const controller = new AbortController();
    active.current = controller;
    setResult(null); setRunning(true);
    try {
      const checked = await runAndroidFileProbe(uri, controller.signal);
      if (mounted.current && active.current === controller) setResult(checked);
    } finally {
      if (active.current === controller) active.current = null;
      if (mounted.current) setRunning(false);
    }
  }

  async function choose() {
    if (running || active.current) return;
    try {
      const picked = await DocumentPicker.getDocumentAsync({ type: "audio/*", multiple: false, copyToCacheDirectory: true });
      if (picked.canceled || !picked.assets?.[0]) return;
      const uri = picked.assets[0].uri;
      Alert.alert(
        "Проверка Android file-ASR",
        "Выберите только не конфиденциальную тестовую запись речи до 12 секунд. Системная служба может игнорировать файл, включить МИКРОФОН или обращаться в интернет, несмотря на запрос локального режима. Ничего не будет записано в заметки. Наблюдайте индикатор микрофона на устройстве.",
        [{ text: "Отмена", style: "cancel" }, { text: "Разрешить эксперимент", onPress: () => void start(uri) }],
      );
    } catch {
      if (mounted.current) setResult({ status: "error", reason: "Не удалось выбрать тестовый файл." });
    }
  }

  return <View style={{ gap: nebulaSpacing.sm, borderTopWidth: 1, borderColor: t.line, paddingTop: nebulaSpacing.md }}>
    <Text style={{ color: t.text, ...nebulaTypography.label, fontWeight: "700" }}>Лаборатория · системное распознавание файла</Text>
    <Text style={{ color: t.muted, ...nebulaTypography.label }}>
      Только отладочная сборка. Результат не подтверждает чтение файла, пока не исключён захват через микрофон.
    </Text>
    <Pressable accessibilityRole="button" accessibilityLabel="Проверить распознавание тестового аудиофайла Android"
      accessibilityState={{ disabled: running }} disabled={running} onPress={() => void choose()}
      style={{ minHeight: nebulaTouch.minimum, borderColor: t.line, borderWidth: 1,
        borderRadius: nebulaRadii.field, justifyContent: "center", paddingHorizontal: nebulaSpacing.md, backgroundColor: t.panel }}>
      <Text style={{ color: t.secondary, ...nebulaTypography.label }}>{running ? "Проверяю тестовую запись…" : "Выбрать тестовый файл"}</Text>
    </Pressable>
    {running ? <Pressable accessibilityRole="button" accessibilityLabel="Отменить тест системного распознавания"
      onPress={() => active.current?.abort()} style={{ minHeight: nebulaTouch.minimum, justifyContent: "center" }}>
      <Text style={{ color: t.text, ...nebulaTypography.label }}>Отменить тест</Text>
    </Pressable> : null}
    {result ? <Text accessibilityLiveRegion="polite" style={{ color: result.status === "error" ? t.err : t.muted, ...nebulaTypography.label }}>
      {result.status === "observed" ? "Получен текст (источник пока не подтверждён): " + result.transcript +
        ". Сверьте его с файлом и убедитесь, что микрофон не использовался." : result.reason}
    </Text> : null}
  </View>;
}
