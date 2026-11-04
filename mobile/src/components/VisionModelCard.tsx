import React, { useState } from "react";
import { ActivityIndicator, Pressable, Text, View } from "react-native";
import { useTheme } from "../theme";
import { Collapsible } from "./Collapsible";
import { VisionIndexControls } from "./VisionIndexControls";
import { NebulaConfirmSheet } from "./NebulaConfirmSheet";
import { NebulaAction } from "../design/nebula/components";
import { nebulaRadii, nebulaSpacing, nebulaTouch, nebulaTypography } from "../design/nebula/tokens";
import { VISION_MODELS, type VisionModelId } from "../media/vision-model-catalog";
import { cancelVisionModelDownload, chooseVisionModel, deleteVisionModel,
  downloadVisionModel, useVisionModelStatus } from "../media/vision-model-manager";

/** #83.2 — local multimodal assets and explicit indexing of SQLCipher photos.
 * Text MiniLM remains unchanged; no automatic background indexing.
 */
export function VisionModelCard({ defaultOpen = false }: {defaultOpen?:boolean} = {}) {
  const t = useTheme();
  const state = useVisionModelStatus();
  const [pending, setPending] = useState<{ kind: "download" | "delete"; id: VisionModelId; title: string; approxMB: number } | null>(null);
  const downloaded = (id: VisionModelId) => state.installed.some(m => m.id === id);
  const buttonStyle = (disabled: boolean) => ({
    minHeight: nebulaTouch.minimum, paddingHorizontal: nebulaSpacing.md,
    borderRadius: nebulaRadii.field, borderWidth: 1, borderColor: t.line,
    backgroundColor: t.panel, justifyContent: "center" as const,
    alignItems: "center" as const, opacity: disabled ? 0.5 : 1,
  });
  const ask = (kind: "download" | "delete", id: VisionModelId) => {
    const model = VISION_MODELS.find(m => m.id === id);
    if (!model || !state.loaded || state.busy || (kind === "delete") !== downloaded(id)) return;
    setPending({ kind, id, title: model.title, approxMB: model.approxMB });
  };
  const confirm = () => {
    const request = pending;
    setPending(null);
    if (!request || !state.loaded || state.busy) return;
    const model = VISION_MODELS.find(m => m.id === request.id);
    if (!model || model.title !== request.title || model.approxMB !== request.approxMB ||
      (request.kind === "delete") !== downloaded(request.id)) return;
    if (request.kind === "download") void downloadVisionModel(request.id);
    else void deleteVisionModel(request.id);
  };
  const current = VISION_MODELS.find(m => m.id === state.activeId);
  const summary = !state.loaded ? "Загрузка сведений…" :
    state.busy ? "Скачивание " + state.progress + "%" :
    state.installed.length
      ? (state.installed.length === 1 ? "Модель скачана" : "Скачано моделей: " + state.installed.length) +
        (current ? " · выбрана " + current.title : "")
      : "Модель ещё не скачана";
  return <><Collapsible defaultOpen={defaultOpen} forceOpen={defaultOpen} id="settings.vision-models" icon="image"
    title="Модели поиска по фото" summary={summary}>
    <View style={{ gap: nebulaSpacing.sm }}>
      <Text style={{ color: t.muted, ...nebulaTypography.label }}>
        Модели EmbeddingGemma 2 работают локально. После установки можно
        проиндексировать сохранённые фотографии вручную и искать их из чата
        по описанию или другому снимку. Смысловой поиск текста MiniLM остаётся без изменений.
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
            {m.title}
          </Text>
          {installed ? <Text accessibilityLabel={active ? "Модель скачана и выбрана для поиска" : "Модель скачана на телефон"}
            style={{ color: t.ok, ...nebulaTypography.label, fontWeight: "600" }}>
            {active ? "Скачана · Выбрана" : "Скачана"}
          </Text> : null}
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
            <NebulaAction icon="x" label="Отменить загрузку" accessibilityLabel="Отменить скачивание модели"
              onPress={cancelVisionModelDownload} />
          </> : installed ? <View style={{ flexDirection: "row", flexWrap: "wrap", gap: nebulaSpacing.xs }}>
            {!active ? <NebulaAction icon="check" label="Выбрать" accessibilityLabel={"Выбрать " + m.title}
              disabled={disabled} onPress={() => void chooseVisionModel(m.id)} /> : <Text style={{ color: t.ok, ...nebulaTypography.label }}>
              SHA-256 проверен при загрузке
            </Text>}
            <NebulaAction icon="trash-2" label="Удалить" variant="danger" accessibilityLabel={"Удалить " + m.title}
              disabled={disabled} onPress={() => ask("delete", m.id)} />
          </View> : <NebulaAction icon="download" label={"Скачать · ~" + m.approxMB + " МБ"}
            accessibilityLabel={"Скачать " + m.title}
            disabled={disabled} onPress={() => ask("download", m.id)} />}
        </View>;
      })}
      <VisionIndexControls activeModel={Boolean(state.activeId && downloaded(state.activeId)) && !state.busy} />
      {state.error ? <Text accessibilityRole="alert" style={{ color: t.err }}>{state.error}</Text> : null}
      {state.notice ? <Text accessibilityLiveRegion="polite" style={{ color: t.ok }}>{state.notice}</Text> : null}
      <Text style={{ color: t.muted, ...nebulaTypography.caption }}>
        Увеличенный размер модели не гарантирует более точное распознавание. Смена модели
        потребует отдельной переиндексации фотографий; старые текстовые векторы не смешиваются с визуальными.
      </Text>
    </View>
  </Collapsible>
    <NebulaConfirmSheet visible={pending !== null}
      title={pending?.kind === "delete" ? "Удалить модель поиска?" : "Скачать модель поиска фотографий?"}
      message={pending?.kind === "delete"
        ? `«${pending.title}» будет удалена с телефона. Фотографии, заметки и текстовая память сохранятся.`
        : `«${pending?.title || ""}»: около ${pending?.approxMB || 0} МБ. Рекомендуется Wi-Fi. Перед установкой проверяется SHA-256, файлы модели сохраняются только на телефоне.`}
      cancelLabel="Отмена" confirmLabel={pending?.kind === "delete" ? "Удалить модель" : "Скачать модель"}
      danger={pending?.kind === "delete"} disabled={state.busy || !state.loaded}
      onCancel={() => setPending(null)} onConfirm={confirm} />
    </>;
}
