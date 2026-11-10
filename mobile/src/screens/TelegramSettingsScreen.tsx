import React, {useEffect, useRef, useState} from "react";
import {ScrollView, Text, TextInput} from "react-native";
import {useSafeAreaInsets} from "react-native-safe-area-context";
import {useProfile} from "../profile/ProfileContext";
import {useTheme} from "../theme";
import {TelegramBotCard} from "../telegram/TelegramBotCard";
import {NebulaAction, NebulaSection} from "../design/nebula/components";
import {nebulaRadii, nebulaSpacing, nebulaTypography} from "../design/nebula/tokens";
import {
  clearTelegramApiCredentials, inspectTelegramApiCredentials, loadTelegramSyncMode,
  saveTelegramApiCredentials, saveTelegramSyncMode, type TelegramSyncMode,
} from "../telegram/settings";

/** Setup UI, NOT a claim of a live TDLib session. Native bridge lands separately. */
export function TelegramSettingsScreen() {
  const profile = useProfile(), theme = useTheme(), insets = useSafeAreaInsets();
  const [mode, setMode] = useState<TelegramSyncMode>("manual");
  const [apiId, setApiId] = useState(""), [apiHash, setApiHash] = useState("");
  const [configured, setConfigured] = useState(false);
  const [ready, setReady] = useState(false), [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState(""), [error, setError] = useState("");
  const live = useRef(0), saving = useRef(false);
  useEffect(() => {
    const version = ++live.current;
    setReady(false); setError(""); setApiHash("");
    void Promise.all([loadTelegramSyncMode(profile), inspectTelegramApiCredentials(profile)])
      .then(([value, info]) => {
        if (version !== live.current) return;
        setMode(value); setConfigured(info.configured); setApiId(info.apiId ? String(info.apiId) : "");
      }).catch(() => {
        if (version === live.current) setError("Не удалось прочитать защищённые настройки.");
      }).finally(() => {if (version === live.current) setReady(true);});
    return () => { live.current++; };
  }, [profile]);

  async function run(task: (version: number) => Promise<void>, success: string) {
    if (!ready || saving.current) return;
    const version = live.current;
    saving.current = true; setBusy(true); setError(""); setNotice("");
    try {
      await task(version);
      if (version === live.current) setNotice(success);
    } catch (e) {
      if (version === live.current) setError(
        e instanceof Error && /^(Укажите|Telegram API hash)/.test(e.message)
          ? e.message : "Не удалось сохранить параметры Telegram.");
    } finally {
      saving.current = false;
      if (version === live.current) setBusy(false);
    }
  }
  async function choose(value: TelegramSyncMode) {
    if (value === mode) return;
    await run(async (version) => {
      await saveTelegramSyncMode(profile, value);
      if (version === live.current) setMode(value);
    }, "Режим сохранён. Синхронизация заработает после подключения аккаунта.");
  }
  async function saveApi() {
    await run(async (version) => {
      await saveTelegramApiCredentials(profile, apiId, apiHash);
      if (version === live.current) { setConfigured(true); setApiHash(""); }
    }, "API-параметры сохранены. Авторизация Telegram ещё не выполнена.");
  }
  async function clearApi() {
    await run(async (version) => {
      await clearTelegramApiCredentials(profile);
      if (version === live.current) { setConfigured(false); setApiId(""); setApiHash(""); }
    }, "API-параметры удалены.");
  }
  const field = {minHeight: 46, borderWidth: 1, borderColor: theme.line,
    borderRadius: nebulaRadii.field, color: theme.text, backgroundColor: theme.panel,
    paddingHorizontal: nebulaSpacing.md};
  const disabled = !ready || busy;
  return <ScrollView testID="telegram-settings" keyboardShouldPersistTaps="handled"
    style={{flex: 1, backgroundColor: theme.bg}}
    contentContainerStyle={{padding: nebulaSpacing.md, gap: nebulaSpacing.xl,
      paddingBottom: insets.bottom + nebulaSpacing.xl}}>
    <NebulaSection title="Режим синхронизации">
      <Text style={{color: theme.muted, ...nebulaTypography.label}}>
        Настраивается отдельно от подключения. По умолчанию — вручную.
        Автоматический запуск только после разблокировки PersAI и входа в Telegram.
      </Text>
      {([["manual", "Вручную"], ["on_open", "При каждом запуске PersAI"]] as const).map(([value, label]) =>
        <NebulaAction key={value} accessibilityLabel={label}
          label={(mode === value ? "● " : "○ ") + label}
          disabled={disabled} onPress={() => void choose(value)} />)}
    </NebulaSection>
    <NebulaSection title="Аккаунт Telegram">
      <Text style={{color: theme.muted, ...nebulaTypography.label}}>
        Подготовка к TDLib. Нативная библиотека и авторизация будут добавлены
        отдельным PR; эта версия не читает Telegram. API ID и API hash
        приложения можно получить на my.telegram.org.
      </Text>
      <TextInput accessibilityLabel="Telegram API ID" keyboardType="number-pad"
        value={apiId} onChangeText={setApiId} editable={!disabled}
        placeholder="API ID" placeholderTextColor={theme.muted} maxLength={10} style={field}/>
      <TextInput accessibilityLabel="Telegram API hash" secureTextEntry
        autoCapitalize="none" autoCorrect={false} value={apiHash} onChangeText={setApiHash}
        editable={!disabled} placeholder="API hash"
        placeholderTextColor={theme.muted} maxLength={32} style={field}/>
      <Text style={{color: theme.muted, ...nebulaTypography.label}}>
        {configured ? "API-параметры сохранены локально. Аккаунт не авторизован." : "API-параметры не сохранены."}
      </Text>
      <NebulaAction icon="shield" label="Сохранить API-параметры"
        disabled={disabled || !apiId || !apiHash} onPress={() => void saveApi()}/>
      {configured ? <NebulaAction icon="trash-2" variant="danger" label="Удалить API-параметры"
        disabled={disabled} onPress={() => void clearApi()}/> : null}
    </NebulaSection>
    <NebulaSection title="Резервный канал — личный бот">
      <TelegramBotCard profile={profile}/>
    </NebulaSection>
    {!ready || busy ? <Text accessibilityLiveRegion="polite" style={{color:theme.muted}}>
      {busy ? "Сохраняю…" : "Загружаю настройки…"}
    </Text> : null}
    {error ? <Text accessibilityRole="alert" style={{color:theme.err}}>{error}</Text> : null}
    {notice ? <Text accessibilityLiveRegion="polite" style={{color:theme.ok}}>{notice}</Text> : null}
  </ScrollView>;
}
