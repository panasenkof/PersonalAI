import React, { useEffect, useRef } from "react";
import { ActivityIndicator, Alert, Pressable, Switch, Text, View } from "react-native";
import { EMBEDDER_APPROX_MB, cancelEmbedderDownload, deleteEmbedder, downloadEmbedder, useEmbedderStatus } from "../media/embedder";
import { refreshVectorStatus, scheduleVectors, stopVectors, useVectorState } from "../media/vector-runner";
import { useProfile } from "../profile/ProfileContext";
import { loadIndexTermsPreference, refreshIndexTermsStatus, scheduleIndexTerms, setIndexTermsEnabled, useEnrichState } from "../direct-agent/enrich-runner";
import { useTheme } from "../theme";
import { Collapsible } from "./Collapsible";

/** «Умный поиск по памяти»: index words from the user's model (п. 12) and
 * search by meaning with a model on the phone (п. 13). */
export function SmartSearchCard() {
  const t = useTheme(); const profile = useProfile();
  const enrich = useEnrichState();
  const model = useEmbedderStatus(); const vectors = useVectorState();
  useEffect(() => { void loadIndexTermsPreference(); if (profile) { void refreshIndexTermsStatus(profile); void refreshVectorStatus(profile); } }, [profile]);
  // A finished download starts indexing at once.
  const previous = useRef(model.state);
  useEffect(() => {
    if (model.state === "ready" && previous.current === "downloading" && profile) scheduleVectors(profile, 0);
    if (model.state === "ready" && profile) void refreshVectorStatus(profile);
    previous.current = model.state;
  }, [model.state, profile]);
  const button = (primary: boolean) => ({ minHeight: 46, paddingHorizontal: 16, justifyContent: "center" as const, alignItems: "center" as const,
    borderRadius: 16, borderWidth: 1, borderColor: t.accent, backgroundColor: primary ? t.accent : t.panel });
  const confirmDownload = () => Alert.alert("Скачать модель поиска по смыслу?", `Около ${EMBEDDER_APPROX_MB} МБ, лучше по Wi-Fi. Модель хранится и работает только на телефоне; записи никуда не отправляются.`, [
    { text: "Отмена", style: "cancel" }, { text: "Скачать", onPress: () => void downloadEmbedder() }]);
  const confirmDelete = () => Alert.alert("Удалить модель поиска по смыслу?", "Освободится место на телефоне. Поиск продолжит работать по словам.", [
    { text: "Отмена", style: "cancel" }, { text: "Удалить", style: "destructive", onPress: () => { stopVectors(); void deleteEmbedder(); } }]);
  const summary = [enrich.enabled ? `слова для поиска: ${enrich.done}${enrich.pending ? ", ждут " + enrich.pending : ""}` : "слова для поиска выключены",
    model.state === "ready" ? `по смыслу: ${vectors.done} из ${vectors.total}` : model.state === "downloading" ? `модель скачивается ${model.progress}%` :
    model.state === "unsupported" ? "" : "по смыслу: модель не скачана"].filter(Boolean).join(" · ");
  return <Collapsible id="settings.smart-search" title="Умный поиск по памяти" summary={(enrich.error || vectors.error ? "⚠ " : "") + summary}>
    <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
      <View style={{ flex: 1, gap: 4 }}>
        <Text style={{ color: t.text, fontWeight: "600" }}>Слова для поиска</Text>
        <Text style={{ color: t.muted, fontSize: 12, lineHeight: 17 }}>Модель подключения подбирает к записи синонимы, родственные слова и кем приходятся люди — так «автомобиль» находит «машину», а «сестра» — записи об Ане. Отправляются только записи обычных разделов; «Документы» и личные разделы не отправляются никогда.</Text>
      </View>
      <Switch accessibilityLabel="Подбирать слова для поиска" value={enrich.enabled}
        onValueChange={value => { void setIndexTermsEnabled(value, profile || undefined); }} />
    </View>
    {enrich.enabled ? <>
      <Text style={{ color: t.muted }}>{enrich.running ? "Подбираю слова… " : ""}Готово для записей: {enrich.done}{enrich.pending ? ` · ждут: ${enrich.pending}` : ""}{enrich.model ? ` · ${enrich.model}` : ""}</Text>
      {enrich.running ? <ActivityIndicator /> : null}
      {enrich.error ? <Text selectable accessibilityRole="alert" style={{ color: t.err }}>{enrich.error}</Text> : null}
      {!enrich.running && enrich.pending ? <Pressable accessibilityRole="button" accessibilityLabel="Подобрать слова сейчас" onPress={() => { if (profile) scheduleIndexTerms(profile, 0); }}
        style={{ minHeight: 46, justifyContent: "center", alignItems: "center", borderRadius: 16, borderWidth: 1, borderColor: t.accent }}>
        <Text style={{ color: t.accent }}>Подобрать сейчас</Text></Pressable> : null}
    </> : null}
    <Text style={{ color: t.text, fontWeight: "600", marginTop: 6 }}>Поиск по смыслу</Text>
    {model.state === "unsupported" ? <Text style={{ color: t.muted, fontSize: 12, lineHeight: 17 }}>Требует Android 13 или новее (iOS 17). На этом телефоне поиск работает по словам и словам для поиска.</Text> : <>
      <Text style={{ color: t.muted, fontSize: 12, lineHeight: 17 }}>Модель на телефоне находит записи без общих слов: «чем угостить Аню» → «любит капучино». Работает без интернета, ищет и в «Документах» — найденное там видите только вы.</Text>
      {model.state === "ready" ? <>
        <Text style={{ color: t.ok }}>Модель скачана. Векторы: {vectors.done} из {vectors.total}{vectors.running ? " — считаю…" : ""}{vectors.perChunkMs ? ` · ${vectors.perChunkMs} мс на кусок` : ""}</Text>
        {vectors.running ? <ActivityIndicator /> : null}
        {vectors.error ? <Text selectable accessibilityRole="alert" style={{ color: t.err }}>{vectors.error}</Text> : null}
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
          {!vectors.running && vectors.done < vectors.total ? <Pressable accessibilityRole="button" accessibilityLabel="Посчитать векторы сейчас" onPress={() => { if (profile) scheduleVectors(profile, 0); }} style={button(false)}>
            <Text style={{ color: t.accent }}>Посчитать сейчас</Text></Pressable> : null}
          <Pressable accessibilityRole="button" accessibilityLabel="Удалить модель поиска по смыслу" onPress={confirmDelete} style={button(false)}><Text style={{ color: t.err }}>Удалить модель</Text></Pressable>
        </View>
      </> : model.state === "downloading" ? <View style={{ gap: 8 }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}><ActivityIndicator /><Text style={{ color: t.text }}>Скачивается: {model.progress}%</Text></View>
        <View style={{ height: 6, borderRadius: 3, backgroundColor: t.soft, overflow: "hidden" }}><View style={{ width: `${model.progress}%`, height: 6, backgroundColor: t.accent }} /></View>
        <Pressable accessibilityRole="button" accessibilityLabel="Отменить скачивание модели поиска" onPress={cancelEmbedderDownload} style={button(false)}><Text style={{ color: t.accent }}>Отменить</Text></Pressable>
      </View> : <>
        {model.state === "error" ? <Text selectable accessibilityRole="alert" style={{ color: t.err }}>{model.message}</Text> : null}
        <Pressable accessibilityRole="button" accessibilityLabel="Скачать модель поиска по смыслу" onPress={confirmDownload} style={button(true)}>
          <Text style={{ color: "#fff", fontWeight: "700" }}>Скачать модель · около {EMBEDDER_APPROX_MB} МБ</Text></Pressable>
      </>}
    </>}
  </Collapsible>;
}
