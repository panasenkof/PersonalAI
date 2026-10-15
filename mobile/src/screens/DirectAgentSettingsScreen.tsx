import { useFocusEffect, useNavigation, useRoute } from "@react-navigation/native";
import type { RouteProp } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { useHeaderHeight } from "@react-navigation/elements";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import React, { useCallback, useRef, useState } from "react";
import { ActivityIndicator, Alert, KeyboardAvoidingView, Platform, Pressable, ScrollView, Switch, Text, TextInput, View } from "react-native";
import { useProfile } from "../profile/ProfileContext";
import { PROVIDER_PRESETS, connectionFromPreset, defaultBaseUrl, loadDirectConnections, newDirectConnection, saveDirectConnections } from "../direct-agent/settings";
import { checkConnection, checkWebSearch } from "../direct-agent/check";
import type { SearchCheck } from "../direct-agent/check";
import type { ConnectionCheck } from "../direct-agent/check";
import type { DirectConnection, DirectConnections, DirectProvider, SearchProvider } from "../direct-agent/settings";
import { yandexFolder } from "../direct-agent/compatible";
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
  const route = useRoute<RouteProp<RootStackParams, "ModelConnections">>();
  const presetId = route.params?.presetId;
  const appliedPreset = useRef<string | undefined>(undefined);
  const t = useTheme();
  const headerHeight = useHeaderHeight(); const insets = useSafeAreaInsets();
  const [value, setValue] = useState<DirectConnections | null>(null);
  const [selectedId, setSelectedId] = useState("");
  const pending = useRef(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [retry, setRetry] = useState(0);
  const [checking, setChecking] = useState(false);
  const [check, setCheck] = useState<ConnectionCheck | null>(null);
  const checkAbort = useRef<AbortController | null>(null);
  const [searching, setSearching] = useState(false);
  const [searchCheck, setSearchCheck] = useState<SearchCheck | null>(null);
  const searchAbort = useRef<AbortController | null>(null);

  useFocusEffect(useCallback(() => {
    let alive = true;
    setValue(null); setNotice("");
    if (profile) void loadDirectConnections(profile).then(saved => {
      if (!alive) return;
      const preset = presetId ? PROVIDER_PRESETS.find(p => p.id === presetId) : undefined;
      if (preset && appliedPreset.current !== presetId && saved.connections.length < 20) {
        // First-run setup: reuse an unconfigured connection of the same kind, or add one.
        const existing = saved.connections.find(c => c.provider === preset.provider && c.baseUrl === preset.baseUrl);
        const chosen = existing || connectionFromPreset(preset);
        setValue(existing ? saved : { ...saved, connections: [...saved.connections, chosen] }); setSelectedId(chosen.id);
        appliedPreset.current = presetId;
      } else { setValue(saved); setSelectedId(saved.activeId); }
    }).catch(() => { if (alive) setNotice("Не удалось открыть защищённые подключения."); });
    return () => { alive = false; setValue(null); checkAbort.current?.abort(); setChecking(false); setCheck(null);
      searchAbort.current?.abort(); setSearching(false); setSearchCheck(null); };
  }, [profile, retry]));

  const selected = value?.connections.find(c => c.id === selectedId);
  const preset = selected && PROVIDER_PRESETS.find(p => p.provider === selected.provider && p.baseUrl === selected.baseUrl);
  function add(connection: DirectConnection) {
    setValue(v => v ? { ...v, connections: [...v.connections, connection] } : v); setSelectedId(connection.id); setCheck(null);
  }
  async function runCheck() {
    if (!selected || checking) return;
    checkAbort.current?.abort(); const aborter = new AbortController(); checkAbort.current = aborter;
    setChecking(true); setCheck(null);
    const result = await checkConnection(selected, undefined, aborter.signal);
    if (!aborter.signal.aborted) { setCheck(result); setChecking(false); }
  }
  /** A search key belongs to one service: switching services never carries it over. */
  function chooseSearch(id: SearchProvider) {
    if (!selected || selected.searchProvider === id) return;
    update({ searchProvider: id, webSearchKey: "",
      ...(id === "yandex" && !selected.searchFolderId && yandexFolder(selected.model) ? { searchFolderId: yandexFolder(selected.model)! } : {}) });
  }
  async function runSearchCheck() {
    if (!selected || searching) return;
    searchAbort.current?.abort(); const aborter = new AbortController(); searchAbort.current = aborter;
    setSearching(true); setSearchCheck(null);
    const result = await checkWebSearch(selected, fetch, aborter.signal);
    if (!aborter.signal.aborted) { setSearchCheck(result); setSearching(false); }
  }
  function update(patch: Partial<DirectConnection>) {
    setCheck(null); setSearchCheck(null);
    setValue(v => v ? { ...v, connections: v.connections.map(c => c.id === selectedId ? { ...c, ...patch } : c) } : v);
  }
  function protocol(provider: DirectProvider) {
    if (!selected || selected.provider === provider) return;
    update({ provider, baseUrl: defaultBaseUrl(provider), apiKey: "",
      model: provider === "anthropic" ? "claude-sonnet-4-5" : "gpt-4.1-mini",
      ...(selected.searchProvider === "builtin" && provider !== "openai" ? { searchProvider: "tavily" as const, webSearchKey: "" } : {}),
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
              accessibilityState={{ selected: c.id === selectedId }} onPress={() => { setSelectedId(c.id); setCheck(null); }}
              style={{ padding: 15, borderRadius: 18, borderWidth: 1, borderColor: c.id === selectedId ? t.accent : t.line, backgroundColor: c.id === selectedId ? t.soft : t.panel }}>
              <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
                <Text style={{ color: t.text, fontWeight: "700", flex: 1 }}>{c.name}</Text>
                <Text style={{ color: t.accent }}>{c.id === selectedId ? "✓" : "→"}</Text>
              </View>
              <Text style={{ color: t.muted, fontSize: 12, marginTop: 5 }} numberOfLines={1}>{c.model} · {c.baseUrl}</Text>
            </Pressable>
          ))}
        </View>
        <Text style={label}>Добавить подключение</Text>
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
          {PROVIDER_PRESETS.map(p => <Pressable key={p.id} disabled={busy || value.connections.length >= 20} accessibilityRole="button" accessibilityLabel={"Добавить " + p.name}
            style={{ minHeight: 44, paddingHorizontal: 14, justifyContent: "center", borderRadius: 14, borderWidth: 1, borderColor: t.line, backgroundColor: t.panel }}
            onPress={() => add(connectionFromPreset(p))}><Text style={{ color: t.accent }}>+ {p.name}</Text></Pressable>)}
          <Pressable disabled={busy || value.connections.length >= 20} accessibilityRole="button" accessibilityLabel="Добавить подключение"
            style={{ minHeight: 44, paddingHorizontal: 14, justifyContent: "center", borderRadius: 14, borderWidth: 1, borderColor: t.line, backgroundColor: t.panel }}
            onPress={() => add(newDirectConnection("openai-compatible"))}><Text style={{ color: t.accent }}>+ Другой API</Text></Pressable>
        </View>
        {preset ? <Text style={{ color: t.muted, fontSize: 12, lineHeight: 18 }}>{preset.hint}</Text> : null}
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
          <Text style={{ color: t.muted, fontSize: 12 }}>Сначала помощник ищет в памяти телефона. Если там ничего нет — сообщает об этом и ищет в интернете. Каждый поиск тратит запрос у выбранного сервиса (у Tavily — 1 из 1000 бесплатных в месяц).</Text>
          {selected.allowWeb ? <>
          {([
            ["tavily", "Tavily — бесплатно 1000 поисков в месяц (из России — только через VPN)"],
            ["yandex", "Яндекс (Yandex Cloud Search API) — около 0,49 ₽ за поиск, работает из России"],
            ...(selected.provider === "openai" ? [["builtin", "Встроенный поиск OpenAI"]] : []),
          ] as Array<[SearchProvider, string]>).map(([id, name]) => (
            <Pressable key={id} disabled={busy} accessibilityRole="button" accessibilityLabel={name}
              style={{ minHeight: 44, justifyContent: "center" }} onPress={() => chooseSearch(id)}>
              <Text style={{ color: selected.searchProvider === id ? t.accent : t.text }}>{selected.searchProvider === id ? "● " : "○ "}{name}</Text>
            </Pressable>
          ))}
          {selected.searchProvider === "tavily" ? <><Text style={{ color: t.muted, fontSize: 12 }}>Ключ — на tavily.com после регистрации (карта не нужна). Бесплатно 1000 поисков в месяц; поисковая фраза отправляется Tavily. Tavily отклоняет запросы из России (HTTP 403) — без VPN выберите Яндекс.</Text>
            <TextInput editable={!busy} accessibilityLabel="Ключ Tavily" secureTextEntry autoCapitalize="none" autoCorrect={false}
              value={selected.webSearchKey} onChangeText={webSearchKey => update({ webSearchKey })} placeholder="tvly-…" placeholderTextColor={t.muted} style={field} /></> : null}
          {selected.searchProvider === "yandex" ? <><Text style={{ color: t.muted, fontSize: 12 }}>В консоли Yandex Cloud: сервисный аккаунт с ролью «search-api.webSearch.user», API-ключ с областью «yc.search-api.execute», идентификатор каталога (b1g…). Поисковая фраза отправляется Яндексу, оплата — со счёта Yandex Cloud.</Text>
            <TextInput editable={!busy} accessibilityLabel="API-ключ Yandex Cloud для поиска" secureTextEntry autoCapitalize="none" autoCorrect={false}
              value={selected.webSearchKey} onChangeText={webSearchKey => update({ webSearchKey })} placeholder="API-ключ (AQVN…)" placeholderTextColor={t.muted} style={field} />
            <TextInput editable={!busy} accessibilityLabel="Идентификатор каталога Yandex Cloud" autoCapitalize="none" autoCorrect={false}
              value={selected.searchFolderId || ""} onChangeText={searchFolderId => update({ searchFolderId })} placeholder="Каталог (b1g…)" placeholderTextColor={t.muted} style={field} /></> : null}
          {selected.searchProvider !== "builtin" ? <Pressable accessibilityRole="button" accessibilityLabel="Проверить поиск" disabled={busy || searching} onPress={() => void runSearchCheck()}
            style={{ minHeight: 44, justifyContent: "center", alignItems: "center", borderRadius: 16, borderWidth: 1, borderColor: t.accent }}>
            {searching ? <ActivityIndicator accessibilityLabel="Проверка поиска" /> : <Text style={{ color: t.accent, fontWeight: "700" }}>Проверить поиск</Text>}
          </Pressable> : null}
          {searchCheck ? <Text selectable accessibilityRole="alert" style={{ color: searchCheck.ok ? t.ok : t.err }}>{searchCheck.ok ? "Поиск работает: найдено ссылок — " + searchCheck.count + (searchCheck.first ? ", первая: " + searchCheck.first : "") + "." : searchCheck.message}</Text> : null}
          </> : null}
        </View>
        <Pressable accessibilityRole="button" accessibilityLabel="Проверить связь" disabled={busy || checking} onPress={() => void runCheck()}
          style={{ minHeight: 48, justifyContent: "center", alignItems: "center", borderRadius: 18, borderWidth: 1, borderColor: t.accent }}>
          {checking ? <ActivityIndicator accessibilityLabel="Проверка связи" /> : <Text style={{ color: t.accent, fontWeight: "700" }}>Проверить связь</Text>}
        </Pressable>
        {check ? <Text accessibilityRole="alert" style={{ color: check.ok ? t.ok : t.err }}>{check.ok ? "Связь есть. Модель ответила: «" + check.reply + "»" : check.message}</Text> : null}
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
        <Text style={{ color: t.muted, fontSize: 12 }}>До 4 обращений к модели за вопрос, до 4000 выходных токенов на обращение (8000 для моделей с рассуждением). Денежный бюджет задаётся у провайдера.</Text>
      </> : null}
      {notice ? <><Text accessibilityRole="alert" style={{ color: t.err }}>{notice}</Text>
        {!value ? <Pressable accessibilityRole="button" onPress={() => setRetry(x => x + 1)} style={{ minHeight: 44 }}><Text style={{ color: t.accent }}>Повторить загрузку</Text></Pressable> : null}</> : null}
    </ScrollView>
    </KeyboardAvoidingView>
  );
}
