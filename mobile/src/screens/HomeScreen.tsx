import { ChatAttachmentList } from "../media/ChatAttachmentList";
import { useChatAttachments } from "../media/useChatAttachments";
import { capturePhotoForSearch83 } from "../media/vision-chat-camera";
import { localPhotoIntent83 } from "../media/vision-chat-search";
import { MemoryCover } from "../media/MemoryCover";
import { memoryErrorMessage } from "../local-memory/errors";
import { onLocalMemorySessionChange } from "../local-memory/storage";
import { useFocusEffect, useIsFocused, useNavigation } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { StatusBar } from "expo-status-bar";
import { ActivityIndicator, Alert, FlatList, Keyboard, KeyboardAvoidingView, Linking, Platform, Pressable, Text, useWindowDimensions, View } from "react-native";
import { useProfile } from "../profile/ProfileContext";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useDirectChat } from "../direct-agent/ChatContext";
import { PROVIDER_PRESETS, anonymousLocalAllowed, loadDirectConnections } from "../direct-agent/settings";
import type { DirectAgentSettings } from "../direct-agent/settings";
import type { RootStackParams } from "../navigation";
import { NebulaHomeHeader } from "../design/nebula/NebulaHomeHeader";
import { ConversationHistorySheet } from "../design/nebula/ConversationHistorySheet";
import { NebulaHomeArtwork } from "../design/nebula/NebulaHomeArtwork";
import { nebulaEmptyOrbSize } from "../design/nebula/homeArtLayout";
import { resolveNebulaHomePhase, resolveNebulaStatus, type NebulaVoicePhase } from "../design/nebula/homePhase";
import type { CellRendererProps } from "react-native";
import { presentChatRows, type PresentedChatRow } from "../design/nebula/chatPresentation";
import { nebulaSpacing, nebulaTouch } from "../design/nebula/tokens";
import { useChatBottomFollow } from "../design/nebula/useChatBottomFollow";
import { VoiceInput } from "../components/VoiceInput";
import { IconAction } from "../components/IconAction";
import { PromptInput } from "../components/PromptInput";
import { NebulaHomeThemeProvider, useTheme } from "../theme";
import { MarkdownText } from "../components/Markdown";
import { KIND_NAMES } from "../direct-agent/fact-tool";
import { useDraftNormalization } from "../direct-agent/use-draft-normalization";

export function HomeScreen() {
  return <NebulaHomeThemeProvider><NebulaHomeContent /></NebulaHomeThemeProvider>;
}

function NebulaHomeContent() {
  const t = useTheme();
  const isFocused = useIsFocused();
  const { width, height } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParams>>();
  const profile = useProfile();
  const { store, ready, error, notice: historyNotice, conversations, active, sections } = useDirectChat();
  const [settings, setSettings] = useState<DirectAgentSettings | null>(null);
  const [notice, setNotice] = useState("");
  const [cameraBusy,setCameraBusy] = useState(false);
  const cameraController = useRef<AbortController|null>(null);
  useEffect(() => {
    const off=onLocalMemorySessionChange(unlocked => {
      if(!unlocked)cameraController.current?.abort();
    });
    return () => {cameraController.current?.abort();off();};
  },[profile]);
  const {picking: pickingAttachment, pick: pickAttachment} = useChatAttachments(store, active?.id, isFocused, setNotice);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [voiceReset, setVoiceReset] = useState(0);
  const [dictating, setDictating] = useState(false);
  const [voicePhase, setVoicePhase] = useState<NebulaVoicePhase>("idle");
  const [composerFocused, setComposerFocused] = useState(false);
  const [keyboardOpen, setKeyboardOpen] = useState(false);
  const [listViewportHeight, setListViewportHeight] = useState(0);
  const rows = useMemo(() => presentChatRows(active?.rows || [], Boolean(active?.busy), active?.streamText),
    [active?.rows, active?.busy, active?.streamText]);
  const turnId = [...(active?.rows || [])].reverse().find(row => row.role === "user")?.id;
  const viewport = useChatBottomFollow(active?.id, isFocused, turnId, rows.length > 0);
  const { onCell } = viewport;
  // Measure the cell in list coordinates, not the inner bubble's local y=0.
  // Stable component identity is essential: recreating this on tokens remounts cells.
  const ChatCell = useCallback(({ item, onLayout, children, style, onFocusCapture }: CellRendererProps<PresentedChatRow>) =>
    <View {...{ style, onFocusCapture }} onLayout={event => {
      onLayout?.(event);
      onCell(item.id, event.nativeEvent.layout.y, event.nativeEvent.layout.height);
    }}>{children}</View>, [onCell]);
  useEffect(() => {
    // Browser QA / React Native Web may omit the native Keyboard module.
    // Native Android still reports keyboardDidShow/Hide; focus is the fallback.
    if (!isFocused) {
      setKeyboardOpen(false);
      setComposerFocused(false);
      return;
    }
    if (!Keyboard?.addListener) return;
    const shown = Keyboard.addListener("keyboardDidShow", () => setKeyboardOpen(true));
    const hidden = Keyboard.addListener("keyboardDidHide", () => {
      setKeyboardOpen(false);
      // Android can keep the TextInput focused after Back dismisses Gboard.
      setComposerFocused(false);
    });
    return () => { shown.remove(); hidden.remove(); };
  }, [isFocused]);
  const normalization = useDraftNormalization(store, profile, setNotice);
  useFocusEffect(useCallback(() => {
    let alive = true;
    setSettings(null);
    if (profile) void loadDirectConnections(profile).then(value => {
      if (!alive) return;
      const connection = value.connections.find(c => c.id === value.activeId)!;
      setSettings(connection); setNotice("");
    }).catch(() => { if (alive) { setSettings(null); setNotice("Не удалось прочитать подключения. Откройте настройки."); } });
    // A section created in the memory screen shows up in proposals right away.
    void store.refreshSections();
    // Changing focus does not own or abort an agent request.
    return () => { alive = false; };
  }, [profile, store]));
  const canSend = Boolean(ready && !pickingAttachment && !cameraBusy && !active?.deleting && settings && (settings.apiKey || anonymousLocalAllowed(settings)));
  const question = active?.question || "";
  const localPhotoSearch = localPhotoIntent83(question,active?.attachments || []);
  const canSearchLocal = Boolean(ready && !cameraBusy && !pickingAttachment && !active?.deleting && localPhotoSearch);
  const busy = active?.busy || false;
  const statusSignals = { voicePhase, busy, streamText: active?.streamText, progress: active?.progress, error, ready };
  const orbPhase = resolveNebulaHomePhase(statusSignals);
  const statusText = normalization.busy && !busy ? "Улучшаю текст" : resolveNebulaStatus(statusSignals);
  const composerOccluded = keyboardOpen || composerFocused;
  const artLayout = { listHeight: listViewportHeight, windowHeight: height,
    windowWidth: width, composerOccluded };
  const artworkSize = nebulaEmptyOrbSize(artLayout);
  const action = { minHeight: 44, minWidth: 44, justifyContent: "center" as const, alignItems: "center" as const };
  async function captureAndSearch() {
    if(cameraController.current || !ready || !active?.id || busy || pickingAttachment || dictating)return;
    const conversationId=active.id;
    const controller=new AbortController();
    cameraController.current=controller;
    setCameraBusy(true);setNotice("");
    try {
      const capture=await capturePhotoForSearch83(controller.signal);
      if(!capture || controller.signal.aborted || store.getSnapshot().activeId!==conversationId)return;
      await store.searchPhotosLocally(capture,conversationId);
    } catch(e) {
      if(!controller.signal.aborted)setNotice(memoryErrorMessage(e));
    } finally {
      cameraController.current=null;
      setCameraBusy(false);
    }
  }
  const sendOrStop = () => {
    if (busy) { store.stop(); return; }
    if (!settings && !localPhotoSearch) return;
    // Only a deliberate Send closes Gboard (not a pause in typing).
    Keyboard?.dismiss?.();
    setComposerFocused(false);
    setVoiceReset(n => n + 1);
    if(localPhotoSearch)void store.searchPhotosLocally();
    else if(settings)void store.send(settings);
  };
  const openConnections = (presetId?: string) => navigation.navigate("ModelConnections", presetId ? { presetId } : undefined);
  // First run: the active connection has neither a key nor a keyless local address.
  const needsSetup = Boolean(settings && !settings.apiKey && !anonymousLocalAllowed(settings));
  // Android 35 edge-to-edge does not reliably resize this screen above the IME on its own.
  // Keep the composer on screen with height avoidance; FlatList follows only finger gestures,
  // so the keyboard relayout must not be interpreted as a user scroll.
  return <KeyboardAvoidingView style={{ flex: 1, paddingTop: insets.top, paddingLeft: insets.left, paddingRight: insets.right, backgroundColor: t.bg }} behavior={Platform.OS === "ios" ? "padding" : "height"}>
    <StatusBar style={isFocused ? "light" : "auto"} />
    <NebulaHomeHeader statusText={statusText} onHistory={() => setHistoryOpen(true)}
      showOrb={ready} orbPhase={orbPhase}
      newChatEnabled={ready} onNewChat={() => store.create()} />
    {!ready ? <View style={{ padding: 20, gap: 12 }}>{!error ? <ActivityIndicator accessibilityLabel="Загрузка диалогов" /> : null}
      {error ? <Pressable accessibilityRole="button" onPress={() => void store.initialize()} style={action}><Text style={{ color: t.accent }}>Повторить загрузку</Text></Pressable> : null}</View> : null}
    <View style={{ flex: 1 }}>
    <FlatList key={active?.id || "empty"} ref={viewport.list} data={rows} keyExtractor={item => item.viewKey}
      testID="chat-message-list" style={{ flex: 1 }} removeClippedSubviews={false}
      CellRendererComponent={ChatCell}
      onLayout={event => {
        const nextHeight = Math.round(event.nativeEvent.layout.height);
        setListViewportHeight(previous => previous === nextHeight ? previous : nextHeight);
        viewport.onViewport(nextHeight);
      }}
      keyboardShouldPersistTaps="handled" keyboardDismissMode="none"
      scrollEventThrottle={64}
      onScrollBeginDrag={() => { viewport.beginDrag(); Keyboard?.dismiss?.(); }}
      onScroll={event => viewport.onScroll(event.nativeEvent)}
      onScrollEndDrag={event => viewport.endDrag(event.nativeEvent)}
      onMomentumScrollBegin={viewport.beginDrag}
      onMomentumScrollEnd={event => viewport.endDrag(event.nativeEvent)}
      onContentSizeChange={viewport.onContent}
      contentContainerStyle={{ padding: nebulaSpacing.md, gap: nebulaSpacing.sm, flexGrow: 1 }}
      ListEmptyComponent={ready && needsSetup ? <View style={{ flex: 1, justifyContent: "center", gap: 14, paddingVertical: 12 }}>
        <View style={{ alignItems: "center", gap: 10 }}><NebulaHomeArtwork size={136} phase={orbPhase} />
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
      </View> : ready && !busy ? <View testID="nebula-home-empty-state"
        style={{ flex: 1, alignItems: "center", justifyContent: "center", paddingVertical: 12 }}>
        {artworkSize > 0 ? <NebulaHomeArtwork size={artworkSize} phase={orbPhase} /> : null}
      </View> : null}
      renderItem={({ item }) => <View testID={"chat-message-" + item.role} accessibilityLiveRegion={item.streaming ? "polite" : undefined} style={{ alignSelf: item.role === "user" ? "flex-end" : "stretch", backgroundColor: item.role === "user" ? t.userBubble : item.role === "info" ? t.soft : t.panel,
        borderWidth: item.role === "assistant" ? 1 : 0, borderColor: t.line, borderRadius: 20, padding: 15, gap: 10 }}>
        {item.role === "assistant" ? <MarkdownText text={item.text} style={{ color: t.text, lineHeight: 23 }} /> :
          <Text selectable style={{ color: item.role === "user" ? t.userText : item.role === "info" ? t.muted : t.text, lineHeight: 23 }}>{item.text}</Text>}
        {item.attachments?.length ? <ChatAttachmentList files={item.attachments}/> : null}
        {item.memory?.length ? <View style={{ gap: 4 }}><Text style={{ color: t.muted, fontSize: 12 }}>Из памяти</Text>
          {item.memory.map(m => <Pressable key={m.id} accessibilityRole="link" accessibilityLabel={"Открыть запись " + m.title}
            onPress={() => navigation.navigate("MemoryNote", { entityId: m.id })} style={{ minHeight: 40, justifyContent: "center" }}>
            {m.photo ? <MemoryCover profile={profile} entityId={m.id} photoAttachmentId={m.photoAttachmentId} compact height={86}
              label={"Найденная фотография: "+m.title} /> : null}
            <Text numberOfLines={1} style={{ color: t.accent }}>{m.title}<Text style={{ color: t.muted, fontSize: 12 }}>{(m.section ? " · " + m.section : "") + (m.via === "rewrite" ? " · найдено другими словами" : m.via === "assistant" ? " · нашёл помощник" : "")}</Text></Text>
          </Pressable>)}</View> : null}
        {item.sources?.length ? <View style={{ gap: 4 }}><Text style={{ color: t.muted, fontSize: 12 }}>Источники</Text>{item.sources.map(url => <Pressable key={url} accessibilityRole="link" onPress={() => void Linking.openURL(url).catch(() => setNotice("Не удалось открыть ссылку."))} style={{ minHeight: 44, justifyContent: "center" }}>
          <Text numberOfLines={2} style={{ color: t.accent, textDecorationLine: "underline" }}>{url}</Text>
        </Pressable>)}</View> : null}
      </View>}
      ListFooterComponent={<View style={{ gap: 10 }}>
        {active?.drafts.map(d => <View key={d.id} style={{ backgroundColor: t.panel, borderWidth: 1, borderColor: t.accent, borderRadius: 20, padding: 16, gap: 8 }}>
          <Text style={{ color: t.accent, fontWeight: "700" }}>Запомнить?</Text><Text selectable style={{ color: t.text, fontWeight: "700" }}>{d.title}</Text><Text selectable style={{ color: t.text }}>{d.body}</Text>
          {d.kind || d.person || d.date ? <Text style={{ color: t.muted, fontSize: 13 }}>{[d.kind ? KIND_NAMES[d.kind] : "", d.person ? (d.kind === "person" ? "имя: " : "о ком: ") + d.person : "", d.date ? "дата: " + new Date(d.date + "T00:00:00").toLocaleDateString() : ""].filter(Boolean).join(" · ")}</Text> : null}
          <Text style={{ color: t.muted, fontSize: 12 }}>Раздел</Text>
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
            {[...sections.map(x => ({ key: x.slug, slug: x.slug as string | null, name: x.name, label: "Сохранить в раздел " + x.name })),
              ...(d.newSection && !sections.some(x => x.name.toLowerCase() === d.newSection!.toLowerCase()) ? [{ key: "new", slug: null, name: "+ Новый раздел «" + d.newSection + "»", label: "Создать раздел " + d.newSection + " и сохранить в него" }] : [])]
              .map(x => { const chosen = x.slug ? (d.section || (d.newSection ? "" : "notes")) === x.slug : !d.section; return <Pressable key={x.key} accessibilityRole="button"
              accessibilityLabel={x.label} accessibilityState={{ selected: chosen }} aria-selected={chosen} disabled={Boolean(active.savingDraft)} onPress={() => store.setDraftSection(d, x.slug)}
              style={{ minHeight: 36, paddingHorizontal: 10, justifyContent: "center", borderRadius: 12, borderWidth: 1, borderColor: chosen ? t.accent : t.line, backgroundColor: chosen ? t.soft : t.panel }}>
              <Text style={{ color: chosen ? t.accent : t.text, fontSize: 13 }}>{x.name}</Text></Pressable>; })}
          </View>
          <View style={{ flexDirection: "row", gap: 20 }}><Pressable accessibilityRole="button" disabled={Boolean(active.savingDraft)} onPress={() => void store.approve(d)} style={action}><Text style={{ color: t.accent }}>{active.savingDraft === d.id ? "Сохранение…" : "Сохранить"}</Text></Pressable>
            <Pressable accessibilityRole="button" disabled={Boolean(active.savingDraft)} onPress={() => store.dismiss(d)} style={action}><Text style={{ color: t.muted }}>Отклонить</Text></Pressable></View>
        </View>)}

      </View>}
    />
    {viewport.showJumpToLatest ? <Pressable testID="chat-jump-to-latest" accessibilityRole="button"
      accessibilityLabel="К последнему сообщению" onPress={viewport.jumpToLatest}
      style={{ position: "absolute", right: nebulaSpacing.md, bottom: nebulaSpacing.sm, zIndex: 4,
        paddingHorizontal: nebulaSpacing.md, minHeight: nebulaTouch.minimum, justifyContent: "center",
        borderRadius: 20, borderWidth: 1, borderColor: t.line, backgroundColor: t.panel }}>
      <Text style={{ color: t.accent, fontSize: 12 }}>↓ К последнему</Text>
    </Pressable> : null}
    </View>
    {error || notice || historyNotice ? <View style={{ paddingHorizontal: 16, paddingVertical: 6 }}><Text accessibilityRole="alert" style={{ color: error || notice ? t.err : t.muted }}>{error || notice || historyNotice}</Text>
      {error && ready ? <Pressable accessibilityRole="button" onPress={() => void store.checkpoint().catch(() => {})} style={{ minHeight: 44, justifyContent: "center" }}><Text style={{ color: t.accent }}>Повторить сохранение истории</Text></Pressable> : null}</View> : null}
    {!canSend && ready && !(needsSetup && !active?.rows.length) ? <Pressable accessibilityRole="button" onPress={() => openConnections()} style={{ paddingHorizontal: 16, minHeight: 44, justifyContent: "center" }}><Text style={{ color: t.accent }}>Добавьте модель в настройках подключений →</Text></Pressable> : null}
    <View style={{ zIndex: 3, padding: 10, gap: 5, backgroundColor: t.panel, borderTopWidth: 1, borderColor: t.line }}>
      {active?.attachments?.length ? <>
        <ChatAttachmentList files={active.attachments} disabled={busy || pickingAttachment} onRemove={id => { try {store.setAttachments(active.id, active.attachments!.filter(f => f.id !== id));} catch(e) {setNotice((e as Error).message);} }}/>
        <Text style={{color:t.muted,fontSize:12}}>Для запроса «Найди похожие фото» или «Найди фото по описанию» поиск выполняется локально в памяти. В остальных запросах вложения могут отправляться выбранной LLM.</Text>
      </> : null}
      <PromptInput value={question} onChange={value => store.setQuestion(value)} onClear={() => { normalization.reset(); setVoiceReset(n => n + 1); }} editable={ready} onFocusChange={setComposerFocused} />
      <View testID="composer-actions" style={{ zIndex: 1, flexDirection: "row", alignItems: "center", gap: 4 }}>
        <IconAction compact icon="paperclip" label="Файл" accessibilityLabel="Прикрепить файл к сообщению" hint="JPEG, PNG, WebP или текст UTF-8. До 3 файлов, каждый до 2 МБ; текст вместе до 24 000 символов. Файлы не сохраняются как заметки." hintAbove hintAlign="start" disabled={!ready || busy || pickingAttachment || dictating} onPress={() => void pickAttachment()} />
<IconAction compact icon="camera" label={cameraBusy?"Ищу фото":"Камера"} accessibilityLabel="Сфотографировать и найти похожее в памяти"
          hint="Снять предмет и сразу найти похожие сохранённые фотографии. Без облачной LLM и без сохранения снимка в заметки."
          hintAbove disabled={!ready || cameraBusy || busy || pickingAttachment || dictating}
          onPress={() => void captureAndSearch()} />
        <VoiceInput key={`${active?.id}:${voiceReset}`} value={question} onChange={value => { if (store.getSnapshot().activeId === active?.id) store.setQuestion(value); }} disabled={!ready || busy} onError={setNotice} showLabel={false} onBegin={normalization.reset} onActiveChange={setDictating} onPhaseChange={setVoicePhase} />
        <IconAction compact icon={normalization.busy ? "x" : normalization.normalized ? "rotate-ccw" : "edit-3"}
          label={normalization.busy ? "Отмена" : normalization.normalized ? "Исходный" : "Улучшить"}
          accessibilityLabel={normalization.busy ? "Отменить улучшение текста" : normalization.normalized ? "Вернуть исходный текст" : "Улучшить текст"}
          hint={normalization.busy ? "Отменить улучшение: исходный текст останется." : normalization.normalized ? "Вернуть текст до улучшения. Повторное нажатие снова покажет исправленный вариант без запроса к LLM." : normalization.alternate ? "Показать исправленный вариант без нового запроса к LLM." : "Исправить ошибки и пунктуацию всего черновика через выбранное подключение LLM. Один дополнительный запрос; сообщение не отправляется."}
          hintAbove hintAlign="center" emphasized={normalization.normalized}
          disabled={!ready || dictating || (!normalization.busy && (!question.trim() || (!normalization.alternate && !canSend)))}
          onPress={() => void normalization.toggle(settings)} />
        <View style={{ flex: 1, minWidth: 0 }} />
        <IconAction compact icon={busy ? "square" : "arrow-up"} label={busy ? "Стоп" : "Отправить"} accessibilityLabel={busy ? "Остановить запрос" : "Отправить запрос"}
          hint={busy ? "Остановить ответ ИИ в этом диалоге." : "Отправить написанное сообщение выбранной модели."} hintAbove emphasized={!busy}
          disabled={!busy && (!(canSend || canSearchLocal) || (!question.trim() && !active?.attachments?.length))} onPress={sendOrStop} />
      </View>
    </View>
    <ConversationHistorySheet visible={historyOpen} conversations={conversations} activeId={active?.id}
      onClose={() => setHistoryOpen(false)}
      onSelect={c => { store.select(c.id); setHistoryOpen(false); }}
      onDelete={c => Alert.alert("Удалить диалог?", c.title, [
        { text: "Отмена", style: "cancel" },
        { text: "Удалить", style: "destructive", onPress: () => void store.remove(c.id) },
      ])}
      onNewChat={() => { store.create(); setHistoryOpen(false); }}
    />
  </KeyboardAvoidingView>;
}

