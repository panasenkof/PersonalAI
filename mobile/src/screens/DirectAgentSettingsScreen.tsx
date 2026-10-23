import { useFocusEffect, useNavigation, usePreventRemove, useRoute } from "@react-navigation/native";
import type { RouteProp } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { useHeaderHeight } from "@react-navigation/elements";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import React, { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, Alert, KeyboardAvoidingView, Platform, Pressable, ScrollView, Switch, Text, TextInput, View } from "react-native";
import { useProfile } from "../profile/ProfileContext";
import { PROVIDER_PRESETS, apiTypeOf, isDeepSeekApi, connectionFromPreset, defaultBaseUrl, loadDirectConnections, newDirectConnection, providerFor, saveDirectConnections, searchKeyOf } from "../direct-agent/settings";
import { checkConnection, checkWebSearch } from "../direct-agent/check";
import type { ConnectionCheck, SearchCheck } from "../direct-agent/check";
import type { ApiType, DirectConnection, DirectConnections, KeyedSearch, ProviderPreset, SearchKeys, SearchProvider } from "../direct-agent/settings";
import { yandexFolder } from "../direct-agent/compatible";
import { fetchTavilyUsage, formatTavilyUsage } from "../direct-agent/web-search";
import type { RootStackParams } from "../navigation";
import { useTheme } from "../theme";
import { MediaSettings } from "../media/MediaSettings";
import { connectionDraftFingerprint } from "./connectionDraft";
import { Collapsible } from "../components/Collapsible";

const API_TYPES: Array<{ id: ApiType; name: string; hint: string }> = [
  { id: "openai", name: "OpenAI-совместимый", hint: "DeepSeek, YandexGPT, OpenRouter, OpenAI, Ollama, LM Studio и большинство других сервисов." },
  { id: "anthropic", name: "Anthropic", hint: "Модели Claude напрямую через API Anthropic." },
];
const SEARCH_OPTIONS: Array<{ id: SearchProvider; name: string; hint: string }> = [
  { id: "yandex", name: "Яндекс", hint: "Работает из России, около 0,49 ₽ за поиск со счёта Yandex Cloud. Нужны API-ключ сервисного аккаунта (роль «search-api.webSearch.user», область «yc.search-api.execute») и идентификатор каталога." },
  { id: "deepseek", name: "DeepSeek", hint: "Поиск DeepSeek: около $0,75 за 1000 успешных запросов со счёта DeepSeek, неудачные и пустые не оплачиваются. Если подключение — DeepSeek, отдельный ключ не нужен. Модель может прочитать страницу из результатов целиком (DeepSeek Fetch, по той же цене)." },
  { id: "tavily", name: "Tavily", hint: "Бесплатно 1000 поисков в месяц, ключ — на tavily.com. Из России отвечает отказом (HTTP 403) — работает только через VPN." },
  { id: "builtin", name: "Встроенный OpenAI", hint: "Поиск самой модели OpenAI; оплачивается OpenAI." },
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
  const baselineFingerprint = useRef("");
  const [leaving, setLeaving] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [retry, setRetry] = useState(0);
  const [checking, setChecking] = useState(false);
  const [check, setCheck] = useState<ConnectionCheck | null>(null);
  const checkAbort = useRef<AbortController | null>(null);
  const [searching, setSearching] = useState(false);
  const [searchCheck, setSearchCheck] = useState<SearchCheck | null>(null);
  const searchAbort = useRef<AbortController | null>(null);
  const [usage, setUsage] = useState<{ text: string; ok: boolean } | null>(null);
  const [usageTick, setUsageTick] = useState(0);

  useFocusEffect(useCallback(() => {
    let alive = true;
    setValue(null); setNotice(""); baselineFingerprint.current = "";
    if (profile) void loadDirectConnections(profile).then(saved => {
      if (!alive) return;
      baselineFingerprint.current = connectionDraftFingerprint(saved, saved.activeId);
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

  const dirty = Boolean(value && baselineFingerprint.current && connectionDraftFingerprint(value, selectedId) !== baselineFingerprint.current);
  usePreventRemove(!leaving && (busy || dirty), () => {
    if (busy) { Alert.alert("Сохранение", "Дождитесь завершения сохранения настроек."); return; }
    Alert.alert("Изменения не сохранены", "Закрыть настройки без сохранения?", [
      { text: "Продолжить редактирование", style: "cancel" },
      { text: "Закрыть без сохранения", style: "destructive", onPress: () => setLeaving(true) },
    ]);
  });
  useEffect(() => { if (leaving) navigation.goBack(); }, [leaving, navigation]);

  const selected = value?.connections.find(c => c.id === selectedId);
  const type = selected ? apiTypeOf(selected.provider) : "openai";
  const preset = selected && PROVIDER_PRESETS.find(p => p.provider === selected.provider && p.baseUrl === selected.baseUrl);
  const search = selected ? (selected.searchProvider === "builtin" && selected.provider !== "openai" ? "tavily" : selected.searchProvider || "tavily") : "tavily";
  const keys: SearchKeys = selected ? selected.searchKeys ?? (search !== "builtin" && selected.webSearchKey ? { [search]: selected.webSearchKey } as SearchKeys : {}) : {};

  function choose(id: string) { setSelectedId(id); setCheck(null); setSearchCheck(null); }
  function add(connection: DirectConnection) {
    setValue(v => v ? { ...v, connections: [...v.connections, connection] } : v); choose(connection.id);
  }
  function update(patch: Partial<DirectConnection>) {
    setCheck(null); setSearchCheck(null);
    setValue(v => v ? { ...v, connections: v.connections.map(c => c.id === selectedId ? { ...c, ...patch } : c) } : v);
  }
  /** The model key is bound to its address: a new address or type needs the key of that service. */
  function setAddress(baseUrl: string) { update({ baseUrl, provider: providerFor(type, baseUrl), apiKey: "" }); }
  function setType(next: ApiType) {
    if (!selected || next === type) return;
    const baseUrl = defaultBaseUrl(next === "anthropic" ? "anthropic" : "openai");
    update({ provider: providerFor(next, baseUrl), baseUrl, apiKey: "", model: next === "anthropic" ? "claude-sonnet-4-5" : "gpt-4.1-mini" });
  }
  function applyPreset(p: ProviderPreset) {
    update({ name: p.name, provider: p.provider, baseUrl: p.baseUrl, model: p.model, apiKey: "" });
  }
  function setSearchKey(id: KeyedSearch, key: string) {
    const searchKeys: SearchKeys = { ...keys, [id]: key };
    update({ searchKeys, webSearchKey: searchKeyOf({ searchKeys, webSearchKey: "" }, search) });
  }
  function chooseSearch(id: SearchProvider) {
    if (!selected) return;
    update({ searchProvider: id, searchKeys: keys, webSearchKey: searchKeyOf({ searchKeys: keys, webSearchKey: "" }, id),
      ...(id === "yandex" && !selected.searchFolderId && yandexFolder(selected.model) ? { searchFolderId: yandexFolder(selected.model)! } : {}) });
  }
  // Tavily credits left this month: loaded when Tavily is chosen and a key is entered,
  // refreshed after «Проверить поиск». The /usage request does not spend a search.
  const tavilyKey = selected?.allowWeb && search === "tavily" ? (keys.tavily || "").trim() : "";
  useEffect(() => {
    setUsage(null);
    if (!/^tvly-\S{8,}$/.test(tavilyKey)) return;
    const aborter = new AbortController();
    const timer = setTimeout(() => {
      fetchTavilyUsage(tavilyKey, fetch, aborter.signal)
        .then(u => { if (!aborter.signal.aborted) setUsage({ text: formatTavilyUsage(u), ok: u.limit === null || u.used < u.limit }); })
        .catch(e => { if (!aborter.signal.aborted) setUsage({ text: "Остаток запросов Tavily не получен: " + String((e as Error)?.message || e), ok: false }); });
    }, 700);
    return () => { clearTimeout(timer); aborter.abort(); };
  }, [tavilyKey, usageTick]);

  async function runCheck() {
    if (!selected || checking) return;
    checkAbort.current?.abort(); const aborter = new AbortController(); checkAbort.current = aborter;
    setChecking(true); setCheck(null);
    const result = await checkConnection(selected, undefined, aborter.signal);
    if (!aborter.signal.aborted) { setCheck(result); setChecking(false); }
  }
  async function runSearchCheck() {
    if (!selected || searching) return;
    searchAbort.current?.abort(); const aborter = new AbortController(); searchAbort.current = aborter;
    setSearching(true); setSearchCheck(null);
    const result = await checkWebSearch({ ...selected, searchProvider: search, searchKeys: keys }, fetch, aborter.signal);
    if (!aborter.signal.aborted) { setSearchCheck(result); setSearching(false); setUsageTick(x => x + 1); }
  }
  async function save() {
    if (!profile || !value || pending.current) return;
    pending.current = true;
    setBusy(true); setNotice("");
    try {
      await saveDirectConnections(profile, { ...value, activeId: selectedId,
        connections: value.connections.map(c => c.searchProvider === "builtin" && c.provider !== "openai" ? { ...c, searchProvider: "tavily" as const } : c) });
      setLeaving(true);
    } catch (e) { setNotice((e as Error).message); }
    finally { pending.current = false; setBusy(false); }
  }

  const field = { borderWidth: 1, borderColor: t.line, padding: 14, minHeight: 50, borderRadius: 16, color: t.text, backgroundColor: t.panel };
  const label = { color: t.text, fontWeight: "600" as const };
  const small = { color: t.muted, fontSize: 12, lineHeight: 17 };
  const card = { backgroundColor: t.soft, padding: 16, borderRadius: 22, gap: 10 };
  const chip = (on: boolean) => ({ minHeight: 44, paddingHorizontal: 14, justifyContent: "center" as const, borderRadius: 14,
    borderWidth: 1, borderColor: on ? t.accent : t.line, backgroundColor: on ? t.panel : t.bg });
  const host = (url: string) => { try { return new URL(url).host; } catch { return url; } };
  return (
    <KeyboardAvoidingView style={{ flex: 1, backgroundColor: t.bg }} behavior={Platform.OS === "ios" ? "padding" : undefined} keyboardVerticalOffset={headerHeight}>
    <ScrollView keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag" contentContainerStyle={{ padding: 18, paddingBottom: insets.bottom + 24, gap: 12 }}>
      <Text style={{ color: t.text, fontSize: 28, fontWeight: "800" }}>Ваши модели</Text>
      {dirty ? <Text accessibilityLiveRegion="polite" accessibilityLabel="Несохранённые настройки подключения" style={{ color: t.secondary, fontSize: 13 }}>Изменения не сохранены. Нажмите «Сохранить настройки», чтобы применить их.</Text> : null}
      {!value && !notice ? <ActivityIndicator accessibilityLabel="Загрузка подключений" /> : null}
      {value && selected ? <>
        <View style={{ gap: 8 }}>
          {value.connections.map(c => {
            const on = c.id === selectedId;
            return <Pressable key={c.id} disabled={busy} accessibilityRole="button" accessibilityLabel={"Подключение " + c.name}
              accessibilityState={{ selected: on }} onPress={() => choose(c.id)}
              style={{ padding: 14, borderRadius: 18, borderWidth: 1, borderColor: on ? t.accent : t.line, backgroundColor: on ? t.soft : t.panel }}>
              <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
                <Text style={{ color: t.text, fontWeight: "700", flex: 1 }}>{c.name}</Text>
                {c.id === value.activeId ? <Text style={{ color: t.secondary, fontSize: 12 }}>активна</Text> : null}
              </View>
              <Text style={{ ...small, marginTop: 4 }} numberOfLines={1}>{c.model || "модель не указана"} · {host(c.baseUrl)}</Text>
            </Pressable>;
          })}
          <Pressable disabled={busy || value.connections.length >= 20} accessibilityRole="button" accessibilityLabel="Добавить подключение"
            style={{ ...chip(false), alignItems: "center" }} onPress={() => add({ ...newDirectConnection("openai-compatible"), name: "Новое подключение", baseUrl: "", model: "" })}>
            <Text style={{ color: t.secondary, fontWeight: "700" }}>+ Новое подключение</Text>
          </Pressable>
        </View>

        <Collapsible id="connection.model" card={false} defaultOpen title="Модель" summary={(selected.model || "модель не указана") + " · " + host(selected.baseUrl) + (selected.apiKey ? " · ключ введён" : "")}>
        <View style={card}>
          <Text style={label}>Тип API</Text>
          <View style={{ flexDirection: "row", gap: 8 }}>
            {API_TYPES.map(a => <Pressable key={a.id} disabled={busy} accessibilityRole="button" accessibilityLabel={"Тип API " + a.name}
              accessibilityState={{ selected: type === a.id }} style={{ ...chip(type === a.id), flex: 1, alignItems: "center" }} onPress={() => setType(a.id)}>
              <Text style={{ color: type === a.id ? t.secondary : t.text, fontWeight: type === a.id ? "700" : "400" }}>{type === a.id ? "● " : "○ "}{a.name}</Text>
            </Pressable>)}
          </View>
          <Text style={small}>{API_TYPES.find(a => a.id === type)!.hint}</Text>

          <Text style={label}>Заполнить по шаблону</Text>
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
            {PROVIDER_PRESETS.filter(p => apiTypeOf(p.provider) === type).map(p => <Pressable key={p.id} disabled={busy} accessibilityRole="button"
              accessibilityLabel={"Шаблон " + p.name} style={chip(preset?.id === p.id)} onPress={() => applyPreset(p)}>
              <Text style={{ color: t.secondary }}>{p.name}</Text>
            </Pressable>)}
          </View>
          <Text style={small}>Шаблон подставит адрес и модель; ключ вставьте свой.{preset ? " " + preset.hint : ""}</Text>

          <Text style={label}>Название</Text>
          <TextInput editable={!busy} accessibilityLabel="Название подключения" value={selected.name} onChangeText={name => update({ name })}
            placeholder="Например, DeepSeek" placeholderTextColor={t.muted} style={field} maxLength={60} />
          <Text style={label}>Адрес API</Text>
          <TextInput editable={!busy} accessibilityLabel="Адрес API LLM" autoCapitalize="none" autoCorrect={false} keyboardType="url"
            value={selected.baseUrl} onChangeText={setAddress} placeholder="https://…" placeholderTextColor={t.muted} style={field} />
          <Text style={small}>Только https://; http:// — для модели в вашей локальной сети. После смены адреса ключ нужно ввести заново.</Text>
          <Text style={label}>API-ключ (токен){selected.apiKey ? " — введён" : ""}</Text>
          <TextInput editable={!busy} accessibilityLabel="API-ключ LLM" secureTextEntry autoCapitalize="none" autoCorrect={false}
            value={selected.apiKey} onChangeText={apiKey => update({ apiKey })} placeholder={/^http:\/\//.test(selected.baseUrl) ? "Не нужен для локальной модели" : "Ключ этого сервиса"} placeholderTextColor={t.muted} style={field} />
          <Text style={label}>Модель</Text>
          <TextInput editable={!busy} accessibilityLabel="Название модели" autoCapitalize="none" autoCorrect={false} value={selected.model}
            onChangeText={model => update({ model })} placeholder="Например, deepseek-flash" placeholderTextColor={t.muted} style={field} />
          <Pressable accessibilityRole="button" accessibilityLabel="Проверить связь" disabled={busy || checking} onPress={() => void runCheck()}
            style={{ minHeight: 46, justifyContent: "center", alignItems: "center", borderRadius: 16, borderWidth: 1, borderColor: t.accent }}>
            {checking ? <ActivityIndicator accessibilityLabel="Проверка связи" /> : <Text style={{ color: t.secondary, fontWeight: "700" }}>Проверить связь</Text>}
          </Pressable>
          {check ? <Text selectable accessibilityRole="alert" style={{ color: check.ok ? t.ok : t.err }}>{check.ok ? "Связь есть. Модель ответила: «" + check.reply + "»" : check.message}</Text> : null}
        </View>
        </Collapsible>

        <Collapsible id="connection.search" card={false} title="Интернет-поиск" summary={selected.allowWeb ? "Включён · " + SEARCH_OPTIONS.find(o => o.id === search)!.name : "Выключен"}>
        <View style={card}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}>
            <Text style={{ color: t.text, flex: 1 }}>Искать в интернете, если в памяти ничего нет</Text>
            <Switch disabled={busy} accessibilityLabel="Разрешить веб-поиск" value={selected.allowWeb} onValueChange={allowWeb => update({ allowWeb })} />
          </View>
          {selected.allowWeb ? <>
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
              {SEARCH_OPTIONS.filter(o => o.id !== "builtin" || selected.provider === "openai").map(o => <Pressable key={o.id} disabled={busy} accessibilityRole="button"
                accessibilityLabel={"Поиск " + o.name} accessibilityState={{ selected: search === o.id }} style={chip(search === o.id)} onPress={() => chooseSearch(o.id)}>
                <Text style={{ color: search === o.id ? t.secondary : t.text, fontWeight: search === o.id ? "700" : "400" }}>{search === o.id ? "● " : "○ "}{o.name}</Text>
              </Pressable>)}
            </View>
            <Text style={small}>{SEARCH_OPTIONS.find(o => o.id === search)!.hint} У каждого способа поиска свой ключ; при переключении ключи сохраняются.</Text>
            {search === "tavily" ? <TextInput editable={!busy} accessibilityLabel="Ключ Tavily" secureTextEntry autoCapitalize="none" autoCorrect={false}
              value={keys.tavily || ""} onChangeText={key => setSearchKey("tavily", key)} placeholder="Ключ Tavily (tvly-…)" placeholderTextColor={t.muted} style={field} /> : null}
            {search === "tavily" && usage ? <Text selectable accessibilityLabel="Остаток запросов Tavily" style={{ color: usage.ok ? t.muted : t.err, fontSize: 13 }}>{usage.text}</Text> : null}
            {search === "deepseek" ? <TextInput editable={!busy} accessibilityLabel="Ключ DeepSeek для поиска" secureTextEntry autoCapitalize="none" autoCorrect={false}
              value={keys.deepseek || ""} onChangeText={key => setSearchKey("deepseek", key)}
              placeholder={isDeepSeekApi(selected.baseUrl) ? "Не нужен: используется ключ подключения" : "Ключ DeepSeek (sk-…)"} placeholderTextColor={t.muted} style={field} /> : null}
            {search === "yandex" ? <>
              <TextInput editable={!busy} accessibilityLabel="API-ключ Yandex Cloud для поиска" secureTextEntry autoCapitalize="none" autoCorrect={false}
                value={keys.yandex || ""} onChangeText={key => setSearchKey("yandex", key)} placeholder="API-ключ Yandex Cloud (AQVN…)" placeholderTextColor={t.muted} style={field} />
              <TextInput editable={!busy} accessibilityLabel="Идентификатор каталога Yandex Cloud" autoCapitalize="none" autoCorrect={false}
                value={selected.searchFolderId || ""} onChangeText={searchFolderId => update({ searchFolderId })} placeholder="Идентификатор каталога (b1g…)" placeholderTextColor={t.muted} style={field} />
            </> : null}
            {search !== "builtin" ? <Pressable accessibilityRole="button" accessibilityLabel="Проверить поиск" disabled={busy || searching} onPress={() => void runSearchCheck()}
              style={{ minHeight: 46, justifyContent: "center", alignItems: "center", borderRadius: 16, borderWidth: 1, borderColor: t.accent }}>
              {searching ? <ActivityIndicator accessibilityLabel="Проверка поиска" /> : <Text style={{ color: t.secondary, fontWeight: "700" }}>Проверить поиск</Text>}
            </Pressable> : null}
            {searchCheck ? <Text selectable accessibilityRole="alert" style={{ color: searchCheck.ok ? t.ok : t.err }}>{searchCheck.ok ? "Поиск работает: найдено ссылок — " + searchCheck.count + (searchCheck.first ? ", первая: " + searchCheck.first : "") + "." : searchCheck.message}</Text> : null}
          </> : <Text style={small}>Помощник всегда сначала ищет в памяти телефона. С поиском он сообщит, что в памяти пусто, и поищет в интернете.</Text>}
        </View>
        </Collapsible>

        {notice ? <Text accessibilityRole="alert" style={{ color: t.err }}>{notice}</Text> : null}
        <Pressable accessibilityRole="button" disabled={busy} onPress={() => void save()}
          style={{ minHeight: 52, justifyContent: "center", alignItems: "center", backgroundColor: t.accent, borderRadius: 18 }}>
          <Text style={{ color: "#fff", fontWeight: "700" }}>{busy ? "Сохранение…" : "Сохранить настройки"}</Text>
        </Pressable>
        <Text style={small}>Сохранение делает выбранное подключение активным. Число обращений к модели на сообщение задаётся в Настройки → Работа ИИ. До 4000 выходных токенов на обращение (8000 для моделей с рассуждением); денежный бюджет задаётся у провайдера.</Text>
        {value.connections.length > 1 ? <Pressable accessibilityRole="button" disabled={busy} accessibilityLabel="Удалить подключение" style={{ minHeight: 44, justifyContent: "center" }}
          onPress={() => Alert.alert("Удалить подключение «" + selected.name + "»?", "Изменение вступит в силу после сохранения.", [
            { text: "Отмена", style: "cancel" }, { text: "Удалить", style: "destructive", onPress: () => {
              const rest = value.connections.filter(c => c.id !== selectedId);
              setValue({ activeId: rest.some(c => c.id === value.activeId) ? value.activeId : rest[0].id, connections: rest }); choose(rest[0].id);
            } },
          ])}><Text style={{ color: t.err }}>Удалить это подключение</Text></Pressable> : null}
      </> : null}
      {notice && !value ? <><Text accessibilityRole="alert" style={{ color: t.err }}>{notice}</Text>
        <Pressable accessibilityRole="button" onPress={() => setRetry(x => x + 1)} style={{ minHeight: 44 }}><Text style={{ color: t.secondary }}>Повторить загрузку</Text></Pressable></> : null}
    {profile && value ? <MediaSettings profile={profile} connections={value.connections} /> : null}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}
