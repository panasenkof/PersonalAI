import { useFocusEffect, useNavigation } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { useHeaderHeight } from "@react-navigation/elements";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import React, { useCallback, useRef, useState } from "react";
import { ActivityIndicator, Alert, KeyboardAvoidingView, Platform, Pressable, ScrollView, Switch, Text, TextInput, View } from "react-native";
import { useProfile } from "../profile/ProfileContext";
import { defaultBaseUrl, loadDirectConnections, newDirectConnection, saveDirectConnections } from "../direct-agent/settings";
import type { DirectConnection, DirectConnections, DirectProvider } from "../direct-agent/settings";
import type { RootStackParams } from "../navigation";
import { useTheme } from "../theme";

const PROVIDERS: Array<{ id: DirectProvider; name: string }> = [
  { id: "openai", name: "OpenAI Responses" },
  { id: "openai-compatible", name: "OpenAI-совместимый" },
  { id: "anthropic", name: "Anthropic Messages" },
];
export function DirectAgentSettingsScreen() {
  const profile = useProfile();
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParams>>();
  const t = useTheme();
  const headerHeight = useHeaderHeight(); const insets = useSafeAreaInsets();
  const [value, setValue] = useState<DirectConnections | null>(null);
  const [selectedId, setSelectedId] = useState("");
  const pending = useRef(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [retry, setRetry] = useState(0);

  useFocusEffect(useCallback(() => {
    let alive = true;
    setValue(null); setNotice("");
    if (profile) void loadDirectConnections(profile).then(saved => {
      if (alive) { setValue(saved); setSelectedId(saved.activeId); }
    }).catch(() => { if (alive) setNotice("Не удалось открыть защищённые подключения."); });
    return () => { alive = false; setValue(null); };
  }, [profile, retry]));

  const selected = value?.connections.find(c => c.id === selectedId);
  function update(patch: Partial<DirectConnection>) {
    setValue(v => v ? { ...v, connections: v.connections.map(c => c.id === selectedId ? { ...c, ...patch } : c) } : v);
  }
  function protocol(provider: DirectProvider) {
    if (!selected || selected.provider === provider) return;
    update({ provider, baseUrl: defaultBaseUrl(provider), apiKey: "",
      model: provider === "anthropic" ? "claude-sonnet-4-5" : "gpt-4.1-mini",
      ...(selected.searchProvider === "builtin" && provider !== "openai" ? { searchProvider: "public" } : {}),
    });
  }
  async function save() {
    if (!profile || !value || pending.current) return;
    pending.current = true;
    setBusy(true); setNotice("");
    try {
      await saveDirectConnections(profile, { ...value, activeId: selectedId });
      navigation.goBack();
    } catch (e) { setNotice((e as Error).message); }
    finally { pending.current = false; setBusy(false); }
  }
  const field = { borderWidth: 1, borderColor: t.line, padding: 14, minHeight: 50,
    borderRadius: 16, color: t.text, backgroundColor: t.panel };
  const label = { color: t.text, fontWeight: "600" as const };
  return (
    <KeyboardAvoidingView style={{ flex: 1, backgroundColor: t.bg }} behavior={Platform.OS === "ios" ? "padding" : undefined} keyboardVerticalOffset={headerHeight}>
    <ScrollView keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag" contentContainerStyle={{ padding: 18, paddingBottom: insets.bottom + 24, gap: 14 }}>
      <Text style={{ color: t.text, fontSize: 28, fontWeight: "800" }}>Ваши модели</Text>
      <Text style={{ color: t.muted, lineHeight: 21 }}>У каждого сервиса свои адрес, ключ и модель. Выберите сохранённое подключение или добавьте новое. Сохранение активирует выбранную модель.</Text>
      {!value && !notice ? <ActivityIndicator accessibilityLabel="Загрузка подключений" /> : null}
      {value && selected ? <>
        <View style={{ gap: 8 }}>
          {value.connections.map(c => (
            <Pressable key={c.id} disabled={busy} accessibilityRole="button" accessibilityLabel={"Подключение " + c.name}
              accessibilityState={{ selected: c.id === selectedId }} onPress={() => setSelectedId(c.id)}
              style={{ padding: 15, borderRadius: 18, borderWidth: 1, borderColor: c.id === selectedId ? t.accent : t.line, backgroundColor: c.id === selectedId ? t.soft : t.panel }}>
              <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
                <Text style={{ color: t.text, fontWeight: "700", flex: 1 }}>{c.name}</Text>
                <Text style={{ color: t.accent }}>{c.id === selectedId ? "✓" : "→"}</Text>
              </View>
              <Text style={{ color: t.muted, fontSize: 12, marginTop: 5 }} numberOfLines={1}>{c.model} · {c.baseUrl}</Text>
            </Pressable>
          ))}
        </View>
        <Pressable disabled={busy || value.connections.length >= 20} accessibilityRole="button" accessibilityLabel="Добавить подключение"
          style={{ minHeight: 46, justifyContent: "center" }} onPress={() => {
            const created = newDirectConnection("openai-compatible");
            setValue(v => v ? { ...v, connections: [...v.connections, created] } : v); setSelectedId(created.id);
          }}><Text style={{ color: t.accent, fontWeight: "600" }}>+ Добавить подключение</Text></Pressable>
        <Text style={label}>Название</Text>
        <TextInput editable={!busy} accessibilityLabel="Название подключения" value={selected.name} onChangeText={name => update({ name })} style={field} maxLength={60} />
        <Text style={label}>Протокол</Text>
        <View style={{ gap: 7 }}>
          {PROVIDERS.map(p => <Pressable key={p.id} disabled={busy} accessibilityRole="button" accessibilityLabel={"Выбрать " + p.name}
            style={{ minHeight: 44, padding: 12, borderRadius: 14, backgroundColor: t.panel, borderWidth: 1, borderColor: selected.provider === p.id ? t.accent : t.line }}
            onPress={() => protocol(p.id)}><Text style={{ color: t.text }}>{selected.provider === p.id ? "● " : "○ "}{p.name}</Text></Pressable>)}
        </View>
        <Text style={label}>Адрес API (Base URL)</Text>
        <TextInput editable={!busy} accessibilityLabel="Адрес API LLM" autoCapitalize="none" autoCorrect={false} keyboardType="url"
          value={selected.baseUrl} onChangeText={baseUrl => update({ baseUrl, apiKey: "" })} style={field} />
        <Text style={{ color: t.muted, fontSize: 12 }}>HTTP доступен для модели в локальной сети. При смене адреса или протокола введите ключ этого сервиса.</Text>
        <Text style={label}>API-ключ: {selected.apiKey ? "сохранён или введён" : "не задан"}</Text>
        <TextInput editable={!busy} accessibilityLabel="API-ключ LLM" secureTextEntry autoCapitalize="none" autoCorrect={false}
          value={selected.apiKey} onChangeText={apiKey => update({ apiKey })} placeholder="Ключ выбранного подключения" placeholderTextColor={t.muted} style={field} />
        <Text style={label}>Модель</Text>
        <TextInput editable={!busy} accessibilityLabel="Название модели" autoCapitalize="none" autoCorrect={false} value={selected.model}
          onChangeText={model => update({ model })} style={field} />
        {selected.provider !== "anthropic" ? <><Text style={label}>Модель распознавания аудио</Text>
        <TextInput editable={!busy} accessibilityLabel="Модель распознавания аудио" value={selected.transcriptionModel || "whisper-1"} autoCapitalize="none" autoCorrect={false} onChangeText={transcriptionModel => update({ transcriptionModel })} style={field} />
        <Text style={{ color: t.muted, fontSize: 12 }}>Используется при импорте аудио, если сервис поддерживает распознавание речи.</Text></> : null}
        <View style={{ backgroundColor: t.soft, padding: 17, borderRadius: 22, gap: 14 }}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
            <Text style={{ color: t.text, flex: 1 }}>Искать в интернете</Text>
            <Switch disabled={busy} accessibilityLabel="Разрешить веб-поиск" value={selected.allowWeb} onValueChange={allowWeb => update({ allowWeb })} />
          </View>
          <Text style={{ color: t.muted, fontSize: 12 }}>Сначала ассистент проверяет память. Интернет используется при отсутствии подходящих заметок или при запросе свежих данных.</Text>
          {selected.allowWeb ? <>
          {([
            ["public", "Без регистрации (Bing)"], ["brave", "Brave Search API"],
            ...(selected.provider === "openai" ? [["builtin", "Встроенный поиск OpenAI"]] : []),
          ] as Array<["public" | "brave" | "builtin", string]>).map(([id, name]) => (
            <Pressable key={id} disabled={busy} accessibilityRole="button" accessibilityLabel={name}
              style={{ minHeight: 44, justifyContent: "center" }} onPress={() => update({ searchProvider: id })}>
              <Text style={{ color: selected.searchProvider === id ? t.accent : t.text }}>{selected.searchProvider === id ? "● " : "○ "}{name}</Text>
            </Pressable>
          ))}
          {selected.searchProvider === "public" ? <Text style={{ color: t.muted, fontSize: 12 }}>Поисковая фраза отправляется Bing. Доступность и количество результатов зависят от сервиса.</Text> : null}
          {selected.searchProvider === "brave" ? <TextInput editable={!busy} accessibilityLabel="Ключ Brave Search API" secureTextEntry autoCapitalize="none" autoCorrect={false}
            value={selected.webSearchKey} onChangeText={webSearchKey => update({ webSearchKey })} placeholder="Ключ поиска" placeholderTextColor={t.muted} style={field} /> : null}
          </> : null}
        </View>
        <Pressable accessibilityRole="button" disabled={busy} onPress={() => void save()}
          style={{ minHeight: 52, justifyContent: "center", alignItems: "center", backgroundColor: t.accent, borderRadius: 18 }}>
          <Text style={{ color: "#fff", fontWeight: "700" }}>{busy ? "Сохранение…" : "Сохранить настройки"}</Text>
        </Pressable>
        <Pressable accessibilityRole="button" disabled={busy} onPress={() => update({ apiKey: "" })} style={{ minHeight: 44, justifyContent: "center" }}>
          <Text style={{ color: t.err }}>Очистить ключ этого подключения</Text>
        </Pressable>
        {value.connections.length > 1 ? <Pressable accessibilityRole="button" disabled={busy} accessibilityLabel="Удалить подключение" style={{ minHeight: 44, justifyContent: "center" }}
          onPress={() => Alert.alert("Удалить подключение?", "Изменение вступит в силу после сохранения настроек.", [
            { text: "Отмена", style: "cancel" }, { text: "Удалить", style: "destructive", onPress: () => {
              const rest = value.connections.filter(c => c.id !== selectedId); setValue({ activeId: rest[0].id, connections: rest }); setSelectedId(rest[0].id);
            } },
          ])}><Text style={{ color: t.err }}>Удалить подключение</Text></Pressable> : null}
        <Text style={{ color: t.muted, fontSize: 12 }}>До 4 обращений к модели за вопрос, до 1200 выходных токенов на обращение. Денежный бюджет задаётся у провайдера.</Text>
      </> : null}
      {notice ? <><Text accessibilityRole="alert" style={{ color: t.err }}>{notice}</Text>
        {!value ? <Pressable accessibilityRole="button" onPress={() => setRetry(x => x + 1)} style={{ minHeight: 44 }}><Text style={{ color: t.accent }}>Повторить загрузку</Text></Pressable> : null}</> : null}
    </ScrollView>
    </KeyboardAvoidingView>
  );
}
