import React, { useState } from "react";
import { ActivityIndicator, Alert, Pressable, Text, View } from "react-native";
import { WHISPER_CHOICES } from "../media/whisper-core";
import type { WhisperId } from "../media/whisper-core";
import { cancelWhisperDownload, deleteWhisper, downloadWhisper, useWhisperStatus } from "../media/whisper";
import { useTheme } from "../theme";

/** «Голос без интернета»: download, replace or delete the on-device Whisper model. */
export function VoiceModelCard() {
  const t = useTheme();
  const status = useWhisperStatus();
  const [choice, setChoice] = useState<WhisperId>("base");
  const current = status.state === "ready" || status.state === "downloading" ? status.id : undefined;
  const picked = WHISPER_CHOICES.find(c => c.id === choice)!;
  const card = { backgroundColor: t.panel, padding: 20, gap: 10, borderRadius: 22, borderWidth: 1, borderColor: t.line };
  const button = (primary: boolean) => ({ minHeight: 46, paddingHorizontal: 16, justifyContent: "center" as const, alignItems: "center" as const,
    borderRadius: 16, borderWidth: 1, borderColor: t.accent, backgroundColor: primary ? t.accent : t.panel });
  const confirmDownload = () => Alert.alert("Скачать " + picked.name + "?", `Около ${picked.approxMb} МБ, лучше по Wi-Fi. Модель хранится только на телефоне; речь никуда не отправляется.`, [
    { text: "Отмена", style: "cancel" }, { text: "Скачать", onPress: () => void downloadWhisper(choice) }]);
  const confirmDelete = () => Alert.alert("Удалить модель распознавания?", "Освободится место на телефоне. Голосовой ввод вернётся к системной службе.", [
    { text: "Отмена", style: "cancel" }, { text: "Удалить", style: "destructive", onPress: () => void deleteWhisper() }]);

  return <View style={card} accessibilityLabel="Голос без интернета">
    <Text style={{ color: t.text, fontSize: 19, fontWeight: "700" }}>Голос без интернета</Text>
    {status.state === "unsupported" ? <Text style={{ color: t.muted, lineHeight: 20 }}>Распознавание речи на самом телефоне требует Android 13 или новее (iOS 17). На этом телефоне голосовой ввод работает через системную службу.</Text> : <>
      <Text style={{ color: t.muted, lineHeight: 20 }}>Модель Whisper распознаёт русскую речь прямо на телефоне — без Google и без интернета. Скачивается один раз.</Text>
      {status.state === "ready" ? <Text style={{ color: t.ok }}>Готово: {WHISPER_CHOICES.find(c => c.id === status.id)?.name}. Диктовка идёт через неё.</Text> : null}
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
  </View>;
}
