import { useFocusEffect } from "@react-navigation/native";
import React, { useCallback, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, Switch, Text, TextInput, View } from "react-native";

import { useAuth } from "../auth/AuthContext";
import {
  clearDirectApiKey, clearWebSearchKey, defaultBaseUrl, defaultDirectPreferences,
  loadDirectSettings, saveDirectApiKey, saveDirectPreferences, saveWebSearchKey,
} from "../direct-agent/settings";
import type { DirectAgentPreferences, DirectProvider } from "../direct-agent/settings";
import { useTheme } from "../theme";

const PROVIDERS: Array<{ id: DirectProvider; name: string }> = [
  { id: "openai", name: "OpenAI Responses" },
  { id: "openai-compatible", name: "OpenAI-совместимый" },
  { id: "anthropic", name: "Anthropic-совместимый" },
];
export function DirectAgentSettingsScreen() {
  const { offlineMode, me } = useAuth();
  const profile = offlineMode ? "guest" : me?.id;
  const t = useTheme();
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [hasKey, setHasKey] = useState(false);
  const [hasWebKey, setHasWebKey] = useState(false);
  const [keyInput, setKeyInput] = useState("");
  const [webKeyInput, setWebKeyInput] = useState("");
  const [prefs, setPrefs] = useState<DirectAgentPreferences>(defaultDirectPreferences);
  const [notice, setNotice] = useState("");

  const reload = useCallback(async (id: string) => {
    const value = await loadDirectSettings(id);
    setHasKey(Boolean(value.apiKey));
    setHasWebKey(Boolean(value.webSearchKey));
    setPrefs({
      provider: value.provider, baseUrl: value.baseUrl, model: value.model,
      allowMemory: value.allowMemory, allowWeb: value.allowWeb,
    });
  }, []);

  useFocusEffect(useCallback(() => {
    let alive = true;
    setReady(false);
    if (profile) {
      void loadDirectSettings(profile).then(value => {
        if (!alive) return;
        setHasKey(Boolean(value.apiKey));
        setHasWebKey(Boolean(value.webSearchKey));
        setPrefs({
          provider: value.provider, baseUrl: value.baseUrl, model: value.model,
          allowMemory: value.allowMemory, allowWeb: value.allowWeb,
        });
        setReady(true);
      }).catch(() => {
        if (alive) { setNotice("Не удалось открыть защищённые настройки"); setReady(true); }
      });
    } else setReady(true);
    return () => { alive = false; setKeyInput(""); setWebKeyInput(""); };
  }, [profile]));

  async function save() {
    if (!profile || busy) return;
    setBusy(true); setNotice("");
    try {
      await saveDirectPreferences(profile, prefs);
      if (keyInput.trim()) await saveDirectApiKey(profile, keyInput, prefs);
      if (webKeyInput.trim()) await saveWebSearchKey(profile, webKeyInput);
      setKeyInput(""); setWebKeyInput("");
      await reload(profile);
      setNotice("Настройки сохранены на устройстве.");
    } catch (e) {
      setNotice(String((e as Error).message));
    } finally { setBusy(false); }
  }

  async function clear(kind: "llm" | "search") {
    if (!profile || busy) return;
    setBusy(true); setNotice("");
    try {
      if (kind === "llm") { await clearDirectApiKey(profile); setKeyInput(""); }
      else { await clearWebSearchKey(profile); setWebKeyInput(""); }
      await reload(profile);
      setNotice(kind === "llm" ? "Ключ LLM удалён." : "Ключ интернет-поиска удалён.");
    } catch { setNotice("Не удалось удалить ключ"); }
    finally { setBusy(false); }
  }

  const fieldStyle = {
    borderWidth: 1, borderColor: t.line, padding: 12, minHeight: 48,
    borderRadius: 16, color: t.text, backgroundColor: t.panel,
  };
  return (
    <ScrollView style={{ flex: 1, backgroundColor: t.bg }}
      contentContainerStyle={{ padding: 18, paddingBottom: 56, gap: 15 }}>
      <Text style={{ color: t.text, fontSize: 27, fontWeight: "800" }}>Подключение ИИ</Text>
      <Text style={{ color: t.muted }}>
        PersAI обращается к выбранной модели напрямую с телефона, без сервера PersAI.
        Поддерживаются OpenAI Responses, OpenAI-совместимые Chat Completions и
        Anthropic-совместимые Messages API. Запросы оплачиваются по тарифам провайдера.
      </Text>
      {!ready ? <ActivityIndicator /> : <>
        <Text style={{ color: t.text, fontWeight: "600" }}>Протокол LLM</Text>
        <View style={{ gap: 8 }}>
          {PROVIDERS.map(item => (
            <Pressable key={item.id} accessibilityRole="button"
              accessibilityLabel={"Выбрать " + item.name}
              onPress={() => setPrefs(p => ({
                ...p, provider: item.id, baseUrl: defaultBaseUrl(item.id),
                model: item.id === "anthropic" ? "claude-sonnet-4-5" : "gpt-4.1-mini",
              }))}
              style={{ padding: 12, borderRadius: 17, borderWidth: 1,
                borderColor: prefs.provider === item.id ? t.accent : t.line,
                backgroundColor: t.panel }}>
              <Text style={{ color: t.text, fontWeight: prefs.provider === item.id ? "700" : "400" }}>
                {prefs.provider === item.id ? "● " : "○ "}{item.name}
              </Text>
            </Pressable>
          ))}
        </View>
        <Text style={{ color: t.text, fontWeight: "600" }}>Адрес API (Base URL)</Text>
        <TextInput accessibilityLabel="Адрес API LLM" autoCapitalize="none" autoCorrect={false}
          keyboardType="url" value={prefs.baseUrl}
          onChangeText={baseUrl => setPrefs(p => ({ ...p, baseUrl }))} style={fieldStyle} />
        <Text style={{ color: t.muted, fontSize: 12 }}>
          Для локальной OpenAI-совместимой модели можно указать HTTP-адрес устройства в частной сети; API-ключ необязателен.
          При изменении адреса или протокола требуется отдельный API-ключ.
        </Text>
        <Text style={{ color: t.text, fontWeight: "600" }}>API-ключ модели: {hasKey ? "сохранён" : "не задан"}</Text>
        <TextInput accessibilityLabel="API-ключ LLM" autoCapitalize="none" autoCorrect={false}
          secureTextEntry placeholder="Введите ключ провайдера" placeholderTextColor={t.muted}
          value={keyInput} onChangeText={setKeyInput} style={fieldStyle} />
        <Text style={{ color: t.text, fontWeight: "600" }}>Название модели</Text>
        <TextInput accessibilityLabel="Название модели" autoCapitalize="none" autoCorrect={false}
          value={prefs.model} onChangeText={model => setPrefs(p => ({ ...p, model }))}
          style={fieldStyle} />
        <View style={{ backgroundColor: t.soft, borderRadius: 20, padding: 16, gap: 14 }}>
          <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
            <Text style={{ color: t.text, flex: 1 }}>Разрешить поиск в интернете</Text>
            <Switch accessibilityLabel="Разрешить веб-поиск" value={prefs.allowWeb}
              onValueChange={allowWeb => setPrefs(p => ({ ...p, allowWeb }))} />
          </View>
          <Text style={{ color: t.muted, fontSize: 12 }}>
            Для OpenAI Responses возможен встроенный поиск. Для любой совместимой LLM
            нужен отдельный Brave Search API: запрос отправляется поисковому сервису,
            результаты передаются выбранной модели. Без ключа поиск не запускается.
          </Text>
          <Text style={{ color: t.text, fontWeight: "600" }}>
            Ключ Brave Search API: {hasWebKey ? "сохранён" : "не задан"}
          </Text>
          <TextInput accessibilityLabel="Ключ Brave Search API" autoCapitalize="none"
            autoCorrect={false} secureTextEntry placeholder="Необязателен для OpenAI Responses"
            placeholderTextColor={t.muted} value={webKeyInput} onChangeText={setWebKeyInput}
            style={fieldStyle} />
          <Pressable accessibilityRole="button" disabled={busy} onPress={() => void clear("search")}>
            <Text style={{ color: t.err }}>Удалить ключ поиска</Text>
          </Pressable>
          <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
            <Text style={{ color: t.text, flex: 1 }}>Разрешить чтение обычных заметок моделью</Text>
            <Switch accessibilityLabel="Разрешить чтение локальной памяти" value={prefs.allowMemory}
              onValueChange={allowMemory => setPrefs(p => ({ ...p, allowMemory }))} />
          </View>
          <Text style={{ color: t.muted, fontSize: 12 }}>
            Память по умолчанию закрыта. Модель получает только разрешённые обычные заметки,
            если поддерживает вызов инструментов. Новые заметки сохраняются только после подтверждения.
          </Text>
        </View>
        <Pressable accessibilityRole="button" disabled={busy || !profile} onPress={() => void save()}
          style={{ minHeight: 50, justifyContent: "center", alignItems: "center",
            backgroundColor: t.accent, borderRadius: 17 }}>
          <Text style={{ color: "#fff", fontWeight: "700" }}>Сохранить настройки</Text>
        </Pressable>
        <Pressable accessibilityRole="button" disabled={busy} onPress={() => void clear("llm")}
          style={{ minHeight: 44, justifyContent: "center", alignItems: "center" }}>
          <Text style={{ color: t.err }}>Удалить API-ключ модели</Text>
        </Pressable>
        {notice ? <Text accessibilityRole="alert" style={{ color: t.text }}>{notice}</Text> : null}
        <Text style={{ color: t.muted, fontSize: 12 }}>
          Не более 4 обращений к модели и до 1200 выходных токенов на обращение.
          Это не денежный лимит: задайте бюджет также у провайдера. История диалога
          удаляется при закрытии экрана.
        </Text>
      </>}
    </ScrollView>
  );
}
