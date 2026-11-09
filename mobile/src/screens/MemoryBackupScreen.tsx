import { useHeaderHeight } from "@react-navigation/elements";
import * as DocumentPicker from "expo-document-picker";
import React, { useCallback, useEffect, useRef, useState } from "react";
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, Text, TextInput } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useProfile } from "../profile/ProfileContext";
import { useDirectChat } from "../direct-agent/ChatContext";
import { createRecoveryCode, restoreEncryptedBackup, shareEncryptedBackup } from "../local-memory/backup";
import { memoryErrorMessage } from "../local-memory/errors";
import { withNativeInteraction } from "../security/native-interaction";
import { useTheme } from "../theme";
import {
  getRecoveryModels, missingRecoveryModels, downloadMissingRecoveryModels,
  cancelRecoveryModelDownload, recoveryModelTitle, recoveryModelApproxMb,
  type RecoveryModel, type RecoveryProgress,
} from "../media/model-backup-recovery";

export function MemoryBackupScreen() {
  const t = useTheme(); const insets = useSafeAreaInsets(); const header = useHeaderHeight();
  const profile = useProfile();
  const { store, conversations } = useDirectChat();
  const [code, setCode] = useState(""); const [confirmed, setConfirmed] = useState(false); const [restoreCode, setRestoreCode] = useState("");
  const [busy, setBusy] = useState(false); const [notice, setNotice] = useState(""); const pending = useRef(false);
  const [missingModels, setMissingModels] = useState<RecoveryModel[]>([]);
  const [modelProgress, setModelProgress] = useState<RecoveryProgress | null>(null);
  const [modelsNotice, setModelsNotice] = useState("");
  const cancellingModels = useRef(false);
  const activeModel = useRef<RecoveryModel | null>(null);
  const refreshRecovery = useCallback(async () => {
    if (!profile) return;
    const plan = await getRecoveryModels(profile);
    const missing = plan ? await missingRecoveryModels(profile) : [];
    setMissingModels(missing);
  }, [profile]);
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        if (!profile) return;
        const plan = await getRecoveryModels(profile);
        const missing = plan ? await missingRecoveryModels(profile) : [];
        if (alive) setMissingModels(missing);
      } catch {
        if (alive) setModelsNotice("Не удалось прочитать список моделей для восстановления.");
      }
    })();
    return () => { alive = false; };
  }, [profile]);
  const modelsTotalMb = missingModels.reduce((total, model) => total + recoveryModelApproxMb(model), 0);
  const downloadModels = () => void run(async () => {
    cancellingModels.current = false;
    setModelsNotice("");
    try {
      const result = await downloadMissingRecoveryModels(profile!, progress => {
        activeModel.current = progress.model;
        setModelProgress(progress);
      }, () => cancellingModels.current);
      await refreshRecovery();
      setModelsNotice(result.cancelled
        ? "Загрузка моделей остановлена. Недостающие можно скачать позже."
        : result.failed.length
          ? "Скачано: " + result.downloaded + ". Не удалось восстановить: " + result.failed.join("; ") + ". Повторите при наличии интернета."
          : "Модели скачаны и проверены. При необходимости переиндексируйте фотографии в настройках.");
    } finally {
      activeModel.current = null;
      setModelProgress(null);
    }
  });
  const normalizedCode = restoreCode.replace(/\s/g, "").toLowerCase();
  const codeValid = /^[a-f0-9]{64}$/.test(normalizedCode);
  const restoreDisabled = busy || !codeValid || conversations.some(c => c.busy || c.savingDraft);
  const button = { minHeight: 52, padding: 14, justifyContent: "center" as const, borderRadius: 16, borderWidth: 1, borderColor: t.line };
  async function run(work: () => Promise<void>) {
    if (pending.current || !profile) return;
    pending.current = true; setBusy(true); setNotice("");
    try { await work(); } catch (e) { setNotice(memoryErrorMessage(e)); }
    finally { pending.current = false; setBusy(false); }
  }
  return <KeyboardAvoidingView style={{ flex: 1, backgroundColor: t.bg }} behavior={Platform.OS === "ios" ? "padding" : undefined} keyboardVerticalOffset={header}>
    <ScrollView keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag" contentContainerStyle={{ padding: 18, paddingBottom: insets.bottom + 24, gap: 16 }}>
      <Text style={{ color: t.text, fontSize: 25, fontWeight: "800" }}>Сохранить копию</Text>
      <Text style={{ color: t.muted, lineHeight: 22 }}>Записи, фотографии и вложения, история диалогов, все подключения моделей, API-ключи и настройки сохраняются в одном зашифрованном файле. Сохраните код восстановления отдельно: любой, у кого есть файл и код, сможет получить доступ к данным и ключам. Системные разрешения не переносятся. Для скачанных локальных моделей сохраняются названия, версии и контрольные суммы, но не сами большие файлы. После восстановления их можно скачать одной кнопкой.</Text>
      <Pressable accessibilityRole="button" accessibilityLabel="Создать новый код восстановления" disabled={busy} onPress={() => { setCode(createRecoveryCode()); setConfirmed(false); }} style={button}><Text style={{ color: t.secondary, fontWeight: "700" }}>{code ? "Создать другой код" : "1 · Создать код восстановления"}</Text></Pressable>
      {code ? <>
        <Text style={{ color: t.muted }}>2 · Нажмите и удерживайте код, чтобы скопировать. Сохраните его отдельно от файла.</Text>
        <Text selectable accessibilityLabel="Код восстановления резервной копии" style={{ color: t.text, fontFamily: "monospace" }}>{code}</Text>
        <Pressable accessibilityRole="checkbox" accessibilityLabel="Код сохранён отдельно" accessibilityState={{ checked: confirmed }} onPress={() => setConfirmed(c => !c)} style={button}><Text style={{ color: t.text }}>{confirmed ? "☑" : "☐"} Я сохранил код отдельно от файла</Text></Pressable>
        <Pressable accessibilityRole="button" accessibilityLabel="Экспортировать зашифрованную копию" disabled={busy || !confirmed} onPress={() => void run(async () => {
          try {
            await store.checkpoint();
          } catch {
            throw new Error("backup_checkpoint_failed");
          }
          await withNativeInteraction(() => shareEncryptedBackup(profile!, code));
          // expo-sharing cannot verify whether the target app actually saved
          // the file; a dismissed share sheet is NOT evidence of a backup.
          setNotice("Меню обмена закрыто. Проверьте, что файл копии действительно сохранён. Код восстановления оставьте отдельно.");
        })} style={{ ...button, backgroundColor: t.accent, opacity: busy || !confirmed ? 0.45 : 1 }}><Text style={{ color: t.userText, fontWeight: "700" }}>{busy ? "Подготовка…" : "3 · Сохранить файл копии"}</Text></Pressable>
      </> : null}
      <Text style={{ color: t.text, fontSize: 20, fontWeight: "700", marginTop: 12 }}>Восстановить</Text>
      <Text style={{ color: t.muted, lineHeight: 22 }}>Восстановление возможно в пустую память. Новая копия вернёт записи, диалоги, подключения моделей, API-ключи и настройки. Копия старого формата может не содержать настроек. Действующие настройки подключения будут заменены сохранёнными в копии. Если в копии есть список локальных моделей, ниже появится кнопка загрузки недостающих.</Text>
      <TextInput accessibilityLabel="Код восстановления для импорта" value={restoreCode} onChangeText={value => setRestoreCode(value.replace(/\s/g, ""))} editable={!busy} secureTextEntry autoCapitalize="none" autoCorrect={false} placeholder="Вставьте код восстановления" placeholderTextColor={t.muted} style={{ minHeight: 50, padding: 14, color: t.text, borderWidth: 1, borderColor: t.line, borderRadius: 16 }} />
      <Text accessibilityLiveRegion="polite" style={{ color: restoreCode && !codeValid ? t.err : t.muted }}>{!restoreCode ? "Удерживайте поле → Вставить. Код состоит из 64 символов: цифры и буквы a–f." : codeValid ? "Формат кода верный. Выберите файл копии." : `Проверьте код: ${normalizedCode.length}/64 символов, допустимы 0–9 и a–f.`}</Text>
      <Pressable accessibilityRole="button" accessibilityLabel="Восстановить зашифрованную копию" accessibilityState={{ disabled: restoreDisabled }} disabled={restoreDisabled} onPress={() => void run(async () => {
        const file = await withNativeInteraction(() => DocumentPicker.getDocumentAsync({ copyToCacheDirectory: true }));
        if (file.canceled || !file.assets.length) return;
        const stats = await restoreEncryptedBackup(profile!, file.assets[0].uri, normalizedCode);
        setRestoreCode(""); await store.initialize();
        await refreshRecovery();
        setNotice(`Восстановлено записей: ${stats.entities}. ${stats.settingsRestored
           ? "Подключения моделей, API-ключи и настройки также восстановлены."
           : stats.settingsWarning
             ? "Память восстановлена, но часть настроек и ключей вернуть не удалось. Проверьте подключения моделей."
             : "Копия старого формата: параметры подключений и API-ключи в ней отсутствуют."}`);
      })} style={{ ...button, backgroundColor: t.accent, opacity: restoreDisabled ? 0.45 : 1 }}><Text style={{ color: t.userText, fontWeight: "700" }}>Выбрать файл и восстановить</Text></Pressable>
      {notice ? <Text accessibilityRole="alert" style={{ color: t.muted }}>{notice}</Text> : null}
      {missingModels.length ? <>
        <Text style={{ color: t.text, fontSize: 19, fontWeight: "700", marginTop: 10 }}>
          Локальные модели из копии
        </Text>
        <Text style={{ color: t.muted, lineHeight: 21 }}>
          Не хватает {missingModels.length} моделей: {missingModels.map(recoveryModelTitle).join(", ")}.
          Общий размер загрузки около {modelsTotalMb} МБ. Лучше подключиться к Wi-Fi.
          Загрузка начнётся только после нажатия кнопки. Если версия на сервере изменилась,
          приложение сообщит об этом вместо молчаливой подмены.
        </Text>
        <Pressable accessibilityRole="button" accessibilityLabel="Скачать все недостающие локальные модели"
          disabled={busy} onPress={downloadModels} style={{ ...button, backgroundColor: t.accent, opacity: busy ? 0.5 : 1 }}>
          <Text style={{ color: t.userText, fontWeight: "700" }}>
            Скачать все недостающие модели
          </Text>
        </Pressable>
      </> : null}
      {modelProgress ? <>
        <Text accessibilityLiveRegion="polite" style={{ color: t.text }}>
          Скачивание {modelProgress.index} из {modelProgress.total}: {modelProgress.title}
        </Text>
        <Pressable accessibilityRole="button" accessibilityLabel="Остановить восстановление моделей"
          onPress={() => {
            cancellingModels.current = true;
            cancelRecoveryModelDownload(activeModel.current);
          }} style={button}>
          <Text style={{ color: t.secondary, fontWeight: "600" }}>Остановить скачивание моделей</Text>
        </Pressable>
      </> : null}
      {modelsNotice ? <Text accessibilityRole="alert" style={{ color: t.muted }}>{modelsNotice}</Text> : null}
    </ScrollView>
  </KeyboardAvoidingView>;
}
