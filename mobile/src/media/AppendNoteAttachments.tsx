import React, { useEffect, useRef, useState } from "react";
import { Pressable, Text, View } from "react-native";
import * as DocumentPicker from "expo-document-picker";
import * as LegacyFileSystem from "expo-file-system/legacy";
import { File } from "expo-file-system";
import { BottomSheet } from "../components/BottomSheet";
import { onLocalMemorySessionChange } from "../local-memory/storage";
import { MemoryConflictError, type EntityRecord } from "../local-memory/types";
import { memoryErrorMessage } from "../local-memory/errors";
import { withNativeInteraction } from "../security/native-interaction";
import { useTheme } from "../theme";
import { nebulaRadii, nebulaSpacing, nebulaTouch } from "../design/nebula/tokens";
import { appendNoteAttachments, MAX_ORIGINALS_PER_NOTE } from "./attachments";
import { readableAttachmentSize } from "./attachmentPresentation";
import type { ImportFile } from "./kinds";

export function AppendNoteAttachments({ profile, note, disabled, onBusyChange, onDraftChange, onSaved }: {
  profile: string; note: EntityRecord; disabled: boolean;
  onBusyChange: (busy: boolean) => void; onDraftChange: (dirty: boolean) => void; onSaved: (note: EntityRecord) => void;
}) {
  const t = useTheme();
  const [files, setFiles] = useState<ImportFile[]>([]);
  const [stage, setStage] = useState<"idle" | "picking" | "saving">("idle");
  const [error, setError] = useState(""); const [notice, setNotice] = useState("");
  const alive = useRef(true), generation = useRef(0), pending = useRef(false);
  const abort = useRef<AbortController | null>(null), owned = useRef<ImportFile[]>([]);
  const callbacks = useRef({ onBusyChange, onDraftChange, onSaved });
  callbacks.current = { onBusyChange, onDraftChange, onSaved };
  function cleanup(items: ImportFile[]) {
    for (const item of items) {
      if (!LegacyFileSystem.cacheDirectory || !item.uri.startsWith(LegacyFileSystem.cacheDirectory)) continue;
      try { const file = new File(item.uri); if (file.exists) file.delete(); } catch { /* Best effort cache cleanup. */ }
    }
  }
  function discard() {
    cleanup(owned.current); owned.current = [];
    if (alive.current) { setFiles([]); setError(""); callbacks.current.onDraftChange(false); }
  }
  useEffect(() => {
    alive.current = true;
    const off = onLocalMemorySessionChange(unlocked => {
      if (unlocked) return;
      generation.current++; abort.current?.abort();
      if (!abort.current) discard();
    });
    return () => { alive.current = false; generation.current++; abort.current?.abort(); cleanup(owned.current); owned.current = []; off(); };
  }, [profile, note.id]);
  async function pick() {
    if (pending.current || disabled || files.length) return;
    const request = generation.current;
    pending.current = true; setStage("picking"); setError(""); setNotice(""); callbacks.current.onBusyChange(true);
    let chosen: ImportFile[] = [];
    try {
      await withNativeInteraction(async () => {
        const result = await DocumentPicker.getDocumentAsync({ type: ["image/*", "audio/*", "video/*", "text/*", "application/json", "application/pdf"], copyToCacheDirectory: true, multiple: true });
        if (!result.canceled) chosen = result.assets.filter((item, index, all) => all.findIndex(other => other.uri === item.uri) === index).map(item => ({ uri: item.uri, name: item.name, mimeType: item.mimeType, size: item.size }));
      });
      if (!alive.current || request !== generation.current) { cleanup(chosen); return; }
      if (chosen.length > MAX_ORIGINALS_PER_NOTE) throw new Error("Не более 10 вложений в одной заметке.");
      owned.current = chosen; setFiles(chosen); callbacks.current.onDraftChange(chosen.length > 0);
    } catch (e) { cleanup(chosen); if (alive.current && request === generation.current) setError(memoryErrorMessage(e)); }
    finally { pending.current = false; if (alive.current) { setStage("idle"); callbacks.current.onBusyChange(false); } }
  }
  async function save() {
    if (pending.current || !files.length || disabled) return;
    const request = generation.current;
    pending.current = true; setStage("saving"); setError(""); callbacks.current.onBusyChange(true);
    const controller = new AbortController(); abort.current = controller;
    try {
      const updated = await appendNoteAttachments(profile, note.id, note.record_version, files, controller.signal);
      if (alive.current && request === generation.current) {
        callbacks.current.onSaved(updated); setNotice(`Добавлено файлов: ${files.length}`); discard();
      }
    } catch (e) {
      if (controller.signal.aborted) discard();
      else if (alive.current && request === generation.current) setError(e instanceof MemoryConflictError ? "Запись изменилась. Закройте добавление и откройте запись заново; файлы не добавлены." : memoryErrorMessage(e));
    } finally {
      if (request !== generation.current) discard();
      abort.current = null; pending.current = false;
      if (alive.current) { setStage("idle"); callbacks.current.onBusyChange(false); }
    }
  }
  const cancel = () => { if (abort.current) abort.current.abort(); else discard(); };
  const button = { minHeight: nebulaTouch.minimum, borderRadius: nebulaRadii.field, padding: nebulaSpacing.sm, justifyContent: "center" as const };
  return <View style={{ gap: nebulaSpacing.xs }}>
    <Pressable accessibilityRole="button" accessibilityLabel="Добавить файлы к заметке" accessibilityState={{ disabled: disabled || stage !== "idle" }} disabled={disabled || stage !== "idle"} onPress={() => void pick()} style={{ ...button, backgroundColor: t.soft, opacity: disabled ? .5 : 1 }}><Text style={{ color: t.secondary }}>{stage === "picking" ? "Выбираю файлы…" : "Добавить файлы"}</Text></Pressable>
    {disabled && stage === "idle" ? <Text style={{ color: t.muted }}>Сначала сохраните изменения и завершите диктовку.</Text> : null}
    {notice ? <Text accessibilityLiveRegion="polite" style={{ color: t.secondary }}>{notice}</Text> : null}
    {!files.length && error ? <Text accessibilityRole="alert" style={{ color: t.err }}>{error}</Text> : null}
    <BottomSheet visible={files.length > 0} title="Добавить вложения" onClose={cancel}>
      <Text style={{ color: t.text }}>В заметку «{note.title || "Без названия"}»</Text>
      <Text style={{ color: t.muted }}>До 10 файлов и 80 МБ вместе с сохранёнными. Оригиналы останутся на телефоне; распознавание и отправка модели не запускаются.</Text>
      {files.map((item, index) => <View key={item.uri} style={{ flexDirection: "row", alignItems: "center", gap: nebulaSpacing.sm }}>
        <Text style={{ flex: 1, color: t.text }}>{item.name}{item.size ? ` · ${readableAttachmentSize(item.size)}` : ""}</Text>
        <Pressable accessibilityRole="button" accessibilityLabel={"Убрать из добавления " + item.name} disabled={stage === "saving"} style={button} onPress={() => {
          cleanup([item]); const next = files.filter((_, i) => i !== index); owned.current = next; setFiles(next); callbacks.current.onDraftChange(next.length > 0);
        }}><Text style={{ color: t.secondary }}>Убрать</Text></Pressable>
      </View>)}
      {error ? <Text accessibilityRole="alert" style={{ color: t.err }}>{error}</Text> : null}
      <Pressable accessibilityRole="button" accessibilityLabel="Сохранить новые вложения" disabled={stage === "saving" || disabled} onPress={() => void save()} style={{ ...button, backgroundColor: t.accent }}><Text style={{ color: t.userText }}>{stage === "saving" ? "Сохраняю файлы…" : `Добавить файлы (${files.length})`}</Text></Pressable>
      <Pressable accessibilityRole="button" accessibilityLabel="Отменить добавление файлов" onPress={cancel} style={button}><Text style={{ color: t.secondary }}>{stage === "saving" ? "Остановить добавление" : "Отмена"}</Text></Pressable>
    </BottomSheet>
  </View>;
}
