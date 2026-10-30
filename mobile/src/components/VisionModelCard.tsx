import React from "react";
import { ActivityIndicator, Alert, Pressable, Text, View } from "react-native";
import { useTheme } from "../theme";
import { Collapsible } from "./Collapsible";
import { nebulaRadii, nebulaSpacing, nebulaTouch, nebulaTypography } from "../design/nebula/tokens";
import { VISION_MODELS, type VisionModelId } from "../media/vision-model-catalog";
import { cancelVisionModelDownload, chooseVisionModel, deleteVisionModel,
  downloadVisionModel, useVisionModelStatus } from "../media/vision-model-manager";

/** #83.2 — downloadable model assets, separate from the existing text MiniLM.
 * This intentionally never claims that production photo search is enabled.
 */
export function VisionModelCard() {
  const t = useTheme();
  const state = useVisionModelStatus();
  const downloaded = (id: VisionModelId) => state.installed.some(m => m.id === id);
  const buttonStyle = (disabled: boolean) => ({
    minHeight: nebulaTouch.minimum, paddingHorizontal: nebulaSpacing.md,
    borderRadius: nebulaRadii.field, borderWidth: 1, borderColor: t.line,
    backgroundColor: t.panel, justifyContent: "center" as const,
    alignItems: "center" as const, opacity: disabled ? 0.5 : 1,
  });
  const startDownload = (id: VisionModelId, size: number) => Alert.alert(
    "Загрузить модель поиска фотографий?",
    "Примерный размер: " + size + " МБ. Лучше использовать Wi-Fi и оставить запас свободного места. Модель будет проверена по SHA-256 и сохранена только на телефоне.",
    [{ text: "Отмена", style: "cancel" },
      { text: "Скачать", onPress: () => void downloadVisionModel(id) }]
  );
  const deleteModel = (id: VisionModelId) => Alert.alert(
    "Удалить модель?",
    "Модель будет удалена с телефона. Ваши фотографии, заметки и текстовая память сохранятся.",
    [{ text: "Отмена", style: "cancel" },
      { text: "Удалить", style: "destructive", onPress: () => void deleteVisionModel(id) }]
  );
  const current = VISION_MODELS.find(m => m.id === state.activeId);
  const summary = !state.loaded ? "Загрузка сведений…" :
    state.busy ? "Скачивание " + state.progress + "%" :
    state.installed.length ? "Установлено " + state.installed.length +
      (current ? " · выбрана " + current.title : "") : "Модель ещё не скачана";
  return <Collapsible id="settings.vision-models" icon="image"
    title="Модели поиска по фото" summary={summary}>
    <View style={{ gap: nebulaSpacing.sm }}>
      <Text style={{ color: t.muted, ...nebulaTypography.label }}>
        Модели EmbeddingGemma 2 работают локально. Загрузка и выбор доступны здесь;
        поиск по сохранённым фотографиям будет включён только после проверки нативной интеграции.
        Текущий поиск по словам и смыслу продолжает работать отдельно.
      </Text>
      {VISION_MODELS.map(m => {
        const installed = downloaded(m.id);
        const active = state.activeId === m.id;
        const isLoading = state.busy && state.downloadingId === m.id;
        const disabled = state.busy || !state.loaded;
        return <View key={m.id} style={{ backgroundColor: t.panel,
          borderWidth: 1, borderColor: active ? t.secondary : t.line,
          borderRadius: nebulaRadii.card, padding: nebulaSpacing.md,
          gap: nebulaSpacing.xs }}>
          <Text style={{ color: t.text, ...nebulaTypography.body, fontWeight: "600" }}>
            {m.title}{active ? " · Выбрана" : ""}
          </Text>
          <Text style={{ color: t.muted, ...nebulaTypography.label }}>{m.description}</Text>
          <Text style={{ color: t.muted, ...nebulaTypography.label }}>
            Около {m.approxMB} МБ · {m.modalities.includes("audio") ? "текст, фото и аудио" : "текст и фото"}
          </Text>
          {isLoading ? <>
            <View style={{ flexDirection: "row", gap: nebulaSpacing.sm, alignItems: "center" }}>
              <ActivityIndicator />
              <Text accessibilityLiveRegion="polite" style={{ color: t.text }}>
                Загружается: {state.progress}%
              </Text>
            </View>
            <View style={{ height: 6, borderRadius: 3, backgroundColor: t.soft, overflow: "hidden" }}>
              <View style={{ height: 6, width: `${state.progress}%` as `${number}%`,
                backgroundColor: t.secondary }} />
            </View>
            <Pressable accessibilityRole="button" accessibilityLabel="Отменить скачивание модели"
              onPress={cancelVisionModelDownload} style={buttonStyle(false)}>
              <Text style={{ color: t.secondary }}>Отменить загрузку</Text>
            </Pressable>
          </> : installed ? <View style={{ flexDirection: "row", flexWrap: "wrap", gap: nebulaSpacing.xs }}>
            {!active ? <Pressable accessibilityRole="button" accessibilityLabel={"Выбрать " + m.title}
              disabled={disabled} style={buttonStyle(disabled)}
              onPress={() => void chooseVisionModel(m.id)}>
              <Text style={{ color: t.secondary }}>Выбрать</Text>
            </Pressable> : <Text style={{ color: t.ok, ...nebulaTypography.label }}>
              SHA-256 проверен при загрузке
            </Text>}
            <Pressable accessibilityRole="button" accessibilityLabel={"Удалить " + m.title}
              disabled={disabled} style={buttonStyle(disabled)}
              onPress={() => deleteModel(m.id)}>
              <Text style={{ color: t.err }}>Удалить</Text>
            </Pressable>
          </View> : <Pressable accessibilityRole="button" accessibilityLabel={"Скачать " + m.title}
            disabled={disabled} style={buttonStyle(disabled)}
            onPress={() => startDownload(m.id, m.approxMB)}>
            <Text style={{ color: t.secondary, fontWeight: "600" }}>Скачать · ~{m.approxMB} МБ</Text>
          </Pressable>}
        </View>;
      })}
      {state.error ? <Text accessibilityRole="alert" style={{ color: t.err }}>{state.error}</Text> : null}
      {state.notice ? <Text accessibilityLiveRegion="polite" style={{ color: t.ok }}>{state.notice}</Text> : null}
      <Text style={{ color: t.muted, ...nebulaTypography.caption }}>
        Увеличенный размер модели не гарантирует более точное распознавание. Смена модели
        потребует отдельной переиндексации фотографий; старые текстовые векторы не смешиваются с визуальными.
      </Text>
    </View>
  </Collapsible>;
}
