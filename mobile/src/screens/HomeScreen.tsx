import { ChatAttachmentList } from "../media/ChatAttachmentList";
import Feather from "@expo/vector-icons/Feather";
import { useChatAttachments } from "../media/useChatAttachments";
import { capturePhotoDraft83, discardCameraPhotoDraft83, stageChatImageForNote83 } from "../media/vision-chat-camera";
import { MAX_CHAT_FILES } from "../direct-agent/chat-attachments";
import type { ChatAttachment } from "../direct-agent/chat-attachments";
import { localPhotoIntent83, localPhotoSuggestion83 } from "../media/vision-chat-search";
import { PhotoSearchResults } from "../media/PhotoSearchResults";
import { loadPhotoResultCount, DEFAULT_PHOTO_RESULT_COUNT } from "../media/photo-result-preferences";
import { PhotoContextActions } from "../media/PhotoContextActions";
import { memoryErrorMessage } from "../local-memory/errors";
import { onLocalMemorySessionChange } from "../local-memory/storage";
import { useFocusEffect, useIsFocused, useNavigation } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { StatusBar } from "expo-status-bar";
import { ActivityIndicator, Alert, FlatList, Image, Keyboard, KeyboardAvoidingView, Linking, Modal, Platform, Pressable, Text, useWindowDimensions, View } from "react-native";
import { useProfile } from "../profile/ProfileContext";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useDirectChat } from "../direct-agent/ChatContext";
import { PROVIDER_PRESETS, anonymousLocalAllowed, loadDirectConnections, searchKeyOf } from "../direct-agent/settings";
import { searchProviderOf } from "../direct-agent/web-search";
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
  const [photoResultCount, setPhotoResultCount] = useState<number>(DEFAULT_PHOTO_RESULT_COUNT);
  const [cameraBusy,setCameraBusy] = useState(false);
  const [selectedPhotoId,setSelectedPhotoId]=useState<string|null>(null);
  const [previewPhotoId,setPreviewPhotoId]=useState<string|null>(null);
  const cameraOriginal=useRef(new Map<string,{conversationId:string;uri:string}>());
  const releaseCameraOriginal=(id?:string)=>{
    for(const [key,photo] of cameraOriginal.current){
      if(id && key!==id)continue;
      discardCameraPhotoDraft83(photo.uri);
      cameraOriginal.current.delete(key);
    }
  };
  const cameraController = useRef<AbortController|null>(null);
  useEffect(() => {
    const off=onLocalMemorySessionChange(unlocked => {
      if(!unlocked){cameraController.current?.abort();releaseCameraOriginal();}
    });
    return () => {cameraController.current?.abort();releaseCameraOriginal();off();};
  },[profile]);
  const {picking: pickingAttachment, pick: pickAttachment} = useChatAttachments(store, active?.id, isFocused, setNotice, setSelectedPhotoId);
  useEffect(()=>{
    for(const [id,original] of cameraOriginal.current){
      if(original.conversationId!==active?.id || !active?.attachments?.some(f=>f.id===id))
        releaseCameraOriginal(id);
    }
  },[active?.id,active?.attachments]);
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
    if (profile) void loadPhotoResultCount(profile).then(value => { if (alive) setPhotoResultCount(value); }).catch(() => { if (alive) setPhotoResultCount(DEFAULT_PHOTO_RESULT_COUNT); });
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
  const suggestedPhotoSearch = localPhotoSuggestion83(question, active?.attachments || []);
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
  const selectedPhoto:ChatAttachment|undefined =
    active?.attachments?.find(f=>f.id===selectedPhotoId && f.kind==="image");
  const previewPhoto=active?.attachments?.find(f=>f.id===previewPhotoId && f.kind==="image");
  async function captureToDraft() {
    if(cameraController.current || !ready || !active?.id || busy || pickingAttachment || dictating)return;
    const conversationId=active.id;
    const before=store.getSnapshot().conversations.find(c=>c.id===conversationId);
    if((before?.attachments?.length || 0)>=MAX_CHAT_FILES){
      Alert.alert("Вложения","В сообщении может быть не более трёх файлов. Уберите один перед съёмкой.");return;
    }
    const controller=new AbortController();
    cameraController.current=controller;
    setCameraBusy(true);setNotice("");
    try {
      const draft=await capturePhotoDraft83(controller.signal);
      if(!draft)return;
      if(controller.signal.aborted || store.getSnapshot().activeId!==conversationId){
        discardCameraPhotoDraft83(draft.originalUri);return;
      }
      const current=store.getSnapshot().conversations.find(c=>c.id===conversationId);
      if(!current || current.busy || current.deleting || (current.attachments?.length || 0)>=MAX_CHAT_FILES){
        discardCameraPhotoDraft83(draft.originalUri);return;
      }
      try{store.setAttachments(conversationId,[...(current.attachments || []),draft.attachment]);}
      catch(e){discardCameraPhotoDraft83(draft.originalUri);throw e;}
      cameraOriginal.current.set(draft.attachment.id,{conversationId,uri:draft.originalUri});
      setSelectedPhotoId(draft.attachment.id);
      Keyboard.dismiss();
      setComposerFocused(false);
    } catch(e) {
      if(!controller.signal.aborted)Alert.alert("Камера",memoryErrorMessage(e),[{text:"Закрыть"}]);
    } finally {cameraController.current=null;setCameraBusy(false);}
  }
  function discardSelectedPhoto() {
    if(!selectedPhoto || busy || cameraBusy || !active?.id)return;
    const photoId=selectedPhoto.id;
    const conversationId=active.id;
    const current=store.getSnapshot().conversations.find(c=>c.id===conversationId);
    if(!current || current.busy || current.deleting)return;
    store.setAttachments(conversationId,(current.attachments||[]).filter(file=>file.id!==photoId));
    releaseCameraOriginal(photoId);
    setPreviewPhotoId(value=>value===photoId?null:value);
    setSelectedPhotoId(null);
  }
  function searchSelectedPhoto() {
    if(!selectedPhoto || busy || cameraBusy || !active?.id)return;
    Keyboard.dismiss();setComposerFocused(false);
    // The submitted image leaves the composer on search start; other drafts remain.
    void store.searchPhotosLocally(selectedPhoto,active.id);
  }
  function findSelectedOnline() {
    if(!selectedPhoto || !active?.id || busy || cameraBusy)return;
    if(!settings || !(settings.apiKey || anonymousLocalAllowed(settings))) {
      Alert.alert("Модель не подключена","Для распознавания фотографии требуется модель с поддержкой изображений.",
        [{text:"Закрыть"},{text:"Настройки",onPress:()=>openConnections()}]);return;
    }
    if(!settings.allowWeb){
      Alert.alert("Интернет-поиск выключен","Включите интернет-поиск у выбранного подключения.",
        [{text:"Закрыть"},{text:"Настройки",onPress:()=>openConnections()}]);return;
    }
    const webProvider=searchProviderOf(settings);
    const webConfigured=webProvider==="builtin"
      ? settings.provider==="openai"
      : Boolean(searchKeyOf(settings,webProvider));
    if(!webConfigured){
      Alert.alert("Интернет-поиск не настроен","Выберите и настройте поисковый сервис в параметрах подключения, чтобы получить ссылки на источники.",
        [{text:"Закрыть"},{text:"Настройки",onPress:()=>openConnections()}]);return;
    }
    const id=selectedPhoto.id;
    const conversationId=active.id;
    Alert.alert("Поиск в интернете","Фотография будет отправлена выбранной модели. Она определит объект и попробует найти сведения в интернете.",
      [{text:"Отмена",style:"cancel"},{text:"Найти",onPress:()=>{
        if(store.getSnapshot().activeId===conversationId)void store.send(settings,id);
      }}]);
  }
  async function saveSelectedPhotoNote() {
    if(!selectedPhoto || !active?.id || busy || cameraBusy)return;
    const photo=selectedPhoto;
    const conversationId=active.id;
    const matched=cameraOriginal.current.get(photo.id);
    const original=matched?.conversationId===conversationId ? matched.uri : null;
    let staged=original;
    try {
      if(!staged)staged=await stageChatImageForNote83(photo);
      if(store.getSnapshot().activeId!==conversationId){discardCameraPhotoDraft83(staged);return;}
      if(original)cameraOriginal.current.delete(photo.id); // ownership moves to MemoryImport
      navigation.navigate("MemoryImport",{source:"photo",initialPhotoUri:staged});
    }catch(e){if(staged)discardCameraPhotoDraft83(staged);setNotice(memoryErrorMessage(e));}
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
        {active?.retryPhoto?.rowId === item.id && active?.retryPhoto ? <Pressable accessibilityRole="button"
          disabled={busy} onPress={() => void store.searchPhotosLocally(active.retryPhoto!.image,active.id)}
          style={{minHeight:48,justifyContent:"center"}}>
          <Text style={{color:t.secondary}}>Повторить поиск по фото</Text>
        </Pressable> : null}
        {item.photoAction ? <Pressable accessibilityRole="button" style={{minHeight:48,justifyContent:"center"}}
          onPress={() => item.photoAction === "import" ? navigation.navigate("MemoryImport", {source:"photo"}) : navigation.navigate("PhotoSearchSettings")}>
          <Text style={{color:t.secondary}}>{item.photoAction === "model" ? "Выбрать модель" : item.photoAction === "import" ? "Добавить фото в память" : "Подготовить фото"}</Text>
        </Pressable> : null}
        {item.attachments?.length ? <ChatAttachmentList files={item.attachments}/> : null}
        {item.memory?.length ? <View style={{ gap: 4 }}><Text style={{ color: t.muted, fontSize: 12 }}>Из памяти</Text>
          {item.memory.some(m => m.photo) ? <PhotoSearchResults key={item.id} profile={profile} results={item.memory.filter(m=>m.photo)} limit={photoResultCount}
            onOpen={(result, original) => navigation.navigate("MemoryNote", {entityId:result.id, photoAttachmentId:original ? result.photoAttachmentId : undefined})} /> : null}
          {item.memory.filter(m=>!m.photo).map(m => <Pressable key={m.id} accessibilityRole="link" accessibilityLabel={"Открыть запись " + m.title}
              onPress={() => navigation.navigate("MemoryNote", {entityId:m.id})} style={{minHeight:48,justifyContent:"center"}}>
              <Text style={{color:t.accent}}>{m.title}<Text style={{color:t.muted,fontSize:12}}>{(m.section ? " · " + m.section : "") + (m.via === "rewrite" ? " · найдено другими словами" : m.via === "assistant" ? " · нашёл помощник" : "")}</Text></Text>
            </Pressable>)}
        </View> : null}
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
    {error || notice || historyNotice ? <View style={{ paddingHorizontal: 16, paddingVertical: 6 }}>
      <View style={{flexDirection:"row",alignItems:"center",gap:8}}>
        <Text accessibilityRole="alert" style={{ flex:1,color: error || notice ? t.err : t.muted }}>{error || notice || historyNotice}</Text>
        {notice ? <Pressable accessibilityRole="button" accessibilityLabel="Закрыть сообщение об ошибке" onPress={() => setNotice("")}
          style={{minWidth:44,minHeight:44,justifyContent:"center",alignItems:"center"}}>
          <Feather name="x" size={18} color={t.secondary}/>
        </Pressable> : null}
      </View>
      {error && ready ? <Pressable accessibilityRole="button" onPress={() => void store.checkpoint().catch(() => {})} style={{ minHeight: 44, justifyContent: "center" }}><Text style={{ color: t.accent }}>Повторить сохранение истории</Text></Pressable> : null}</View> : null}
    {!canSend && ready && !(needsSetup && !active?.rows.length) ? <Pressable accessibilityRole="button" onPress={() => openConnections()} style={{ paddingHorizontal: 16, minHeight: 44, justifyContent: "center" }}><Text style={{ color: t.accent }}>Добавьте модель в настройках подключений →</Text></Pressable> : null}
    <View style={{ zIndex: 3, padding: 10, gap: 5, backgroundColor: t.panel, borderTopWidth: 1, borderColor: t.line }}>
      {active?.attachments?.length ? <>
        <ChatAttachmentList files={active.attachments} disabled={busy || cameraBusy || pickingAttachment}
          selectedImageId={selectedPhoto?.id} onSelectImage={setSelectedPhotoId}
          onRemove={id => {try {
            releaseCameraOriginal(id);
            store.setAttachments(active.id,active.attachments!.filter(f=>f.id!==id));
            if(previewPhotoId===id)setPreviewPhotoId(null);
            if(selectedPhotoId===id)setSelectedPhotoId(null);
          }catch(e){setNotice((e as Error).message);}}}/>
        {selectedPhoto ? <PhotoContextActions disabled={busy || cameraBusy || pickingAttachment}
          onCancel={discardSelectedPhoto}
          actions={[
            {id:"internet",label:"В интернете",run:findSelectedOnline},
            {id:"memory",label:"В моей памяти",run:searchSelectedPhoto},
            {id:"note",label:"Сохранить заметку",run:()=>void saveSelectedPhotoNote()},
            {id:"preview",label:"Посмотреть",run:()=>setPreviewPhotoId(selectedPhoto.id)},
          ]} /> : null}
      </> : null}
      {suggestedPhotoSearch && ready && !busy && !cameraBusy && !pickingAttachment && !dictating ? <Pressable
        accessibilityRole="button" accessibilityLabel="Поискать в моих фото" style={{minHeight:48,justifyContent:"center"}}
        onPress={() => { Keyboard.dismiss(); void store.searchPhotosLocally(undefined, active?.id, true); }}>
        <Text style={{color:t.accent}}>Поискать в моих фото</Text>
      </Pressable> : null}
      <PromptInput value={question} onChange={value => store.setQuestion(value)} onClear={() => { normalization.reset(); setVoiceReset(n => n + 1); }} editable={ready} onFocusChange={setComposerFocused} />
      <View testID="composer-actions" style={{ zIndex: 1, flexDirection: "row", alignItems: "center", gap: 4 }}>
        <IconAction compact icon="paperclip" label="Файл" accessibilityLabel="Прикрепить файл к сообщению" hint="JPEG, PNG, WebP или текст UTF-8. До 3 файлов: фото до 80 МБ автоматически уменьшается для чата (до 6 МБ); текст вместе до 24 000 символов. Файлы не сохраняются как заметки." hintAbove hintAlign="start" disabled={!ready || busy || pickingAttachment || dictating} onPress={() => void pickAttachment()} />
<IconAction compact icon="camera" label={cameraBusy?"Съёмка…":"Камера"} accessibilityLabel="Сделать снимок"
          hint="Камера откроется сразу. После съёмки можно спросить ИИ, найти в интернете или памяти, сохранить заметку."
          hintAbove disabled={!ready || cameraBusy || busy || pickingAttachment || dictating}
          onPress={() => void captureToDraft()} />
        <VoiceInput key={`${active?.id}:${voiceReset}`} value={question} onChange={value => { if (store.getSnapshot().activeId === active?.id) store.setQuestion(value); }} disabled={!ready || busy} onError={setNotice} showLabel={false} onBegin={normalization.reset} onActiveChange={setDictating} onPhaseChange={setVoicePhase} />
        <IconAction compact icon={normalization.busy ? "x" : normalization.normalized ? "rotate-ccw" : "edit-3"}
          label={normalization.busy ? "Отмена" : normalization.normalized ? "Исходный" : "Улучшить"}
          accessibilityLabel={normalization.busy ? "Отменить улучшение текста" : normalization.normalized ? "Вернуть исходный текст" : "Улучшить текст"}
          hint={normalization.busy ? "Отменить улучшение: исходный текст останется." : normalization.normalized ? "Вернуть текст до улучшения. Повторное нажатие снова покажет исправленный вариант без запроса к LLM." : normalization.alternate ? "Показать исправленный вариант без нового запроса к LLM." : "Исправить ошибки и пунктуацию всего черновика через выбранное подключение LLM. Один дополнительный запрос; сообщение не отправляется."}
          hintAbove hintAlign="center" emphasized={normalization.normalized}
          disabled={!ready || dictating || (!normalization.busy && (!question.trim() || (!normalization.alternate && !canSend)))}
          onPress={() => void normalization.toggle(settings)} />
        <View style={{ flex: 1, minWidth: 0 }} />
        <IconAction compact icon={busy ? "square" : "arrow-up"} label={busy ? "Стоп" : localPhotoSearch ? "Найти" : "Отправить"} accessibilityLabel={busy ? "Остановить запрос" : localPhotoSearch ? "Найти фотографии в памяти" : "Отправить запрос"}
          hint={busy ? "Остановить ответ ИИ в этом диалоге." : localPhotoSearch ? "Найти фотографии на телефоне." : "Отправить написанное сообщение выбранной модели."} hintAbove emphasized={!busy}
          disabled={!busy && (!(canSend || canSearchLocal) || (!question.trim() && !active?.attachments?.length))} onPress={sendOrStop} />
      </View>
    </View>
    <Modal visible={Boolean(previewPhoto)} transparent animationType="fade" onRequestClose={()=>setPreviewPhotoId(null)}>
      <View style={{flex:1,backgroundColor:"rgba(0,0,0,0.94)",justifyContent:"center",padding:16,gap:12}}>
        {previewPhoto ? <Image source={{uri:`data:${previewPhoto.mime};base64,${previewPhoto.data}`}}
          style={{width:"100%",height:"75%"}} resizeMode="contain" accessibilityLabel="Просмотр фотографии"/> : null}
        <Pressable accessibilityRole="button" accessibilityLabel="Закрыть просмотр фото"
          style={{minHeight:48,alignItems:"center",justifyContent:"center"}} onPress={()=>setPreviewPhotoId(null)}>
          <Text style={{color:"#fff",fontWeight:"700"}}>Закрыть</Text>
        </Pressable>
      </View>
    </Modal>
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

