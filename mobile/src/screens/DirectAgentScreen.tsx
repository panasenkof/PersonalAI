import { useFocusEffect, useNavigation } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import type { RootStackParams } from "../navigation";
import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator, AppState, FlatList, KeyboardAvoidingView, Linking,
  Platform, Pressable, Text, TextInput, View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { useAuth } from "../auth/AuthContext";
import { runDirectAgent } from "../direct-agent/engine";
import type { AgentTurn } from "../direct-agent/engine";
import { searchApprovedNotes, saveApprovedNote } from "../direct-agent/memory";
import type { NoteProposal } from "../direct-agent/memory";
import { loadDirectSettings } from "../direct-agent/settings";
import type { DirectAgentSettings } from "../direct-agent/settings";
import { closeLocalMemory } from "../local-memory/storage";
import { useTheme } from "../theme";

type Bubble = { id: number; role: "user" | "assistant" | "info"; text: string; sources?: string[] };
type Draft = NoteProposal & { id: number; saving?: boolean };
let idCounter = 0;
const uid = () => ++idCounter;

export function DirectAgentScreen() {
  const { offlineMode, me } = useAuth();
  const profile = offlineMode ? "guest" : me?.id;
  const t = useTheme();
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParams>>();
  const insets = useSafeAreaInsets();
  const [settings, setSettings] = useState<DirectAgentSettings | null>(null);
  const [rows, setRows] = useState<Bubble[]>([]);
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [question, setQuestion] = useState("");
  const [progress, setProgress] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const controller = useRef<AbortController | null>(null);
  const mounted = useRef(true);
  const list = useRef<FlatList<Bubble>>(null);

  useEffect(() => {
    const sub = AppState.addEventListener("change", state => {
      if (state !== "active") {
        controller.current?.abort();
        // Never leave sensitive answers visible in Android/iOS recent-app previews.
        setRows([]);
        setDrafts([]);
        setQuestion("");
        void closeLocalMemory();
      }
    });
    return () => { mounted.current = false; controller.current?.abort(); sub.remove(); };
  }, []);

  useEffect(() => {
    // A guest/server profile switch must never expose another profile's chat.
    controller.current?.abort();
    setRows([]);
    setDrafts([]);
    setQuestion("");
  }, [profile]);

  useFocusEffect(useCallback(() => {
    let alive = true;
    setSettings(null);
    setError("");
    if (profile) {
      void loadDirectSettings(profile).then(value => {
        if (alive) setSettings(value);
      }).catch(() => { if (alive) setError("Не удалось прочитать защищённые настройки"); });
    }
    return () => {
      alive = false;
      controller.current?.abort();
      void closeLocalMemory();
    };
  }, [profile]));

  async function send() {
    if (busy || !profile || !settings || !question.trim()) return;
    const text = question.trim();
    setQuestion("");
    setError("");
    setProgress("");
    setBusy(true);
    const turn: Bubble = { id: uid(), role: "user", text };
    const history: AgentTurn[] = rows.filter(x => x.role !== "info").slice(-8)
      .map(x => ({ role: x.role as "user" | "assistant", content: x.text }));
    setRows(prev => [...prev, turn]);
    const aborter = new AbortController();
    controller.current = aborter;
    try {
      const result = await runDirectAgent({
        settings, prompt: text, history, signal: aborter.signal,
        lookup: query => searchApprovedNotes(profile, query, settings.allowMemory),
        propose: note => {
          if (mounted.current && !aborter.signal.aborted) {
            setDrafts(previous => [...previous, { ...note, id: uid() }]);
          }
        },
        status: message => { if (mounted.current && !aborter.signal.aborted) setProgress(message); },
      });
      if (!mounted.current || aborter.signal.aborted) return;
      setRows(prev => [...prev, {
        id: uid(), role: "assistant", text: result.text, sources: result.sources,
      }]);
    } catch (e) {
      if (mounted.current) {
        const message = aborter.signal.aborted ? "Запрос остановлен" : String((e as Error).message);
        setRows(prev => [...prev, { id: uid(), role: "info", text: message }]);
      }
    } finally {
      if (mounted.current) {
        setBusy(false);
        setProgress("");
      }
      if (controller.current === aborter) controller.current = null;
    }
  }

  async function approve(draft: Draft) {
    if (!profile || draft.saving || AppState.currentState !== "active") return;
    setDrafts(prev => prev.map(d => d.id === draft.id ? { ...d, saving: true } : d));
    try {
      await saveApprovedNote(profile, draft);
      if (!mounted.current) return;
      setDrafts(prev => prev.filter(d => d.id !== draft.id));
      setRows(prev => [...prev, { id: uid(), role: "info", text: "Заметка сохранена в памяти телефона." }]);
    } catch (e) {
      if (mounted.current) {
        setError("Не удалось сохранить заметку: " + String((e as Error).message));
        setDrafts(prev => prev.map(d => d.id === draft.id ? { ...d, saving: false } : d));
      }
    }
  }

  const action = { minHeight: 44, justifyContent: "center" as const, paddingHorizontal: 12 };
  return (
    <KeyboardAvoidingView style={{ flex: 1, backgroundColor: t.bg }}
      behavior={Platform.OS === "ios" ? "padding" : undefined}>
      <View style={{ padding: 12, backgroundColor: t.panel, borderBottomWidth: 1, borderColor: t.line }}>
        <View style={{ flexDirection: "row", justifyContent: "space-between", alignItems: "center" }}>
          <Text style={{ color: t.text, fontSize: 18, fontWeight: "700" }}>PersAI · Ассистент</Text>
          <Pressable accessibilityRole="button" accessibilityLabel="Настроить подключение ИИ"
            onPress={() => navigation.navigate("DirectAgentSettings")}
            style={{ paddingVertical: 8, paddingHorizontal: 12, borderRadius: 10, backgroundColor: t.bg }}>
            <Text style={{ color: t.accent, fontWeight: "600" }}>Настроить</Text>
          </Pressable>
        </View>
        <Text style={{ color: t.muted, fontSize: 12 }}>
          {settings?.provider === "anthropic" ? "Anthropic Messages" : settings?.provider === "openai-compatible" ? "OpenAI Chat Completions" : "OpenAI Responses"} · веб: {settings?.allowWeb ? "вкл." : "выкл."} · память: {settings?.allowMemory ? "разрешена" : "закрыта"}
        </Text>
        {!settings?.apiKey && <Text style={{ color: t.err, marginTop: 5 }}>
          Добавьте API-ключ и модель в «Настроить».
        </Text>}
      </View>
      <FlatList
        ref={list}
        data={rows}
        keyExtractor={item => String(item.id)}
        onContentSizeChange={() => list.current?.scrollToEnd({ animated: true })}
        contentContainerStyle={{ padding: 12, gap: 10 }}
        ListEmptyComponent={
          <Text style={{ color: t.muted, textAlign: "center", marginTop: 24 }}>
            Задайте вопрос, попросите найти информацию в интернете или вспомнить заметку.
            Для чтения памяти требуется отдельное разрешение в настройках.
            Диалог хранится только пока открыт этот экран.
          </Text>
        }
        renderItem={({ item }) => (
          <View style={{
            backgroundColor: item.role === "user" ? t.userBubble : t.panel,
            borderRadius: 12, padding: 12, alignSelf: item.role === "user" ? "flex-end" : "stretch",
          }}>
            <Text selectable style={{ color: item.role === "user" ? t.userText : t.text }}>{item.text}</Text>
            {item.sources?.length ? <View style={{ marginTop: 10, gap: 4 }}>
              <Text style={{ color: t.muted, fontWeight: "600" }}>Источники:</Text>
              {item.sources.map(url => (
                <Pressable key={url} accessibilityRole="link" onPress={() => void Linking.openURL(url)}>
                  <Text style={{ color: t.accent, textDecorationLine: "underline" }} numberOfLines={2}>{url}</Text>
                </Pressable>
              ))}
            </View> : null}
          </View>
        )}
        ListFooterComponent={<View style={{ gap: 8 }}>
          {drafts.map(d => (
            <View key={d.id} style={{ padding: 12, borderWidth: 1, borderColor: t.accent, borderRadius: 10, backgroundColor: t.panel, gap: 6 }}>
              <Text style={{ color: t.text, fontWeight: "700" }}>ИИ предлагает запомнить (не сохранено)</Text>
              <Text style={{ color: t.muted, fontSize: 12 }}>Это обычная заметка; при разрешённом чтении памяти она может передаваться внешней LLM.</Text>
              <Text selectable style={{ color: t.text }}>{d.title}</Text>
              <Text selectable style={{ color: t.text }}>{d.body}</Text>
              <View style={{ flexDirection: "row", gap: 20 }}>
                <Pressable accessibilityRole="button" disabled={d.saving} style={action} onPress={() => void approve(d)}>
                  <Text style={{ color: t.accent }}>{d.saving ? "Сохранение…" : "Сохранить"}</Text>
                </Pressable>
                <Pressable accessibilityRole="button" style={action} onPress={() => setDrafts(prev => prev.filter(x => x.id !== d.id))}>
                  <Text style={{ color: t.err }}>Отклонить</Text>
                </Pressable>
              </View>
            </View>
          ))}
          {progress ? <Text style={{ color: t.muted }}>{progress}</Text> : null}
          {busy ? <ActivityIndicator /> : null}
        </View>}
      />
      {error ? <Text accessibilityRole="alert" style={{ color: t.err, marginHorizontal: 12 }}>{error}</Text> : null}
      <View style={{ flexDirection: "row", padding: 8, paddingBottom: Math.max(insets.bottom, 8),
        borderTopWidth: 1, borderColor: t.line, backgroundColor: t.panel, alignItems: "flex-end", gap: 6 }}>
        <TextInput
          accessibilityLabel="Сообщение локальному агенту"
          placeholder="Спросить у ИИ…"
          placeholderTextColor={t.muted}
          editable={!busy}
          multiline
          value={question}
          onChangeText={setQuestion}
          style={{ flex: 1, borderWidth: 1, borderColor: t.line, borderRadius: 15, padding: 10,
            maxHeight: 120, minHeight: 44, color: t.text }}
        />
        {busy ? <Pressable accessibilityRole="button" accessibilityLabel="Остановить запрос"
          style={action} onPress={() => controller.current?.abort()}>
          <Text style={{ color: t.err }}>Стоп</Text>
        </Pressable> : <Pressable accessibilityRole="button" accessibilityLabel="Отправить запрос"
          disabled={!settings?.apiKey || !question.trim()}
          style={action} onPress={() => void send()}>
          <Text style={{ color: settings?.apiKey && question.trim() ? t.accent : t.muted }}>Отправить</Text>
        </Pressable>}
      </View>
    </KeyboardAvoidingView>
  );
}
