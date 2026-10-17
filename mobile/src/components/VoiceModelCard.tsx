import React, { useState } from "react";
import { ActivityIndicator, Alert, Pressable, Text, View } from "react-native";
import { WHISPER_CHOICES } from "../media/whisper-core";
import type { WhisperId } from "../media/whisper-core";
import { cancelWhisperDownload, deleteWhisper, downloadWhisper, useWhisperStatus } from "../media/whisper";
import { resolveVoiceEngine, setVoiceEngine, useVoiceEngine } from "../media/voice-engine";
import { useTheme } from "../theme";
import { Collapsible } from "./Collapsible";

/** Dictation engine choice and independently managed on-device Whisper model. */
export function VoiceModelCard({ defaultOpen = false }: { defaultOpen?: boolean } = {}) {
  const t = useTheme();
  const status = useWhisperStatus();
  const voice = useVoiceEngine();
  // The choice being saved is shown immediately; Whisper settings appear only for Whisper.
  const selected = voice.pending ?? resolveVoiceEngine(voice.preference, status.state === "ready");
  const [choice, setChoice] = useState<WhisperId>("base");
  const current = status.state === "ready" || status.state === "downloading" ? status.id : undefined;
  const picked = WHISPER_CHOICES.find(c => c.id === choice)!;
  const button = (primary: boolean) => ({ minHeight: 46, paddingHorizontal: 16, justifyContent: "center" as const, alignItems: "center" as const,
    borderRadius: 16, borderWidth: 1, borderColor: t.accent, backgroundColor: primary ? t.accent : t.panel });
  const confirmDownload = () => Alert.alert("Скачать " + picked.name + "?", `Около ${picked.approxMb} МБ, лучше по Wi-Fi. Модель хранится только на телефоне; речь никуда не отправляется.`, [
    { text: "Отмена", style: "cancel" }, { text: "Скачать", onPress: () => void downloadWhisper(choice) }]);
  const confirmDelete = () => Alert.alert("Удалить модель распознавания?", "Освободится место на телефоне. Чтобы диктовать без скачанной модели, выберите системное распознавание.", [
    { text: "Отмена", style: "cancel" }, { text: "Удалить", style: "destructive", onPress: () => void deleteWhisper() }]);

  const summary = (selected === "whisper" ? "Whisper на телефоне" : "Системное распознавание") +
    (status.state === "ready" ? " · модель " + (WHISPER_CHOICES.find(c => c.id === status.id)?.name || "") + " скачана" : status.state === "downloading" ? ` · скачивается ${status.progress}%` : "");
  return <Collapsible id="settings.voice" title="Голосовой ввод" summary={summary} defaultOpen={defaultOpen}>
    <Text style={{ color: t.muted, lineHeight: 20 }}>Выберите способ диктовки для чата и заметок. Выбор сохраняется; скачанную модель Whisper можно использовать снова в любой момент.</Text>
    <View accessibilityRole="radiogroup" accessibilityLabel="Способ распознавания речи" style={{ gap: 8 }}>
      {([
        { id: "system", name: "Системное распознавание", detail: "Служба телефона. Использование интернета зависит от её возможностей." },
        { id: "whisper", name: "Whisper на телефоне", detail: "Без интернета. Нужна скачанная модель ниже." },
      ] as const).map(option => {
        const checked = voice.loaded && selected === option.id;
        const unavailable = option.id === "whisper" && status.state === "unsupported";
        const disabled = !voice.loaded || voice.saving || unavailable;
        return <Pressable key={option.id} accessibilityRole="radio" accessibilityLabel={option.name} aria-checked={checked} accessibilityState={{ disabled }} disabled={disabled}
          onPress={() => { void setVoiceEngine(option.id).catch(() => {}); }}
          style={{ minHeight: 56, padding: 12, gap: 4, borderRadius: 14, borderWidth: 1, borderColor: checked ? t.accent : t.line, backgroundColor: checked ? t.soft : t.panel, opacity: unavailable ? 0.5 : 1 }}>
          <Text style={{ color: checked ? t.accent : t.text, fontWeight: "600" }}>{checked ? "● " : "○ "}{option.name}</Text>
          <Text style={{ color: t.muted, fontSize: 12, lineHeight: 17 }}>{option.detail}</Text>
        </Pressable>;
      })}
    </View>
    {!voice.loaded ? <Text style={{ color: t.muted }}>Загружаю настройки голоса…</Text> : null}
    {voice.error ? <Text accessibilityRole="alert" style={{ color: t.err }}>{voice.error}</Text> : null}
    {voice.loaded && !voice.error && selected === "whisper" && status.state !== "ready" && status.state !== "unsupported" ?
      <Text style={{ color: t.accent }}>Для диктовки Whisper скачайте модель ниже или дождитесь завершения скачивания.</Text> : null}
    {selected === "system" && status.state === "downloading" ? <Text style={{ color: t.muted }}>Модель Whisper скачивается в фоне: {status.progress}%.</Text> : null}
    {voice.loaded && selected === "whisper" ? <>
    <Text style={{ color: t.text, fontSize: 16, fontWeight: "700", marginTop: 6 }}>Голос без интернета</Text>
    {status.state === "unsupported" ? <Text style={{ color: t.muted, lineHeight: 20 }}>Распознавание речи на самом телефоне требует Android 13 или новее (iOS 17). На этом телефоне голосовой ввод работает через системную службу.</Text> : <>
      <Text style={{ color: t.muted, lineHeight: 20 }}>Модель Whisper распознаёт русскую речь прямо на телефоне — без Google и без интернета. Скачивается один раз.</Text>
      {status.state === "ready" ? <Text style={{ color: t.ok }}>Скачано: {WHISPER_CHOICES.find(c => c.id === status.id)?.name}.</Text> : null}
      {status.state === "error" ? <Text selectable accessibilityRole="alert" style={{ color: t.err }}>{status.message}</Text> : null}
      {status.state === "downloading" ? <View style={{ gap: 8 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}><ActivityIndicator />
          <Text style={{ color: t.text }}>Скачивается {WHISPER_CHOICES.find(c => c.id === status.id)?.name}: {status.progress}%</Text></View>
        <View style={{ height: 6, borderRadius: 3, backgroundColor: t.soft, overflow: "hidden" }}><View style={{ width: `${status.progress}%`, height: 6, backgroundColor: t.accent }} /></View>
        <Pressable accessibilityRole="button" accessibilityLabel="Отменить скачивание модели" onPress={cancelWhisperDownload} style={button(false)}><Text style={{ color: t.accent }}>Отменить</Text></Pressable>
      </View> : <>
        <View style={{ gap: 6 }}>
          {WHISPER_CHOICES.map(c => <Pressable key={c.id} accessibilityRole="button" accessibilityLabel={"Модель " + c.name} accessibilityState={{ selected: choice === c.id }}
            onPress={() => setChoice(c.id)} style={{ minHeight: 44, justifyContent: "center" }}>
            <Text style={{ color: choice === c.id ? t.accent : t.text }}>{choice === c.id ? "● " : "○ "}{c.name} · около {c.approxMb} МБ{current === c.id ? " · скачана" : ""}</Text>
            <Text style={{ color: t.muted, fontSize: 12, marginLeft: 18 }}>{c.hint}</Text>
          </Pressable>)}
        </View>
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
          {current !== choice ? <Pressable accessibilityRole="button" accessibilityLabel="Скачать модель распознавания" onPress={confirmDownload} style={button(true)}>
            <Text style={{ color: "#fff", fontWeight: "700" }}>{current ? "Заменить на " + picked.name : "Скачать " + picked.name}</Text></Pressable> : null}
          {status.state === "ready" ? <Pressable accessibilityRole="button" accessibilityLabel="Удалить модель распознавания" onPress={confirmDelete} style={button(false)}>
            <Text style={{ color: t.err }}>Удалить модель</Text></Pressable> : null}
        </View>
      </>}
    </>}
    </> : null}
  </Collapsible>;
}
