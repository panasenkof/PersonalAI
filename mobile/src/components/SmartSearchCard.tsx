import React, { useEffect } from "react";
import { ActivityIndicator, Pressable, Switch, Text, View } from "react-native";
import { useProfile } from "../profile/ProfileContext";
import { loadIndexTermsPreference, refreshIndexTermsStatus, scheduleIndexTerms, setIndexTermsEnabled, useEnrichState } from "../direct-agent/enrich-runner";
import { useTheme } from "../theme";

/** «Умный поиск по памяти»: index words from the user's model (п. 12). */
export function SmartSearchCard() {
  const t = useTheme(); const profile = useProfile();
  const enrich = useEnrichState();
  useEffect(() => { void loadIndexTermsPreference(); if (profile) void refreshIndexTermsStatus(profile); }, [profile]);
  const card = { backgroundColor: t.panel, padding: 20, gap: 10, borderRadius: 22, borderWidth: 1, borderColor: t.line };
  return <View style={card} accessibilityLabel="Умный поиск по памяти">
    <Text style={{ color: t.text, fontSize: 19, fontWeight: "700" }}>Умный поиск по памяти</Text>
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
  </View>;
}
