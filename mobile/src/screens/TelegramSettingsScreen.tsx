import React, {useEffect, useRef, useState} from "react";
import {ScrollView, Text, TextInput} from "react-native";
import {useSafeAreaInsets} from "react-native-safe-area-context";
import {useProfile} from "../profile/ProfileContext";
import {useTheme} from "../theme";
import {TelegramBotCard} from "../telegram/TelegramBotCard";
import {TelegramAccountCard} from "../telegram/TelegramAccountCard";
import {NebulaAction, NebulaSection} from "../design/nebula/components";
import {nebulaRadii, nebulaSpacing, nebulaTypography} from "../design/nebula/tokens";
import {
  clearTelegramApiCredentials, inspectTelegramApiCredentials, loadTelegramSyncMode,
  saveTelegramApiCredentials, saveTelegramSyncMode, loadLastTelegramAutoSync,
  type TelegramAutoSyncResult, type TelegramSyncMode,
} from "../telegram/settings";

/** Profile-scoped Telegram settings. Connection status is owned by TDLib, not saved API parameters. */
export function TelegramSettingsScreen() {
  const profile = useProfile(), theme = useTheme(), insets = useSafeAreaInsets();
  const [mode, setMode] = useState<TelegramSyncMode>("manual");
  const [lastSync,setLastSync]=useState<TelegramAutoSyncResult|null>(null);
  const [apiId, setApiId] = useState(""), [apiHash, setApiHash] = useState("");
  const [configured, setConfigured] = useState(false);
  const [ready, setReady] = useState(false), [busy, setBusy] = useState(false);
  const [modeNotice,setModeNotice]=useState(""),[modeError,setModeError]=useState("");
  const [apiNotice,setApiNotice]=useState(""),[apiError,setApiError]=useState("");
  const [confirmClear,setConfirmClear]=useState(false);
  const live = useRef(0), saving = useRef(false);
  useEffect(() => {
    const version = ++live.current;
    setReady(false); setModeError("");setApiError("");setModeNotice("");setApiNotice("");setConfirmClear(false); setApiHash("");
    void Promise.all([loadTelegramSyncMode(profile), inspectTelegramApiCredentials(profile),loadLastTelegramAutoSync(profile)])
      .then(([value, info, last]) => {
        if (version !== live.current) return;
        setMode(value);setLastSync(last); setConfigured(info.configured); setApiId(info.apiId ? String(info.apiId) : "");
      }).catch(() => {
        if (version === live.current) setApiError("Не удалось прочитать защищённые настройки.");
      }).finally(() => {if (version === live.current) setReady(true);});
    return () => { live.current++; };
  }, [profile]);

  async function run(task: (version: number) => Promise<void>, success: string, section:"mode"|"api") {
    if (!ready || saving.current) return;
    const version = live.current;
    saving.current = true; setBusy(true);
    if(section==="mode"){setModeError("");setModeNotice("");}
    else {setApiError("");setApiNotice("");}
    try {
      await task(version);
      if (version === live.current) (section==="mode"?setModeNotice:setApiNotice)(success);
    } catch (e) {
      if (version === live.current) (section==="mode"?setModeError:setApiError)(
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
    }, "Режим сохранён.", "mode");
  }
  async function saveApi() {
    await run(async (version) => {
      await saveTelegramApiCredentials(profile, apiId, apiHash);
      if (version === live.current) { setConfigured(true); setApiHash(""); }
    }, "API-параметры сохранены.", "api");
  }
  async function clearApi() {
    await run(async (version) => {
      await clearTelegramApiCredentials(profile);
      if (version === live.current) { setConfigured(false); setApiId(""); setApiHash("");setConfirmClear(false); }
    }, "API-параметры удалены.", "api");
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
        При запуске — после разблокировки PersAI. Для синхронизации «Избранного»
        нужен авторизованный аккаунт Telegram, резервный бот работает независимо.
        При запуске PersAI импортируются новые текстовые сообщения «Избранного»
        с прошлого раза, не более 100. Файлы импортируются вручную.
      </Text>
      {([["manual", "Вручную"], ["on_open", "При каждом запуске PersAI"]] as const).map(([value, label]) =>
        <NebulaAction key={value} accessibilityLabel={label}
          label={(mode === value ? "● " : "○ ") + label}
          disabled={disabled} onPress={() => void choose(value)} />)}
      {modeError?<Text accessibilityRole="alert" style={{color:theme.err}}>{modeError}</Text>:null}
      {modeNotice?<Text accessibilityLiveRegion="polite" style={{color:theme.ok}}>{modeNotice}</Text>:null}
      {lastSync?<Text style={{color:theme.muted,...nebulaTypography.label}}>
        Последняя синхронизация при запуске: {new Date(lastSync.at).toLocaleString("ru-RU")}
        {" — сохранено "+lastSync.saved+", уже были "+lastSync.duplicates+
          ", медиа пропущено "+lastSync.unsupported+"."}
        {lastSync.unsupported>0?" Сообщений с файлами пропущено: "+lastSync.unsupported+
          " — импортируйте их вручную кнопкой ниже.":""}
        {lastSync.gap?" Новых сообщений было больше 100. Более старые импортируйте вручную кнопкой ниже.":""}
        {lastSync.error==="bot_blocked"
          ?" Импорт бота остановлен: в очереди неподдерживаемое сообщение. Откройте карточку бота."
          :lastSync.error?" Не удалось: "+(lastSync.error==="telegram_app_locked"?
            "приложение заблокировано":lastSync.error==="network"?"ошибка сети":"ошибка Telegram")+".":""}
      </Text>:null}
    </NebulaSection>
    <NebulaSection title="Аккаунт Telegram">
      <Text style={{color: theme.muted, ...nebulaTypography.label}}>
        Чтобы подключить личный аккаунт, нужны API ID и API hash.
        Их выдаёт Telegram на my.telegram.org → API development tools.
        Они хранятся только на этом телефоне.
        Подключение доступно в APK со встроенной TDLib.
      </Text>
      <TextInput accessibilityLabel="Telegram API ID" keyboardType="number-pad"
        value={apiId} onChangeText={setApiId} editable={!disabled}
        placeholder="API ID" placeholderTextColor={theme.muted} maxLength={10} style={field}/>
      <TextInput accessibilityLabel="Telegram API hash" secureTextEntry
        autoCapitalize="none" autoCorrect={false} value={apiHash} onChangeText={setApiHash}
        editable={!disabled} placeholder="API hash"
        placeholderTextColor={theme.muted} maxLength={32} style={field}/>
      <Text style={{color: theme.muted, ...nebulaTypography.label}}>
        {configured ? "API-параметры сохранены." : "API-параметры не сохранены."}
      </Text>
      <NebulaAction icon="shield" label="Сохранить API-параметры"
        disabled={disabled || !apiId || !apiHash} onPress={() => void saveApi()}/>
      {configured ? (confirmClear ? <>
        <Text style={{color:theme.muted,...nebulaTypography.label}}>
          Без API-параметров сессия Telegram не сможет возобновиться.
          Сам аккаунт и заметки не изменятся.
        </Text>
        <NebulaAction icon="trash-2" variant="danger" label="Подтвердить удаление API-параметров"
          disabled={disabled} onPress={()=>void clearApi()}/>
        <NebulaAction label="Отмена" disabled={disabled}
          onPress={()=>setConfirmClear(false)}/>
      </> : <NebulaAction icon="trash-2" variant="danger" label="Удалить API-параметры"
        disabled={disabled} onPress={()=>setConfirmClear(true)}/>) : null}
      {busy ? <Text accessibilityLiveRegion="polite" style={{color:theme.muted}}>Сохраняю…</Text> : null}
      {apiError ? <Text accessibilityRole="alert" style={{color:theme.err}}>{apiError}</Text> : null}
      {apiNotice ? <Text accessibilityLiveRegion="polite" style={{color:theme.ok}}>{apiNotice}</Text> : null}
      <TelegramAccountCard profile={profile} apiConfigured={configured}/>
    </NebulaSection>
    <NebulaSection title="Резервный канал — личный бот">
      <TelegramBotCard profile={profile}/>
    </NebulaSection>
    {!ready?<Text accessibilityLiveRegion="polite" style={{color:theme.muted}}>
      Загружаю настройки…
    </Text>:null}
  </ScrollView>;
}
