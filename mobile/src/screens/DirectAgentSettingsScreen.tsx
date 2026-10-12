import { useFocusEffect } from "@react-navigation/native";
import React, { useCallback, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, Switch, Text, TextInput, View } from "react-native";

import { useAuth } from "../auth/AuthContext";
import {
  clearDirectApiKey, defaultDirectPreferences, loadDirectSettings,
  saveDirectApiKey, saveDirectPreferences,
} from "../direct-agent/settings";
import type { DirectAgentPreferences } from "../direct-agent/settings";
import { useTheme } from "../theme";

export function DirectAgentSettingsScreen() {
  const { offlineMode, me } = useAuth();
  const profile = offlineMode ? "guest" : me?.id;
  const t = useTheme();
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [hasKey, setHasKey] = useState(false);
  const [keyInput, setKeyInput] = useState("");
  const [prefs, setPrefs] = useState<DirectAgentPreferences>(defaultDirectPreferences);
  const [notice, setNotice] = useState("");

  useFocusEffect(useCallback(() => {
    let alive = true;
    setReady(false);
    if (profile) {
      void loadDirectSettings(profile).then(value => {
        if (!alive) return;
        setHasKey(Boolean(value.apiKey));
        setPrefs({ model: value.model, allowMemory: value.allowMemory, allowWeb: value.allowWeb });
        setReady(true);
      }).catch(() => { if (alive) setNotice("Не удалось открыть защищённые настройки"); });
    }
    return () => { alive = false; setKeyInput(""); };
  }, [profile]));

  async function save() {
    if (!profile || busy) return;
    setBusy(true);
    setNotice("");
    try {
      // Save preferences before the key, so an invalid model cannot trigger a
      // partial key update. Never place the actual API key into logs or alerts.
      await saveDirectPreferences(profile, prefs);
      if (keyInput.trim()) {
        await saveDirectApiKey(keyInput);
        setHasKey(true);
        setKeyInput("");
      }
      setNotice("Настройки сохранены на телефоне.");
    } catch (e) {
      setNotice(String((e as Error).message));
    } finally { setBusy(false); }
  }

  async function clear() {
    if (busy) return;
    setBusy(true);
    try {
      await clearDirectApiKey();
      setKeyInput("");
      setHasKey(false);
      setNotice("API-ключ удалён с телефона.");
    } catch {
      setNotice("Не удалось удалить API-ключ");
    } finally { setBusy(false); }
  }

  const fieldStyle = { borderWidth: 1, borderColor: t.line, padding: 12,
    borderRadius: 10, color: t.text, backgroundColor: t.panel };
  return (
    <ScrollView style={{ flex: 1, backgroundColor: t.bg }}
      contentContainerStyle={{ padding: 16, paddingBottom: 48, gap: 14 }}>
      <Text style={{ color: t.text, fontSize: 18, fontWeight: "700" }}>Прямой вызов LLM с телефона</Text>
      <Text style={{ color: t.muted }}>
        Этот режим не использует сервер PersonalAI. В первой версии доступен OpenAI Responses API.
        Запросы и разрешённые фрагменты памяти отправляются OpenAI напрямую с телефона.
        Использование API и веб-поиска оплачивается по тарифам провайдера.
      </Text>
      {!ready ? <ActivityIndicator /> : <>
        <Text style={{ color: t.text, fontWeight: "600" }}>API-ключ OpenAI: {hasKey ? "сохранён" : "не задан"}</Text>
        <TextInput
          accessibilityLabel="API-ключ OpenAI"
          autoCapitalize="none"
          autoCorrect={false}
          secureTextEntry
          placeholder={hasKey ? "Оставьте пустым, чтобы не менять" : "sk-…"}
          placeholderTextColor={t.muted}
          value={keyInput}
          onChangeText={setKeyInput}
          style={fieldStyle}
        />
        <Text style={{ color: t.text, fontWeight: "600" }}>Модель (Responses API)</Text>
        <TextInput
          accessibilityLabel="Модель OpenAI"
          autoCapitalize="none" autoCorrect={false}
          value={prefs.model}
          onChangeText={model => setPrefs(p => ({ ...p, model }))}
          style={fieldStyle}
        />
        <View style={{ backgroundColor: t.panel, borderRadius: 10, padding: 12, gap: 12 }}>
          <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
            <Text style={{ color: t.text, flex: 1 }}>Разрешить веб-поиск OpenAI</Text>
            <Switch accessibilityLabel="Разрешить веб-поиск" value={prefs.allowWeb}
              onValueChange={allowWeb => setPrefs(p => ({ ...p, allowWeb }))} />
          </View>
          <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
            <Text style={{ color: t.text, flex: 1 }}>Разрешить чтение обычных заметок моделью</Text>
            <Switch accessibilityLabel="Разрешить чтение локальной памяти" value={prefs.allowMemory}
              onValueChange={allowMemory => setPrefs(p => ({ ...p, allowMemory }))} />
          </View>
          <Text style={{ color: t.muted, fontSize: 12 }}>
            Доступ к памяти по умолчанию запрещён. При включении модель сможет получать
            только найденные заметки из обычных коллекций; секретные, чувствительные
            и неклассифицированные записи не передаются. Новые заметки ИИ создаёт
            только после твоего подтверждения.
          </Text>
        </View>
        <Pressable accessibilityRole="button" disabled={busy} onPress={() => void save()}
          style={{ minHeight: 48, justifyContent: "center", alignItems: "center",
            backgroundColor: t.accent, borderRadius: 10 }}>
          <Text style={{ color: "#fff", fontWeight: "700" }}>Сохранить настройки</Text>
        </Pressable>
        <Pressable accessibilityRole="button" disabled={busy} onPress={() => void clear()}
          style={{ minHeight: 44, justifyContent: "center", alignItems: "center" }}>
          <Text style={{ color: t.err }}>Удалить API-ключ с телефона</Text>
        </Pressable>
        {notice ? <Text accessibilityRole="alert" style={{ color: t.text }}>{notice}</Text> : null}
        <Text style={{ color: t.muted, fontSize: 12 }}>
          Лимиты первой версии: максимум 4 обращения к OpenAI за один вопрос,
          до 1200 выходных токенов за обращение. Это не денежный лимит:
          установи ограничения расходов в кабинете OpenAI. История чата
          не сохраняется после закрытия экрана приложения.
        </Text>
      </>}
    </ScrollView>
  );
}
