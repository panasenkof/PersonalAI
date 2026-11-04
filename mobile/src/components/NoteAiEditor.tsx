import React, { useEffect, useRef, useState } from "react";
import { ActivityIndicator, Text, TextInput, View } from "react-native";
import { NebulaAction } from "../design/nebula/components";
import { useIsFocused } from "@react-navigation/native";
import { BottomSheet } from "./BottomSheet";
import { VoiceInput } from "./VoiceInput";
import { editNote, type NoteDraft } from "../direct-agent/edit-note";
import { loadDirectSettings } from "../direct-agent/settings";
import { onLocalMemorySessionChange } from "../local-memory/storage";
import { useApplicationVisible } from "../security/visibility";
import { useTheme } from "../theme";
import { nebulaRadii, nebulaSpacing, nebulaTypography } from "../design/nebula/tokens";

export function NoteAiEditor({ profile, draft, allowed, onApply, onClose }: {
  profile: string; draft: NoteDraft; allowed: boolean; onApply: (draft: NoteDraft) => void; onClose: () => void;
}) {
  const t = useTheme(); const visible = useApplicationVisible(); const focused = useIsFocused();
  const [instruction, setInstruction] = useState(""); const [result, setResult] = useState<NoteDraft | null>(null);
  const [busy, setBusy] = useState(false); const [error, setError] = useState(""); const [voice, setVoice] = useState(false);
  const [showOriginal, setShowOriginal] = useState(false);
  const request = useRef<AbortController | null>(null);
  const latest = useRef(draft); latest.current = draft;
  const original = useRef<NoteDraft | null>(null);
  const stop = () => { request.current?.abort(); request.current = null; setBusy(false); };
  useEffect(() => () => request.current?.abort(), []);
  useEffect(() => onLocalMemorySessionChange(unlocked => { if (!unlocked) { stop(); onClose(); } }), [onClose]);
  useEffect(() => { if (!visible || !focused) { stop(); onClose(); } }, [visible, focused, onClose]);
  const run = async () => {
    if (request.current || voice) return;
    const controller = new AbortController(); request.current = controller;
    const snapshot = { ...draft }; original.current = snapshot;
    setBusy(true); setResult(null); setError("");
    try {
      const settings = await loadDirectSettings(profile);
      const edited = await editNote(settings, snapshot, instruction, { allowed, signal: controller.signal });
      if (controller.signal.aborted || request.current !== controller) return;
      if (latest.current.title !== snapshot.title || latest.current.body !== snapshot.body) throw new Error("Заметка изменилась. Повторите запрос для нового текста.");
      setResult(edited);
    } catch (e) { if (!controller.signal.aborted) setError((e as Error).message); }
    finally { if (request.current === controller) { request.current = null; setBusy(false); } }
  };
  return <BottomSheet visible title="Изменить с ИИ" onClose={() => { stop(); onClose(); }}>
    <Text style={{ color: t.muted, ...nebulaTypography.label }}>{allowed
      ? "Команда, заголовок и текст будут переданы выбранной LLM. Файлы не отправляются."
      : "Запись закрыта для модели. Редактирование вручную и диктовка доступны."}</Text>
    <TextInput accessibilityLabel="Команда для редактирования заметки" placeholder="Например: оформи по шагам" placeholderTextColor={t.muted}
      value={instruction} multiline maxLength={2000} editable={!busy && !voice && allowed && !result}
      onChangeText={setInstruction} style={{ minHeight: 72, color: t.text, padding: nebulaSpacing.sm, backgroundColor: t.bg, borderRadius: nebulaRadii.field, ...nebulaTypography.body }} />
    {!result && allowed ? <View style={{ flexDirection: "row", alignItems: "center", gap: nebulaSpacing.sm }}>
      <VoiceInput value={instruction} onChange={setInstruction} maxLength={2000} disabled={busy} onError={setError} onActiveChange={setVoice} />
      <Text style={{ color: t.muted }}>Надиктовать команду</Text>
    </View> : null}
    {error ? <Text accessibilityRole="alert" style={{ color: t.err }}>{error}</Text> : null}
    {busy ? <ActivityIndicator accessibilityLabel="ИИ редактирует заметку" /> : null}
    {result ? <>
      <Text style={{ color: t.muted }}>Предпросмотр · ещё не сохранено</Text>
      <View style={{ alignItems: "flex-start" }}>
        <NebulaAction icon="git-compare" label={showOriginal ? "Показать результат" : "Сравнить с исходным"}
          accessibilityLabel={showOriginal ? "Показать результат" : "Сравнить с исходным"}
          onPress={() => setShowOriginal(v => !v)} />
      </View>
      <Text style={{ color: t.text, ...nebulaTypography.heading }}>{(showOriginal ? original.current : result)?.title}</Text>
      <Text testID="note-ai-preview" selectable style={{ color: t.text, ...nebulaTypography.body }}>{(showOriginal ? original.current : result)?.body}</Text>
      <NebulaAction icon="check" variant="primary" label="Применить к черновику"
        accessibilityLabel="Применить правку ИИ" onPress={() => {
          if (original.current?.title !== latest.current.title || original.current?.body !== latest.current.body) {
            setError("Заметка изменилась. Повторите запрос."); setResult(null); return;
          }
          onApply(result); onClose();
        }} />
      <View style={{ alignItems: "flex-start" }}>
        <NebulaAction icon="edit-3" label="Изменить команду" onPress={() => {
          setResult(null); setShowOriginal(false);
        }} />
      </View>
    </> : !busy ? <NebulaAction icon="sparkles" variant="primary" label="Показать результат"
      accessibilityLabel="Запросить правку ИИ" disabled={!allowed || !instruction.trim() || voice}
      onPress={() => void run()} /> : null}
    <NebulaAction icon="x" label="Отменить" accessibilityLabel="Отменить правку ИИ"
      onPress={() => { stop(); onClose(); }} />
  </BottomSheet>;
}
