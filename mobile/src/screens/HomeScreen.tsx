import Feather from "@expo/vector-icons/Feather";
import { useFocusEffect, useNavigation } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import React, { useCallback, useRef, useState } from "react";
import { ActivityIndicator, Alert, FlatList, KeyboardAvoidingView, Linking, Platform, Pressable, Text, TextInput, View } from "react-native";
import { useProfile } from "../profile/ProfileContext";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useDirectChat } from "../direct-agent/ChatContext";
import { PROVIDER_PRESETS, anonymousLocalAllowed, loadDirectConnections } from "../direct-agent/settings";
import type { DirectAgentSettings } from "../direct-agent/settings";
import type { ChatRow } from "../direct-agent/conversations";
import type { RootStackParams } from "../navigation";
import { BottomSheet } from "../components/BottomSheet";
import { FloatingBrand } from "../components/FloatingBrand";
import { VoiceInput } from "../components/VoiceInput";
import { IconAction } from "../components/IconAction";
import { useTheme } from "../theme";

export function HomeScreen() {
  const t = useTheme();
  const insets = useSafeAreaInsets();
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParams>>();
  const profile = useProfile();
  const { store, ready, error, notice: historyNotice, conversations, active } = useDirectChat();
  const [settings, setSettings] = useState<DirectAgentSettings | null>(null);
  const [connectionName, setConnectionName] = useState("");
  const [notice, setNotice] = useState("");
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historySearch, setHistorySearch] = useState("");
  const list = useRef<FlatList<ChatRow>>(null);
  useFocusEffect(useCallback(() => {
    let alive = true;
    setSettings(null); setConnectionName("");
    if (profile) void loadDirectConnections(profile).then(value => {
      if (!alive) return;
      const connection = value.connections.find(c => c.id === value.activeId)!;
      setSettings(connection); setConnectionName(connection.name); setNotice("");
    }).catch(() => { if (alive) { setSettings(null); setNotice("Не удалось прочитать подключения. Откройте настройки."); } });
    // Changing focus does not own or abort an agent request.
    return () => { alive = false; };
  }, [profile]));
  const canSend = Boolean(ready && !active?.deleting && settings && (settings.apiKey || anonymousLocalAllowed(settings)));
  const question = active?.question || "";
  const busy = active?.busy || false;
  const action = { minHeight: 44, minWidth: 44, justifyContent: "center" as const, alignItems: "center" as const };
  const openConnections = (presetId?: string) => navigation.navigate("ModelConnections", presetId ? { presetId } : undefined);
  // First run: the active connection has neither a key nor a keyless local address.
  const needsSetup = Boolean(settings && !settings.apiKey && !anonymousLocalAllowed(settings));
  return <KeyboardAvoidingView style={{ flex: 1, paddingTop: insets.top, paddingLeft: insets.left, paddingRight: insets.right, backgroundColor: t.bg }} behavior={Platform.OS === "ios" ? "padding" : "height"}>
    <View style={{ backgroundColor: t.panel, borderBottomWidth: 1, borderColor: t.line, paddingHorizontal: 16, paddingTop: 6, paddingBottom: 10, gap: 2 }}>
      <View style={{ flexDirection: "row", gap: 8, alignItems: "center" }}>
        <Text style={{ flex: 1, color: t.text, fontSize: 25, fontWeight: "800" }}>Pers<Text style={{ color: t.accent }}>AI</Text></Text>
        <IconAction icon="clock" label="История" accessibilityLabel="История диалогов" hint="Открыть сохранённые диалоги и найти прошлые сообщения." onPress={() => setHistoryOpen(true)} />
        <IconAction icon="edit" label="Новый чат" accessibilityLabel="Новый диалог" hint="Начать пустой диалог. Предыдущие диалоги останутся в истории." disabled={!ready} onPress={() => store.create()} />
      </View>
      <Pressable accessibilityRole="button" accessibilityLabel="Выбрать модель и подключение" onPress={() => openConnections()} style={{ minHeight: 44, justifyContent: "center", gap: 4 }}>
        <Text numberOfLines={1} style={{ color: t.muted, fontSize: 13 }}>{connectionName || "Выбрать модель"} · {settings?.model || "Подключение не настроено"} ▾</Text>
        <Text style={{ color: t.muted, fontSize: 11 }}>Интернет {settings?.allowWeb ? "включён" : "выключен"} · Диалоги сохраняются на телефоне</Text>
      </Pressable>
    </View>
    {!ready ? <View style={{ padding: 20, gap: 12 }}>{!error ? <ActivityIndicator accessibilityLabel="Загрузка диалогов" /> : null}
      {error ? <Pressable accessibilityRole="button" onPress={() => void store.initialize()} style={action}><Text style={{ color: t.accent }}>Повторить загрузку</Text></Pressable> : null}</View> : null}
    <FlatList ref={list} data={active?.rows || []} keyExtractor={item => item.id}
      keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag"
      onContentSizeChange={() => list.current?.scrollToEnd({ animated: true })}
      contentContainerStyle={{ padding: 16, gap: 12, flexGrow: 1 }}
      ListEmptyComponent={ready && needsSetup ? <View style={{ flex: 1, justifyContent: "center", gap: 14, paddingVertical: 12 }}>
        <View style={{ alignItems: "center", gap: 10 }}><FloatingBrand size={104} />
          <Text style={{ color: t.text, fontSize: 26, fontWeight: "800", textAlign: "center" }}>Подключите модель</Text>
          <Text style={{ color: t.muted, lineHeight: 21, textAlign: "center", maxWidth: 340 }}>PersAI работает с моделью, которую выбираете вы. Память и диалоги остаются на телефоне.</Text></View>
        <View style={{ backgroundColor: t.panel, borderWidth: 1, borderColor: t.line, borderRadius: 18, padding: 16, gap: 6 }}>
          {["1. Выберите сервис", "2. Вставьте ключ API", "3. Нажмите «Проверить связь» и сохраните", "4. Задайте первый вопрос"].map(step =>
            <Text key={step} style={{ color: t.text, lineHeight: 22 }}>{step}</Text>)}
        </View>
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 10 }}>
          {PROVIDER_PRESETS.slice(0, 4).map(p => <Pressable key={p.id} accessibilityRole="button" accessibilityLabel={"Начать с " + p.name}
            style={{ flexBasis: "45%", flexGrow: 1, minHeight: 56, justifyContent: "center", backgroundColor: t.panel, borderWidth: 1, borderColor: t.accent, borderRadius: 16, padding: 12 }}
            onPress={() => openConnections(p.id)}><Text style={{ color: t.accent, fontWeight: "700" }}>{p.name}</Text></Pressable>)}
        </View>
        <Pressable accessibilityRole="button" onPress={() => openConnections()} style={{ minHeight: 44, justifyContent: "center", alignItems: "center" }}>
          <Text style={{ color: t.accent }}>Другие варианты, включая OpenAI и Anthropic →</Text></Pressable>
      </View> : ready ? <View style={{ flex: 1, justifyContent: "center", alignItems: "center", gap: 12, paddingVertical: 12 }}>
        <FloatingBrand size={124} />
        <Text style={{ color: t.text, fontSize: 28, fontWeight: "800", textAlign: "center" }}>Чем помочь сегодня?</Text>
        <Text style={{ color: t.muted, lineHeight: 21, textAlign: "center", maxWidth: 340 }}>Обсуждайте идеи, возвращайтесь к своим знаниям и сохраняйте важное.</Text>
        <View style={{ flexDirection: "row", flexWrap: "wrap", width: "100%", gap: 10, marginTop: 6 }}>
          {[
            { label: "Составить план", icon: "calendar" as const, prompt: "Помоги составить план на неделю" },
            { label: "Написать текст", icon: "edit-3" as const, prompt: "Помоги написать текст" },
            { label: "Объяснить идею", icon: "sun" as const, prompt: "Объясни сложную идею простыми словами" },
            { label: "Вспомнить важное", icon: "bookmark" as const, prompt: "Что ты помнишь обо мне?" },
          ].map(item => <Pressable key={item.label} accessibilityRole="button" accessibilityLabel={item.label}
            style={{ flexBasis: "45%", flexGrow: 1, minHeight: 78, backgroundColor: t.panel, borderWidth: 1, borderColor: t.line, borderRadius: 18, padding: 14, gap: 8 }} onPress={() => store.setQuestion(item.prompt)}>
            <Feather name={item.icon} size={20} color={t.accent} /><Text style={{ color: t.text, fontWeight: "600" }}>{item.label}</Text>
          </Pressable>)}
        </View>
      </View> : null}
      renderItem={({ item }) => <View style={{ alignSelf: item.role === "user" ? "flex-end" : "stretch", backgroundColor: item.role === "user" ? t.userBubble : item.role === "info" ? t.soft : t.panel,
        borderWidth: item.role === "assistant" ? 1 : 0, borderColor: t.line, borderRadius: 20, padding: 15, gap: 10 }}>
        <Text selectable style={{ color: item.role === "user" ? t.userText : item.role === "info" ? t.muted : t.text, lineHeight: 23 }}>{item.text}</Text>
        {item.sources?.length ? <View style={{ gap: 4 }}><Text style={{ color: t.muted, fontSize: 12 }}>Источники</Text>{item.sources.map(url => <Pressable key={url} accessibilityRole="link" onPress={() => void Linking.openURL(url).catch(() => setNotice("Не удалось открыть ссылку."))} style={{ minHeight: 44, justifyContent: "center" }}>
          <Text numberOfLines={2} style={{ color: t.accent, textDecorationLine: "underline" }}>{url}</Text>
        </Pressable>)}</View> : null}
      </View>}
      ListFooterComponent={<View style={{ gap: 10 }}>
        {active?.drafts.map(d => <View key={d.id} style={{ backgroundColor: t.panel, borderWidth: 1, borderColor: t.accent, borderRadius: 20, padding: 16, gap: 8 }}>
          <Text style={{ color: t.accent, fontWeight: "700" }}>Запомнить?</Text><Text selectable style={{ color: t.text, fontWeight: "700" }}>{d.title}</Text><Text selectable style={{ color: t.text }}>{d.body}</Text>
          <View style={{ flexDirection: "row", gap: 20 }}><Pressable accessibilityRole="button" disabled={Boolean(active.savingDraft)} onPress={() => void store.approve(d)} style={action}><Text style={{ color: t.accent }}>{active.savingDraft === d.id ? "Сохранение…" : "Сохранить"}</Text></Pressable>
            <Pressable accessibilityRole="button" disabled={Boolean(active.savingDraft)} onPress={() => store.dismiss(d)} style={action}><Text style={{ color: t.muted }}>Отклонить</Text></Pressable></View>
        </View>)}
        {busy ? <View style={{ flexDirection: "row", alignItems: "center", gap: 10, padding: 8 }}><ActivityIndicator /><Text style={{ flex: 1, color: t.muted }}>{active?.progress || "Готовлю ответ…"}</Text></View> : null}
      </View>}
    />
    {error || notice || historyNotice ? <View style={{ paddingHorizontal: 16, paddingVertical: 6 }}><Text accessibilityRole="alert" style={{ color: error || notice ? t.err : t.muted }}>{error || notice || historyNotice}</Text>
      {error && ready ? <Pressable accessibilityRole="button" onPress={() => void store.checkpoint().catch(() => {})} style={{ minHeight: 44, justifyContent: "center" }}><Text style={{ color: t.accent }}>Повторить сохранение истории</Text></Pressable> : null}</View> : null}
    {!canSend && ready && !(needsSetup && !active?.rows.length) ? <Pressable accessibilityRole="button" onPress={() => openConnections()} style={{ paddingHorizontal: 16, minHeight: 44, justifyContent: "center" }}><Text style={{ color: t.accent }}>Добавьте модель в настройках подключений →</Text></Pressable> : null}
    <View style={{ padding: 10, gap: 5, backgroundColor: t.panel, borderTopWidth: 1, borderColor: t.line }}>
      <TextInput accessibilityLabel="Сообщение ассистенту" multiline value={question} onChangeText={value => store.setQuestion(value)}
        placeholder="Спросить у ИИ…" placeholderTextColor={t.muted} editable={ready}
        style={{ minHeight: 46, maxHeight: 112, borderWidth: 1, borderColor: t.line, borderRadius: 18, backgroundColor: t.soft, padding: 12, color: t.text, fontSize: 16 }} />
      <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
        <IconAction icon="plus" label="Файл" accessibilityLabel="Добавить сведения из файла" hint="Добавить в память сведения из текста, фото, аудио или видео." hintAbove hintAlign="start" onPress={() => navigation.navigate("MemoryImport")} />
        <VoiceInput value={question} onChange={value => store.setQuestion(value)} disabled={!ready} onError={setNotice} showLabel />
        <Text style={{ flex: 1, color: t.muted, fontSize: 11 }} numberOfLines={1}>{busy ? "Можно перейти в другую вкладку" : ""}</Text>
        <IconAction icon={busy ? "square" : "arrow-up"} label={busy ? "Стоп" : "Отправить"} accessibilityLabel={busy ? "Остановить запрос" : "Отправить запрос"}
          hint={busy ? "Остановить ответ ИИ в этом диалоге." : "Отправить написанное сообщение выбранной модели."} hintAbove emphasized={!busy}
          disabled={!busy && (!canSend || !question.trim())} onPress={() => busy ? store.stop() : settings && void store.send(settings)} />
      </View>
    </View>
    <BottomSheet visible={historyOpen} title="Мои диалоги" onClose={() => setHistoryOpen(false)}>
      <Text style={{ color: t.muted }}>Здесь сохранены ваши диалоги. Нажмите на название, чтобы продолжить разговор.</Text>
      <TextInput accessibilityLabel="Поиск диалогов" value={historySearch} onChangeText={setHistorySearch} placeholder="Найти диалог" placeholderTextColor={t.muted} style={{ borderWidth: 1, borderColor: t.line, borderRadius: 16, minHeight: 48, padding: 12, color: t.text }} />
      {conversations.filter(c => (c.title + c.rows.map(r => r.text).join(" ")).toLowerCase().includes(historySearch.toLowerCase())).map(c => <View key={c.id} style={{ flexDirection: "row", gap: 6, alignItems: "center" }}>
        <Pressable accessibilityRole="button" accessibilityLabel={"Открыть диалог " + c.title} accessibilityState={{ selected: c.id === active?.id }} onPress={() => { store.select(c.id); setHistoryOpen(false); }} style={{ flex: 1, minHeight: 64, borderWidth: 1, borderColor: c.id === active?.id ? t.accent : t.line, borderRadius: 16, padding: 14, gap: 5 }}>
          <Text numberOfLines={1} style={{ color: t.text, fontWeight: "700" }}>{c.title}</Text><Text style={{ color: t.muted, fontSize: 12 }}>{c.busy ? "Готовлю ответ…" : new Date(c.updatedAt).toLocaleDateString()}</Text>
        </Pressable>
        <Pressable accessibilityRole="button" accessibilityLabel={"Удалить диалог " + c.title} disabled={c.busy || Boolean(c.savingDraft) || c.deleting} style={action} onPress={() => Alert.alert("Удалить диалог?", c.title, [{ text: "Отмена", style: "cancel" }, { text: "Удалить", style: "destructive", onPress: () => void store.remove(c.id) }])}><Feather name="trash-2" size={19} color={c.busy ? t.muted : t.err} /></Pressable>
      </View>)}
      <Pressable accessibilityRole="button" style={action} onPress={() => { store.create(); setHistoryOpen(false); }}><Text style={{ color: t.accent, fontWeight: "700" }}>+ Новый диалог</Text></Pressable>
    </BottomSheet>
  </KeyboardAvoidingView>;
}
