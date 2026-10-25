import { useHeaderHeight } from "@react-navigation/elements";
import * as DocumentPicker from "expo-document-picker";
import React, { useRef, useState } from "react";
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, Text, TextInput } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useProfile } from "../profile/ProfileContext";
import { useDirectChat } from "../direct-agent/ChatContext";
import { createRecoveryCode, restoreEncryptedBackup, shareEncryptedBackup } from "../local-memory/backup";
import { memoryErrorMessage } from "../local-memory/errors";
import { withNativeInteraction } from "../security/native-interaction";
import { useTheme } from "../theme";

export function MemoryBackupScreen() {
  const t = useTheme(); const insets = useSafeAreaInsets(); const header = useHeaderHeight();
  const profile = useProfile();
  const { store, conversations } = useDirectChat();
  const [code, setCode] = useState(""); const [confirmed, setConfirmed] = useState(false); const [restoreCode, setRestoreCode] = useState("");
  const [busy, setBusy] = useState(false); const [notice, setNotice] = useState(""); const pending = useRef(false);
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
      <Text style={{ color: t.muted, lineHeight: 22 }}>Записи и диалоги сохраняются в зашифрованном файле. Сначала создайте код, сохраните его отдельно, затем выберите, куда отправить файл копии. Без кода восстановление невозможно.</Text>
      <Pressable accessibilityRole="button" accessibilityLabel="Создать новый код восстановления" disabled={busy} onPress={() => { setCode(createRecoveryCode()); setConfirmed(false); }} style={button}><Text style={{ color: t.secondary, fontWeight: "700" }}>{code ? "Создать другой код" : "1 · Создать код восстановления"}</Text></Pressable>
      {code ? <>
        <Text style={{ color: t.muted }}>2 · Нажмите и удерживайте код, чтобы скопировать. Сохраните его отдельно от файла.</Text>
        <Text selectable accessibilityLabel="Код восстановления резервной копии" style={{ color: t.text, fontFamily: "monospace" }}>{code}</Text>
        <Pressable accessibilityRole="checkbox" accessibilityLabel="Код сохранён отдельно" accessibilityState={{ checked: confirmed }} onPress={() => setConfirmed(c => !c)} style={button}><Text style={{ color: t.text }}>{confirmed ? "☑" : "☐"} Я сохранил код отдельно от файла</Text></Pressable>
        <Pressable accessibilityRole="button" accessibilityLabel="Экспортировать зашифрованную копию" disabled={busy || !confirmed} onPress={() => void run(async () => {
          await store.checkpoint();
          await withNativeInteraction(() => shareEncryptedBackup(profile!, code));
          setCode(""); setConfirmed(false); setNotice("Копия передана выбранному приложению.");
        })} style={{ ...button, backgroundColor: t.accent, opacity: busy || !confirmed ? 0.45 : 1 }}><Text style={{ color: t.userText, fontWeight: "700" }}>{busy ? "Подготовка…" : "3 · Сохранить файл копии"}</Text></Pressable>
      </> : null}
      <Text style={{ color: t.text, fontSize: 20, fontWeight: "700", marginTop: 12 }}>Восстановить</Text>
      <Text style={{ color: t.muted, lineHeight: 22 }}>Записи можно восстановить в пустую память. Существующие диалоги сохранятся.</Text>
      <TextInput accessibilityLabel="Код восстановления для импорта" value={restoreCode} onChangeText={value => setRestoreCode(value.replace(/\s/g, ""))} editable={!busy} secureTextEntry autoCapitalize="none" autoCorrect={false} placeholder="Вставьте код восстановления" placeholderTextColor={t.muted} style={{ minHeight: 50, padding: 14, color: t.text, borderWidth: 1, borderColor: t.line, borderRadius: 16 }} />
      <Text accessibilityLiveRegion="polite" style={{ color: restoreCode && !codeValid ? t.err : t.muted }}>{!restoreCode ? "Удерживайте поле → Вставить. Код состоит из 64 символов: цифры и буквы a–f." : codeValid ? "Формат кода верный. Выберите файл копии." : `Проверьте код: ${normalizedCode.length}/64 символов, допустимы 0–9 и a–f.`}</Text>
      <Pressable accessibilityRole="button" accessibilityLabel="Восстановить зашифрованную копию" accessibilityState={{ disabled: restoreDisabled }} disabled={restoreDisabled} onPress={() => void run(async () => {
        const file = await withNativeInteraction(() => DocumentPicker.getDocumentAsync({ copyToCacheDirectory: true }));
        if (file.canceled || !file.assets.length) return;
        const stats = await restoreEncryptedBackup(profile!, file.assets[0].uri, normalizedCode);
        setRestoreCode(""); await store.initialize();
        setNotice(`Восстановлено записей: ${stats.entities}.`);
      })} style={{ ...button, backgroundColor: t.accent, opacity: restoreDisabled ? 0.45 : 1 }}><Text style={{ color: t.userText, fontWeight: "700" }}>Выбрать файл и восстановить</Text></Pressable>
      {notice ? <Text accessibilityRole="alert" style={{ color: t.muted }}>{notice}</Text> : null}
    </ScrollView>
  </KeyboardAvoidingView>;
}
