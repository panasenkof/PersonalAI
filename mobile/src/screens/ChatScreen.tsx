import type { NativeStackScreenProps } from "@react-navigation/native-stack";
import * as DocumentPicker from "expo-document-picker";
import * as ImagePicker from "expo-image-picker";
import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator, FlatList, KeyboardAvoidingView, Platform, Pressable, StyleSheet, Text, TextInput, View,
} from "react-native";

import { api } from "../api/client";
import { emptyRun, followJob, RunState } from "../api/stream";
import { FactCard } from "../components/FactCard";
import { MessageBubble } from "../components/MessageBubble";
import { ToolChip } from "../components/ToolChip";
import type { RootStackParams } from "../navigation";
import { useTheme } from "../theme";
import type { Attachment, Fact } from "../types";

type Row =
  | { id: string; kind: "msg"; role: "user" | "assistant"; text: string }
  | { id: string; kind: "fact"; fact: Fact }
  | { id: string; kind: "note"; text: string };

let seq = 0;
const uid = () => `r${++seq}`;

export function ChatScreen({ route, navigation }: NativeStackScreenProps<RootStackParams, "Chat">) {
  const t = useTheme();
  const [conversationId, setConversationId] = useState<string | null>(route.params?.conversationId ?? null);
  const [rows, setRows] = useState<Row[]>([]);
  const [text, setText] = useState("");
  const [attachment, setAttachment] = useState<Attachment | null>(null);
  const [uploading, setUploading] = useState(false);
  const [run, setRun] = useState<RunState | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const list = useRef<FlatList<Row>>(null);
  const detach = useRef<(() => void) | null>(null);

  useEffect(() => {
    navigation.setOptions({ title: route.params?.title ?? "Новый чат" });
  }, [navigation, route.params?.title]);

  // history + facts still waiting for a decision
  useEffect(() => {
    let alive = true;
    (async () => {
      const next: Row[] = [];
      if (conversationId) {
        const turns = await api.history(conversationId).catch(() => []);
        turns.forEach((m) => next.push({ id: uid(), kind: "msg", role: m.role, text: m.content }));
      }
      const facts = await api.facts().catch(() => ({ facts: [] }));
      facts.facts.forEach((f) => next.push({ id: uid(), kind: "fact", fact: f }));
      if (alive) setRows((prev) => (prev.length ? prev : next));
    })();
    return () => {
      alive = false;
      detach.current?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const scrollDown = useCallback(() => setTimeout(() => list.current?.scrollToEnd({ animated: true }), 50), []);

  async function pick(kind: "photo" | "camera" | "file") {
    setUploading(true);
    try {
      if (kind === "file") {
        const r = await DocumentPicker.getDocumentAsync({ copyToCacheDirectory: true });
        if (r.canceled) return;
        const f = r.assets[0];
        setAttachment(await api.upload(f.uri, f.name, f.mimeType ?? "application/octet-stream"));
      } else {
        const opts: ImagePicker.ImagePickerOptions = { mediaTypes: ImagePicker.MediaTypeOptions.Images, quality: 0.8 };
        const r = kind === "camera" ? await ImagePicker.launchCameraAsync(opts) : await ImagePicker.launchImageLibraryAsync(opts);
        if (r.canceled) return;
        const a = r.assets[0];
        setAttachment(await api.upload(a.uri, a.fileName ?? "photo.jpg", a.mimeType ?? "image/jpeg"));
      }
    } catch (e) {
      setRows((r) => [...r, { id: uid(), kind: "note", text: `Не удалось загрузить файл: ${(e as Error).message}` }]);
    } finally {
      setUploading(false);
    }
  }

  async function send() {
    const body = text.trim();
    if ((!body && !attachment) || busy) return;
    const files = attachment ? [attachment] : [];
    setText("");
    setAttachment(null);
    setBusy(true);
    setRows((r) => [...r, { id: uid(), kind: "msg", role: "user", text: body || `📎 ${files[0]?.filename ?? "файл"}` }]);
    setRun(emptyRun());
    scrollDown();
    try {
      const res = await api.sendMessage(body, conversationId, files);
      if (res.conversation_id && res.conversation_id !== conversationId) {
        setConversationId(res.conversation_id);
        navigation.setOptions({ title: body.slice(0, 40) || "Чат" });
      }
      if (res.assistant_text || res.status === "completed" || res.status === "awaiting_confirm" || res.status === "failed") {
        // sync mode: the answer is already here
        setRun(null);
        setRows((r) => [
          ...r,
          { id: uid(), kind: "msg", role: "assistant", text: res.error ? `Ошибка: ${res.error}` : res.assistant_text ?? "" },
          ...res.pending_facts.map((f): Row => ({ id: uid(), kind: "fact", fact: f })),
        ]);
      } else {
        setJobId(res.job_id);
        const follow = followJob(res.job_id, setRun);
        detach.current = follow.close;
        const final = await follow.promise;
        setRun(null);
        setRows((r) => {
          const out = [...r];
          if (final.finished === "error") out.push({ id: uid(), kind: "note", text: `Ошибка: ${final.error ?? ""}` });
          else {
            if (final.text.trim()) out.push({ id: uid(), kind: "msg", role: "assistant", text: final.text });
            if (final.finished === "cancelled") out.push({ id: uid(), kind: "note", text: "⏹ Остановлено" });
          }
          final.facts.forEach((f) => out.push({ id: uid(), kind: "fact", fact: f }));
          return out;
        });
      }
    } catch (e) {
      setRun(null);
      const m = String((e as Error).message);
      setRows((r) => [...r, { id: uid(), kind: "note", text: m.includes("rate_limited") ? "Слишком много запросов — подождите минуту" : `Ошибка: ${m}` }]);
    } finally {
      setBusy(false);
      setJobId(null);
      scrollDown();
    }
  }

  async function stop() {
    if (jobId) await api.cancelJob(jobId).catch(() => undefined);
  }

  const data: Row[] = run
    ? [...rows, { id: "live", kind: "msg", role: "assistant", text: run.text }]
    : rows;

  return (
    <KeyboardAvoidingView style={{ flex: 1, backgroundColor: t.bg }} behavior={Platform.OS === "ios" ? "padding" : undefined} keyboardVerticalOffset={90}>
      <FlatList
        ref={list}
        data={data}
        keyExtractor={(r) => r.id}
        contentContainerStyle={{ padding: 12 }}
        onContentSizeChange={scrollDown}
        renderItem={({ item }) => {
          if (item.kind === "fact") return <FactCard fact={item.fact} />;
          if (item.kind === "note") return <Text style={{ color: t.muted, textAlign: "center", marginVertical: 6 }}>{item.text}</Text>;
          if (item.id === "live" && run) {
            return (
              <View>
                {run.steps.map((s) => <ToolChip key={s.key} step={s} />)}
                {run.text || !run.steps.length ? <MessageBubble role="assistant" text={run.text} pending /> : null}
              </View>
            );
          }
          return <MessageBubble role={item.role} text={item.text} />;
        }}
      />
      {attachment ? (
        <View style={[styles.attach, { backgroundColor: t.panel, borderColor: t.line }]}>
          <Text style={{ color: t.text, flex: 1 }} numberOfLines={1}>📎 {attachment.filename}</Text>
          <Pressable onPress={() => setAttachment(null)}><Text style={{ color: t.err }}>✕</Text></Pressable>
        </View>
      ) : null}
      <View style={[styles.composer, { backgroundColor: t.panel, borderColor: t.line }]}>
        {uploading ? (
          <ActivityIndicator style={styles.clip} />
        ) : (
          <>
            <Pressable style={styles.clip} onPress={() => pick("camera")}><Text style={styles.clipText}>📷</Text></Pressable>
            <Pressable style={styles.clip} onPress={() => pick("photo")}><Text style={styles.clipText}>🖼</Text></Pressable>
            <Pressable style={styles.clip} onPress={() => pick("file")}><Text style={styles.clipText}>📎</Text></Pressable>
          </>
        )}
        <TextInput
          style={[styles.input, { color: t.text, borderColor: t.line }]}
          placeholder="Сообщение…"
          placeholderTextColor={t.muted}
          multiline
          value={text}
          onChangeText={setText}
        />
        {busy && jobId ? (
          <Pressable style={[styles.send, { backgroundColor: t.err }]} onPress={stop}><Text style={styles.sendText}>⏹</Text></Pressable>
        ) : (
          <Pressable disabled={busy} style={[styles.send, { backgroundColor: t.accent, opacity: busy ? 0.5 : 1 }]} onPress={send}>
            <Text style={styles.sendText}>➤</Text>
          </Pressable>
        )}
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  composer: { flexDirection: "row", alignItems: "flex-end", gap: 6, padding: 8, borderTopWidth: StyleSheet.hairlineWidth },
  input: { flex: 1, borderWidth: 1, borderRadius: 18, paddingHorizontal: 12, paddingVertical: 8, maxHeight: 120, fontSize: 16 },
  send: { width: 40, height: 40, borderRadius: 20, alignItems: "center", justifyContent: "center" },
  sendText: { color: "#fff", fontSize: 18 },
  clip: { width: 34, height: 40, alignItems: "center", justifyContent: "center" },
  clipText: { fontSize: 20 },
  attach: { flexDirection: "row", padding: 8, marginHorizontal: 8, borderWidth: 1, borderRadius: 10, gap: 8 },
});
