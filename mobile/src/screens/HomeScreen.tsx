import { BottomSheet } from "../components/BottomSheet";
import Feather from "@expo/vector-icons/Feather";
import { useChatAttachments } from "../media/useChatAttachments";
import { capturePhotoDraft83, discardCameraPhotoDraft83, stageChatImageForNote83 } from "../media/vision-chat-camera";
import { MAX_CHAT_FILES } from "../direct-agent/chat-attachments";
import { planDocumentSynthesis } from "../direct-agent/document-synthesis";
import { loadModelCallLimit } from "../direct-agent/agent-preferences";
import { imageCapability } from "../direct-agent/attachment-capabilities";
import type { ChatAttachment } from "../direct-agent/chat-attachments";
import { loadPhotoResultCount, DEFAULT_PHOTO_RESULT_COUNT } from "../media/photo-result-preferences";
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
import { NebulaAction } from "../design/nebula/components";
import { useChatBottomFollow } from "../design/nebula/useChatBottomFollow";
import { showDraftImprove, useVoiceEngine } from "../media/voice-engine";
import { ChatRowView } from "../components/chat/ChatRowView";
import { ChatComposer } from "../components/chat/ChatComposer";
import { NebulaHomeThemeProvider, useTheme } from "../theme";
import { KIND_NAMES } from "../direct-agent/fact-tool";
import { useDraftNormalization } from "../direct-agent/use-draft-normalization";
import { prepareAssistantReplyNote } from "../direct-agent/chat-response-note";
import { planDialogueSummary, type DialogueSummaryScope } from "../direct-agent/dialogue-summary";

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
  const {picking: pickingAttachment, pick: pickAttachment, audioPreparing, cancel: cancelAttachmentPreparation, failedFiles, dismissFailure} = useChatAttachments(store, active?.id, isFocused, setNotice, setSelectedPhotoId);
  useEffect(()=>{
    for(const [id,original] of cameraOriginal.current){
      if(original.conversationId!==active?.id || !active?.attachments?.some(f=>f.id===id))
        releaseCameraOriginal(id);
    }
  },[active?.id,active?.attachments]);
  const [summaryId, setSummaryId] = useState<string | null>(null);
  const [summaryScope, setSummaryScope] = useState<DialogueSummaryScope>("last10");
  const [summaryLimit, setSummaryLimit] = useState<number | null>(null);
  const [summaryError, setSummaryError] = useState("");
  useEffect(() => {
    if (!summaryId || !profile) return;
    let current = true;
    void loadModelCallLimit(profile).then(limit => { if (current) setSummaryLimit(limit); })
      .catch(() => { if (current) setSummaryError("Не удалось загрузить лимит обращений."); });
    return () => { current = false; };
  }, [profile, summaryId]);
  useEffect(() => {
    setSummaryId(null);
    return onLocalMemorySessionChange(unlocked => { if (!unlocked) setSummaryId(null); });
  }, [profile]);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyTarget, setHistoryTarget] = useState<{ conversationId: string; rowId: string } | null>(null);
  const voicePreference = useVoiceEngine();
  const showWhisperImprove = showDraftImprove(voicePreference.pending ?? voicePreference.preference);
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
  useEffect(() => {
    if (historyOpen || !historyTarget || active?.id !== historyTarget.conversationId) return;
    const index = rows.findIndex(row => row.id === historyTarget.rowId);
    if (index >= 0) viewport.jumpToMessage(index);
    // Never try to navigate to a deleted/damaged message or to another chat.
    setHistoryTarget(null);
  }, [historyOpen, historyTarget, active?.id, rows, viewport.jumpToMessage]);
  // Stable component identity is essential: recreating this on tokens remounts cells.
  const ChatCell = useCallback(({ onLayout, children, style, onFocusCapture }: CellRendererProps<PresentedChatRow>) =>
    <View {...{ style, onFocusCapture }} onLayout={onLayout}>{children}</View>, []);
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
  const draftImageSupport = settings ? imageCapability(settings,active?.attachments || []) : "no-images";
  const question = active?.question || "";
  const busy = active?.busy || false;
  const statusSignals = { voicePhase, busy, streamText: active?.streamText, progress: active?.progress, error, ready };
  const orbPhase = resolveNebulaHomePhase(statusSignals);
  const statusText = normalization.busy && !busy ? "Улучшаю текст" : resolveNebulaStatus(statusSignals);
  const composerOccluded = keyboardOpen || composerFocused;
  const artLayout = { listHeight: listViewportHeight, windowHeight: height,
    windowWidth: width, composerOccluded };
  const artworkSize = nebulaEmptyOrbSize(artLayout);
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
    // One assistant turn; raw photo is passed only to the canonical local tool.
    if(!settings || !canSend){setNotice("Подключите модель для поиска фотографий через помощника.");return;}
    void store.searchPhotosWithAgent(settings,selectedPhoto,active.id);
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
    // Never send a partial draft while a selected file is being decoded/ASR.
    if (pickingAttachment) return;
    if (!settings || !canSend) {setNotice("Подключите модель для работы с чатом.");return;}
    // Only a deliberate Send closes Gboard (not a pause in typing).
    Keyboard?.dismiss?.();
    setComposerFocused(false);
    setVoiceReset(n => n + 1);
    {
      let plan;
      try {plan=planDocumentSynthesis(active?.attachments||[],settings.model);}
      catch(e){setNotice((e as Error).message);return;}
      if(!plan){void store.send(settings);return;}
      if(!profile || !active?.id){setNotice("Диалог недоступен.");return;}
      const conversationId=active.id;
      const selectedSettings=settings;
      const approvedPlan=plan;
      void loadModelCallLimit(profile).then(limit=>{
        if(store.getSnapshot().activeId!==conversationId)return;
        if(approvedPlan.calls>limit){
          setNotice("Для анализа всех частей потребуется "+approvedPlan.calls+
            " обращений к модели; сейчас разрешено "+limit+". Измените лимит в Настройки → Работа ИИ. Файлы остались в черновике.");
          return;
        }
        Alert.alert("Обработка больших документов",
          "Модель: "+selectedSettings.model+" · "+selectedSettings.provider+".\n"+
          "Файлов: "+approvedPlan.files+", символов: "+approvedPlan.textChars.toLocaleString("ru-RU")+".\n"+
          "План: "+approvedPlan.parts.length+" частей + итог, до "+approvedPlan.calls+
          " вызовов ИИ. Текст каждой части отправится выбранному провайдеру через сеть; "+
          "услуга может быть платной, точная стоимость зависит от его тарифов. "+
          "Оригинальные PDF/аудиофайлы не отправляются. Без согласия сеть не используется.",
          [{text:"Отмена",style:"cancel"},{text:"Разрешить и обработать",onPress:()=>{
            if(store.getSnapshot().activeId===conversationId)
              void store.send(selectedSettings,undefined,approvedPlan.approvalKey);
          }}]);
      }).catch(()=>setNotice("Не удалось проверить лимит обращений к ИИ; документы не отправлены."));
    }
  };
  /** H-SAVE1b is opt-in, never an automatic paid background summary. */
  const chooseDialogueSummary = (id: string) => {
    setSummaryLimit(null); setSummaryError(""); setSummaryScope("last10"); setSummaryId(id);
  };
  const summaryConversation = conversations.find(c => c.id === summaryId);
  const summary = useMemo(() => {
    if (!summaryConversation || !settings) return { error: "Диалог или подключение недоступны." };
    try {
      return { plan: planDialogueSummary(summaryConversation, summaryScope, settings.model, settings.provider) };
    } catch (e) { return { error: (e as Error).message }; }
  }, [summaryConversation, summaryScope, settings]);
  const createSummary = () => {
    const plan = summary.plan;
    if (!plan || !settings || summaryLimit === null || plan.calls > summaryLimit || !summaryId) return;
    setSummaryId(null);
    void store.summarizeForNote(summaryId, settings, plan.scope, plan.approvalKey)
      .then(locator => { if (store.getSnapshot().conversations.some(c => c.id === locator.conversationId))
        navigation.navigate("MemoryNote", {chatReply: locator}); })
      .catch(e => setNotice((e as Error).message));
  };
  /** Local-only action: no LLM call. The editor revalidates the IDs on Save. */
  const saveReplyToNotes = (rowId:string) => {
    const conversationId=active?.id;
    if(!conversationId)return;
    const locator={conversationId,rowId};
    try {
      // Validation is local/read-only; MemoryNote rechecks the locator on Save.
      prepareAssistantReplyNote(store.getSnapshot().conversations,locator);
      if (store.getSnapshot().activeId !== conversationId) return;
      navigation.navigate("MemoryNote",{chatReply:locator});
    } catch(e) { setNotice((e as Error).message); }
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
    {active?.context ? <View testID="chat-current-context" style={{paddingHorizontal:14,paddingVertical:5,
      borderBottomWidth:1,borderColor:t.line,flexDirection:"row",alignItems:"center",gap:8}}>
      <Text numberOfLines={2} style={{flex:1,color:t.secondary,fontSize:12}}>
        {active.context.topic} · {sections.find(s=>s.slug===active.context?.sectionSlug)?.name || "Раздел не определён"}
      </Text>
      <NebulaAction icon={active.context.pinned?"lock":"unlock"} size="compact"
        label={active.context.pinned?"Открепить":"Закрепить"}
        accessibilityLabel={active.context.pinned?"Открепить раздел диалога":"Закрепить раздел диалога"}
        disabled={busy || !active.context.sectionSlug}
        onPress={()=>store.setContextPinned(!active.context!.pinned)} />
    </View> : null}
    {!ready ? <View style={{ padding: 20, gap: 12 }}>{!error ? <ActivityIndicator accessibilityLabel="Загрузка диалогов" /> : null}
      {error ? <NebulaAction icon="refresh-cw" label="Повторить загрузку" size="compact" onPress={() => void store.initialize()} /> : null}</View> : null}
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
       onScrollToIndexFailed={viewport.onScrollToIndexFailed}
      contentContainerStyle={{ padding: nebulaSpacing.md, paddingBottom: active?.rows.length ? nebulaTouch.minimum + nebulaSpacing.xxl : nebulaSpacing.md, gap: nebulaSpacing.sm, flexGrow: 1 }}
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
        <NebulaAction icon="settings" label="Другие варианты подключения"
          accessibilityLabel="Другие варианты, включая OpenAI и Anthropic"
          onPress={() => openConnections()} />
      </View> : ready && !busy ? <View testID="nebula-home-empty-state"
        style={{ flex: 1, alignItems: "center", justifyContent: "center", paddingVertical: 12 }}>
        {artworkSize > 0 ? <NebulaHomeArtwork size={artworkSize} phase={orbPhase} /> : null}
      </View> : null}
      renderItem={({ item }) => <ChatRowView
        item={item} t={t} profile={profile} photoResultCount={photoResultCount}
        ready={ready} busy={busy} canSend={canSend} settings={settings}
        retryPhoto={active?.retryPhoto} movingRowId={active?.movingRowId}
        onSaveReply={saveReplyToNotes}
        onOpenNote={(noteId, photoAttachmentId) => navigation.navigate("MemoryNote",
          {entityId:noteId, ...(photoAttachmentId ? {photoAttachmentId} : {})})}
        onRetryRequest={() => { if (settings) void store.retry(settings); }}
        onRetryPhoto={() => { if (settings && active?.retryPhoto)
          void store.searchPhotosWithAgent(settings, active.retryPhoto.image, active.id); }}
        onPhotoAction={action => action === "import" ? navigation.navigate("MemoryImport", {source:"photo"}) : navigation.navigate("PhotoSearchSettings")}
        onConfirmProposal={rowId => { void store.confirmProposal(rowId); }}
        onDismissProposal={rowId => store.dismissProposal(rowId)}
        onUndoProposal={rowId => { void store.undoProposal(rowId); }}
        onContinueArticles={rowId => { if (settings) void store.continueArticlesWithAgent(settings,rowId); }}
        onOpenSource={url => { void Linking.openURL(url).catch(() => setNotice("Не удалось открыть ссылку.")); }}
      />}
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
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: nebulaSpacing.sm }}>
            <NebulaAction icon="check" label={active.savingDraft === d.id ? "Сохранение…" : "Сохранить"}
              variant="primary" disabled={Boolean(active.savingDraft)} onPress={() => void store.approve(d)} />
            <NebulaAction icon="x" label="Отклонить" size="compact" disabled={Boolean(active.savingDraft)}
              onPress={() => store.dismiss(d)} />
          </View>
        </View>)}

      </View>}
    />
    {viewport.showJumpToLatest ? <View pointerEvents="box-none" style={{ position: "absolute", left: 0, right: 0, bottom: nebulaSpacing.sm, zIndex: 4, alignItems: "center" }}>
      <Pressable testID="chat-jump-to-latest" accessibilityRole="button"
        accessibilityLabel="К последнему сообщению" accessibilityHint="Прокрутить чат к последнему сообщению"
        onPress={viewport.jumpToLatest}
        style={{ paddingHorizontal: nebulaSpacing.md, minWidth: nebulaTouch.minimum, minHeight: nebulaTouch.minimum,
          justifyContent: "center", alignItems: "center",
          borderRadius: 20, borderWidth: 1, borderColor: t.line, backgroundColor: t.panel,
          elevation: 6, shadowColor: "#000", shadowOpacity: 0.35, shadowRadius: 8, shadowOffset: { width: 0, height: 2 } }}>
        <Text style={{ color: t.accent, fontSize: 12 }}>↓ К последнему</Text>
      </Pressable>
    </View> : null}
    </View>
    {error || notice || historyNotice ? <View style={{ paddingHorizontal: 16, paddingVertical: 6 }}>
      <View style={{flexDirection:"row",alignItems:"center",gap:8}}>
        <Text accessibilityRole="alert" style={{ flex:1,color: error || notice ? t.err : t.muted }}>{error || notice || historyNotice}</Text>
        {notice ? <Pressable accessibilityRole="button" accessibilityLabel="Закрыть сообщение об ошибке" onPress={() => setNotice("")}
          style={{minWidth:44,minHeight:44,justifyContent:"center",alignItems:"center"}}>
          <Feather name="x" size={18} color={t.secondary}/>
        </Pressable> : null}
      </View>
      {error && ready ? <NebulaAction icon="refresh-cw" label="Повторить сохранение истории"
        onPress={() => void store.checkpoint().catch(() => {})} /> : null}</View> : null}
    {!canSend && ready && !(needsSetup && !active?.rows.length) ? <View style={{paddingHorizontal:nebulaSpacing.md}}>
      <NebulaAction icon="settings" label="Настроить подключение модели"
        accessibilityLabel="Добавьте модель в настройках подключений" onPress={() => openConnections()} />
    </View> : null}
    <ChatComposer t={t}
      pickingAttachment={pickingAttachment} audioPreparing={audioPreparing}
      draftImageSupport={draftImageSupport} failedFiles={failedFiles}
      ready={ready} busy={busy} dictating={dictating} cameraBusy={cameraBusy}
      attachments={active?.attachments} selectedPhoto={selectedPhoto}
      question={question} activeId={active?.id} voiceReset={voiceReset}
      showWhisperImprove={showWhisperImprove} normalizationBusy={normalization.busy}
      normalizationNormalized={Boolean(normalization.normalized)}
      normalizationAlternate={Boolean(normalization.alternate)}
      canSend={canSend} settings={settings}
      onCancelAttachmentPreparation={cancelAttachmentPreparation}
      onPickAttachment={() => { void pickAttachment(); }}
      onDismissFailure={dismissFailure}
      onSelectImage={setSelectedPhotoId}
      onRemoveAttachment={id => { try {
        releaseCameraOriginal(id);
        setNotice("");
        if (active) store.setAttachments(active.id, active.attachments!.filter(f => f.id !== id));
        if (previewPhotoId === id) setPreviewPhotoId(null);
        if (selectedPhotoId === id) setSelectedPhotoId(null);
      } catch (e) { setNotice((e as Error).message); } }}
      onCancelSelectedPhoto={discardSelectedPhoto}
      onFindSelectedOnline={findSelectedOnline}
      onSearchSelectedPhoto={searchSelectedPhoto}
      onSaveSelectedPhotoNote={() => { void saveSelectedPhotoNote(); }}
      onPreviewSelectedPhoto={() => { if (selectedPhoto) setPreviewPhotoId(selectedPhoto.id); }}
      onQuestionChange={value => store.setQuestion(value)}
      onClearQuestion={() => { normalization.reset(); setVoiceReset(n => n + 1); }}
      onFocusChange={setComposerFocused}
      onCaptureCamera={() => { void captureToDraft(); }}
      onVoiceChange={value => { if (store.getSnapshot().activeId === active?.id) store.setQuestion(value); }}
      onVoiceError={setNotice}
      onVoiceBegin={() => { normalization.reset(); setNotice(""); }}
      onDictatingChange={setDictating}
      onVoicePhaseChange={setVoicePhase}
      onToggleNormalization={() => { void normalization.toggle(settings); }}
      onSendOrStop={sendOrStop}
    />
    <Modal visible={Boolean(previewPhoto)} transparent animationType="fade" onRequestClose={()=>setPreviewPhotoId(null)}>
      <View style={{flex:1,backgroundColor:"rgba(0,0,0,0.94)",justifyContent:"center",padding:16,gap:12}}>
        {previewPhoto ? <Image source={{uri:`data:${previewPhoto.mime};base64,${previewPhoto.data}`}}
          style={{width:"100%",height:"75%"}} resizeMode="contain" accessibilityLabel="Просмотр фотографии"/> : null}
        <NebulaAction icon="x" label="Закрыть" size="compact" accessibilityLabel="Закрыть просмотр фото"
          onPress={()=>setPreviewPhotoId(null)} />
      </View>
    </Modal>
    <BottomSheet visible={Boolean(summaryId)} title="Итог диалога" onClose={() => setSummaryId(null)}>
      {summary.plan && summary.plan.totalRows <= 10 ? null :
        <NebulaAction icon="list" size="compact" label={summaryScope === "all" ? "Выбрать последние 10 сообщений" : "Выбрать весь диалог"}
          onPress={() => setSummaryScope(summaryScope === "all" ? "last10" : "all")} />}
      {summary.plan ? <View style={{gap:8}}>
        <Text style={{color:t.text, fontWeight:"700"}}>
          {summary.plan.includedRows === summary.plan.totalRows ? "Весь диалог" : "Последние 10 сообщений"}
        </Text>
        <Text style={{color:t.text}}>Сообщений: {summary.plan.includedRows} из {summary.plan.totalRows} · {summary.plan.source.length.toLocaleString("ru-RU")} символов</Text>
        <Text style={{color:t.secondary}}>{settings?.provider} · {settings?.model}{"\n"}Обращений к модели: до {summary.plan.calls}. Лимит: {summaryLimit ?? "…"}.</Text>
        <Text style={{color:t.muted}}>Модель получит текст переписки без оригиналов файлов. Возможна оплата. Итог откроется в черновике.</Text>
      </View> : null}
      {summary.error || summaryError ? <Text accessibilityRole="alert" style={{color:t.err}}>{summary.error || summaryError}</Text> : null}
      {summary.plan && summaryLimit !== null && summary.plan.calls > summaryLimit ?
        <Text style={{color:t.err}}>Превышен лимит обращений к модели.</Text> : null}
      <NebulaAction icon="check" label="Создать итог" variant="primary"
        disabled={!summary.plan || summaryLimit === null || summary.plan.calls > summaryLimit || summaryConversation?.busy}
        onPress={createSummary} />
      <NebulaAction icon="x" label="Отмена" size="compact" onPress={() => setSummaryId(null)} />
    </BottomSheet>
    <ConversationHistorySheet visible={historyOpen} conversations={conversations} activeId={active?.id}
      onClose={() => setHistoryOpen(false)}
      onSelect={(c, rowId) => {
         setHistoryTarget(rowId ? { conversationId: c.id, rowId } : null);
         store.select(c.id);
         setHistoryOpen(false);
       }}
      onSummary={c => {store.select(c.id);setHistoryOpen(false);chooseDialogueSummary(c.id);}}
      onDelete={c => Alert.alert("Удалить диалог?", c.title, [
        { text: "Отмена", style: "cancel" },
        { text: "Удалить", style: "destructive", onPress: () => void store.remove(c.id) },
      ])}
      onNewChat={() => { store.create(); setHistoryOpen(false); }}
    />
  </KeyboardAvoidingView>;
}

