import { useHeaderHeight } from "@react-navigation/elements";
import * as DocumentPicker from "expo-document-picker";
import React, { useRef, useState } from "react";
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, Text, TextInput } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useAuth } from "../auth/AuthContext";
import { useDirectChat } from "../direct-agent/ChatContext";
import { createRecoveryCode, restoreEncryptedBackup, shareEncryptedBackup } from "../local-memory/backup";
import { memoryErrorMessage } from "../local-memory/errors";
import { withNativeInteraction } from "../security/native-interaction";
import { useTheme } from "../theme";

export function MemoryBackupScreen() {
  const t = useTheme(); const insets = useSafeAreaInsets(); const header = useHeaderHeight();
  const { offlineMode, me } = useAuth(); const profile = offlineMode ? "guest" : me?.id;
  const { store, conversations } = useDirectChat();
  const [code, setCode] = useState(""); const [confirmed, setConfirmed] = useState(false); const [restoreCode, setRestoreCode] = useState("");
  const [busy, setBusy] = useState(false); const [notice, setNotice] = useState(""); const pending = useRef(false);
  const button = { minHeight: 52, padding: 14, justifyContent: "center" as const, borderRadius: 16, borderWidth: 1, borderColor: t.line };
  async function run(work: () => Promise<void>) {
    if (pending.current || !profile) return;
    pending.current = true; setBusy(true); setNotice("");
    try { await work(); } catch (e) { setNotice(memoryErrorMessage(e)); }
    finally { pending.current = false; setBusy(false); }
  }
  return <KeyboardAvoidingView style={{ flex: 1, backgroundColor: t.bg }} behavior={Platform.OS === "ios" ? "padding" : undefined} keyboardVerticalOffset={header}>
    <ScrollView keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag" contentContainerStyle={{ padding: 18, paddingBottom: insets.bottom + 24, gap: 16 }}>
      <Text style={{ color: t.text, fontSize: 25, fontWeight: "800" }}>Резервные копии</Text>
      <Text style={{ color: t.muted, lineHeight: 22 }}>Записи и диалоги сохраняются в зашифрованном файле. Код восстановления храните отдельно: без него файл нельзя прочитать.</Text>
      <Pressable accessibilityRole="button" accessibilityLabel="Создать новый код восстановления" disabled={busy} onPress={() => { setCode(createRecoveryCode()); setConfirmed(false); }} style={button}><Text style={{ color: t.accent, fontWeight: "700" }}>Создать код восстановления</Text></Pressable>
      {code ? <>
        <Text selectable accessibilityLabel="Код восстановления резервной копии" style={{ color: t.text, fontFamily: "monospace" }}>{code}</Text>
        <Pressable accessibilityRole="checkbox" accessibilityLabel="Код сохранён отдельно" accessibilityState={{ checked: confirmed }} onPress={() => setConfirmed(c => !c)} style={button}><Text style={{ color: t.text }}>{confirmed ? "☑" : "☐"} Я сохранил код отдельно от файла</Text></Pressable>
        <Pressable accessibilityRole="button" accessibilityLabel="Экспортировать зашифрованную копию" disabled={busy || !confirmed} onPress={() => void run(async () => {
          await store.checkpoint();
          await withNativeInteraction(() => shareEncryptedBackup(profile!, code));
          setCode(""); setConfirmed(false); setNotice("Копия передана выбранному приложению.");
        })} style={{ ...button, backgroundColor: t.accent }}><Text style={{ color: "#fff", fontWeight: "700" }}>{busy ? "Подготовка…" : "Сохранить резервную копию"}</Text></Pressable>
      </> : null}
      <Text style={{ color: t.text, fontSize: 20, fontWeight: "700", marginTop: 12 }}>Восстановить</Text>
      <Text style={{ color: t.muted, lineHeight: 22 }}>Записи можно восстановить в пустую память. Существующие диалоги сохранятся.</Text>
      <TextInput accessibilityLabel="Код восстановления для импорта" value={restoreCode} onChangeText={setRestoreCode} secureTextEntry autoCapitalize="none" autoCorrect={false} placeholder="64 символа кода" placeholderTextColor={t.muted} style={{ minHeight: 50, padding: 14, color: t.text, borderWidth: 1, borderColor: t.line, borderRadius: 16 }} />
      <Pressable accessibilityRole="button" accessibilityLabel="Восстановить зашифрованную копию" disabled={busy || restoreCode.trim().length !== 64 || conversations.some(c => c.busy || c.savingDraft)} onPress={() => void run(async () => {
        const file = await withNativeInteraction(() => DocumentPicker.getDocumentAsync({ copyToCacheDirectory: true }));
        if (file.canceled || !file.assets.length) return;
        const stats = await restoreEncryptedBackup(profile!, file.assets[0].uri, restoreCode);
        setRestoreCode(""); await store.initialize();
        setNotice(`Восстановлено записей: ${stats.entities}.`);
      })} style={{ ...button, backgroundColor: t.accent }}><Text style={{ color: "#fff", fontWeight: "700" }}>Выбрать файл и восстановить</Text></Pressable>
      {notice ? <Text accessibilityRole="alert" style={{ color: t.muted }}>{notice}</Text> : null}
    </ScrollView>
  </KeyboardAvoidingView>;
}
