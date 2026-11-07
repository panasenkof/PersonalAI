import { AppendNoteAttachments } from "../media/AppendNoteAttachments";
import { useNavigation, usePreventRemove, useRoute } from "@react-navigation/native";
import type { RouteProp } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { useHeaderHeight } from "@react-navigation/elements";
import React, { useCallback, useEffect, useRef, useState } from "react";
import Feather from "@expo/vector-icons/Feather";
import { ActivityIndicator, Keyboard, KeyboardAvoidingView, Platform, Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useProfile } from "../profile/ProfileContext";
import { BottomSheet } from "../components/BottomSheet";
import { NebulaConfirmSheet } from "../components/NebulaConfirmSheet";
import { MarkdownText } from "../components/Markdown";
import { NoteAiEditor } from "../components/NoteAiEditor";
import { mayEditNoteText, type NoteDraft } from "../direct-agent/edit-note";
import { prepareAssistantReplyNote } from "../direct-agent/chat-response-note";
import { useDirectChat } from "../direct-agent/ChatContext";
import { MemoryCover } from "../media/MemoryCover";
import { VoiceInput } from "../components/VoiceInput";
import { localMemoryRepository } from "../local-memory/repository";
import type { SqliteMemoryRepository } from "../local-memory/repository";
import { MemoryConflictError } from "../local-memory/types";
import { noteHistoryLabel } from "../local-memory/note-actions";
import type { CollectionRecord, EntityRecord, ObservationRecord, RelationRecord, RevisionRecord } from "../local-memory/types";
import { localMemorySessionUnlocked, onLocalMemorySessionChange } from "../local-memory/storage";
import { memoryErrorMessage } from "../local-memory/errors";
import { ensureSections } from "../local-memory/sections";
import { MEMORY_KINDS, defaultKind } from "../local-memory/search-index";
import type { MemoryKind } from "../local-memory/search-index";
import { KIND_NAMES } from "../direct-agent/fact-tool";
import { scheduleIndexTerms } from "../direct-agent/enrich-runner";
import { scheduleVectors } from "../media/vector-runner";

/** «Маша, Мария Петровна» → ["Маша", "Мария Петровна"]. */
const splitNames = (text: string) => text.split(/[,;\n]/).map(n => n.trim()).filter(Boolean);
import type { RootStackParams } from "../navigation";
import { File } from "expo-file-system";
import { attachmentsForEntity, materializeAttachment, savedOriginalRevision, applyRecognitionCandidate } from "../media/attachments";
import type { Attachment } from "../media/attachments";
import type { ExtractionSegmentInput } from "../local-memory/extractions";
import { getRussianOcrStatus } from "../media/russian-ocr";
import { getWhisperStatus } from "../media/whisper";
import { mediaKind } from "../media/kinds";
import { extractMedia, officialAudioProvider } from "../media/extract";
import type { ImageExtractionMode } from "../media/extract";
import { maySendOriginalToProvider } from "../media/recognitionPolicy";
import { mediaConnections } from "../media/preferences";
import { AttachmentView } from "../media/AttachmentView";
import { attachmentPreviewKind } from "../media/attachmentPresentation";
import { VerifiedRelativeConversations } from "./VerifiedRelativeConversations";
import { MemoryTemporalTimeline } from "./MemoryTemporalTimeline";
import { useTheme } from "../theme";
import { nebulaRadii, nebulaSpacing, nebulaTouch, nebulaTypography } from "../design/nebula/tokens";
import { memoryNoteHasPhoto, memoryDisplayTitle, memoryNoteHasRecognizedText } from "../design/nebula/memoryNotePresentation";
import { NoteEditorSection } from "../design/nebula/NoteEditorSection";
import { NoteReadPreview } from "../design/nebula/NoteReadPreview";
import { SourceProvenanceCard } from "../design/nebula/SourceProvenanceCard";
import { describeSourceProvenance } from "../media/source-provenance";
import { NebulaAction } from "../design/nebula/components";
import { recognitionApprovalMatches } from "../design/nebula/recognitionApproval";

export function MemoryNoteScreen() {
  const t = useTheme(); const insets = useSafeAreaInsets(); const headerHeight = useHeaderHeight();
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParams>>();
  const route = useRoute<RouteProp<RootStackParams, "MemoryNote">>();
  const profile = useProfile();
  const { store: chatStore } = useDirectChat();
  const sourceAtOpen = useRef<{profile:string;body:string;kind:"assistant_reply"|"dialogue_summary"}|null>(null);
  const activeProfile = useRef(profile); activeProfile.current = profile;
  const extraction = useRef<AbortController | null>(null);
  const repeatRequest = useRef(0);
  // Keep consent ephemeral and tied to ONE original + one expected record
  // version. Never persist providers, files or secrets in navigation params.
  const repeatApproval = useRef<null | {
    profileId: string; noteId: string; recordVersion: number; attachmentId: string;
    start: () => void;
  }>(null);
  const [repeatMessage, setRepeatMessage] = useState<string | null>(null);
  useEffect(() => { const off = onLocalMemorySessionChange(unlocked => { if (!unlocked) { extraction.current?.abort(); repeatRequest.current++; repeatApproval.current = null; setRepeatMessage(null); setCandidate(null); setRepeatFiles([]); setConfirmKind(null); } }); return () => { off(); extraction.current?.abort(); }; }, []);
  const repository = useRef<SqliteMemoryRepository | null>(null); const alive = useRef(true); const pending = useRef(false);
  const loadSequence = useRef(0);
  const [editing, setEditing] = useState(!route.params?.entityId || route.params?.edit === true);
  const [aiField, setAiField] = useState<"body" | "extracted" | null>(null);
  const aiOpen = aiField !== null;
  const [noteMenu, setNoteMenu] = useState(false);
  const [confirmKind, setConfirmKind] = useState<"leave" | "agent" | null>(null);
  const [voiceActive, setVoiceActive] = useState(false);
  const [beforeAi, setBeforeAi] = useState<(NoteDraft & { extracted?: string }) | null>(null);
  const closeAi = useCallback(() => setAiField(null), []);
  const [selected, setSelected] = useState<EntityRecord | null>(null);
  const [collections, setCollections] = useState<CollectionRecord[]>([]);
  const [collectionId, setCollectionId] = useState(route.params?.collectionId);
  const [title, setTitle] = useState(""); const [body, setBody] = useState("");
  const [extractedText, setExtractedText] = useState("");
  // Temporary candidate only: no new persisted version/table or duplicate original.
  const [candidate, setCandidate] = useState<{
    text: string; attachment: Attachment; sourceVersion: string;
    recordVersion: number; producerId: string; producerRevision: string;
    segments?: ExtractionSegmentInput[];
  } | null>(null);
  const [repeatFiles, setRepeatFiles] = useState<Attachment[]>([]);
  const [allowAgent, setAllowAgent] = useState(false);
  const [kind, setKind] = useState<MemoryKind>("note"); const [names, setNames] = useState("");
  // Capture TextInput changes synchronously: Save may run before React commits
  // the final keystroke to the component state on a fast press.
  const namesForSave = useRef("");
  const [terms, setTerms] = useState(""); const [modelTerms, setModelTerms] = useState<string[]>([]);
  const [loading, setLoading] = useState(true); const [working, setBusy] = useState(false);
  const [attachmentBusy, setAttachmentBusy] = useState(false); const [attachmentDraft, setAttachmentDraft] = useState(false);
  const busy = working || attachmentBusy; const [error, setError] = useState("");
  const [retry, setRetry] = useState(0); const [leaving, setLeaving] = useState(false);
  const [sectionOpen, setSectionOpen] = useState(false); const [details, setDetails] = useState(false);
  const [metadataOpen, setMetadataOpen] = useState(false); const [fileContentOpen, setFileContentOpen] = useState(false);
const [termsOpen, setTermsOpen] = useState(false);
  const [keyboardOpen, setKeyboardOpen] = useState(false);
  const [history, setHistory] = useState<RevisionRecord[]>([]); const [events, setEvents] = useState<ObservationRecord[]>([]);
  const [relations, setRelations] = useState<RelationRecord[]>([]); const [related, setRelated] = useState<EntityRecord[]>([]);
  const [eventText, setEventText] = useState(""); const [linkOpen, setLinkOpen] = useState(false); const [linkSearch, setLinkSearch] = useState("");
  const baseline = useRef({ title: "", body: "", collectionId: route.params?.collectionId, kind: "note" as MemoryKind, names: "", terms: "" });
  const kindTouched = useRef(false);
  useEffect(() => {
    const show = Keyboard.addListener("keyboardDidShow", () => setKeyboardOpen(true));
    const hide = Keyboard.addListener("keyboardDidHide", () => setKeyboardOpen(false));
    return () => { show.remove(); hide.remove(); };
  }, []);
  const dirty = allowAgent || extractedText !== String(selected?.payload.extracted_text || "") || title !== baseline.current.title || body !== baseline.current.body || collectionId !== baseline.current.collectionId ||
    kind !== baseline.current.kind || splitNames(names).join(",") !== splitNames(baseline.current.names).join(",") ||
    terms.trim() !== baseline.current.terms.trim();
  usePreventRemove(!leaving && (busy || dirty || voiceActive || attachmentDraft), ({ data }) => {
    if (busy || voiceActive) { setError("Дождитесь завершения сохранения или диктовки."); return; }
    setConfirmKind("leave");
  });
  useEffect(() => { if (leaving) navigation.goBack(); }, [leaving, navigation]);
  useEffect(() => {
    const sequence = ++loadSequence.current;
    const stillCurrent = () => alive.current && loadSequence.current === sequence && activeProfile.current === profile;
    alive.current = true; setLoading(true); setAiField(null); setError(""); setMetadataOpen(false); setFileContentOpen(false); setTermsOpen(false); repeatRequest.current++; repeatApproval.current = null; setRepeatMessage(null); setCandidate(null); setRepeatFiles([]);
    void (async () => {
      if (!profile) throw new Error("profile_missing");
      const db = await localMemoryRepository(profile);
      const sections = await ensureSections(db);
      const note = route.params?.entityId ? await db.entity(route.params.entityId) : null;
      if (route.params?.entityId && !note) throw new Error("Запись не найдена.");
      if (route.params?.chatReply && route.params?.entityId) throw new Error("Нельзя одновременно открыть существующую запись и ответ ИИ.");
      // Resolve from the encrypted store AFTER opening the user profile.
      // Never copy the private response body into navigation parameters.
      const fromChat = route.params?.chatReply
        ? prepareAssistantReplyNote(chatStore.getSnapshot().conversations, route.params.chatReply)
        : null;
      if (!stillCurrent()) return;
      sourceAtOpen.current = fromChat ? {profile,body:fromChat.body,kind:fromChat.provenance.kind} : null;
      repository.current = db; setCollections(sections); setSelected(note); setExtractedText(String(note?.payload.extracted_text || "")); setAllowAgent(false);
      const initialTitle = note?.title || fromChat?.title || "";
      const initialBody = note ? String(note.payload.body || "") : fromChat?.body || "";
      const initialCollection = note?.collection_id || route.params?.collectionId ||
        (fromChat ? sections.find(c => c.slug === "notes")?.id : undefined);
      const initialKind = note?.kind || defaultKind(sections.find(c => c.id === initialCollection)?.slug);
      const initialNames = note ? (await db.aliases(note.id)).join(", ") : "";
      const indexTerms = note ? await db.indexTerms(note.id) : [];
      const initialTerms = (indexTerms.find(x => x.source === "user")?.terms || []).join(", ");
      if (!stillCurrent()) return;
      baseline.current = { title: initialTitle, body: initialBody, collectionId: initialCollection, kind: initialKind, names: initialNames, terms: initialTerms };
      setTerms(initialTerms); setModelTerms(indexTerms.filter(x => x.source.startsWith("model:")).flatMap(x => x.terms));
      kindTouched.current = false;
      setTitle(initialTitle); setBody(initialBody); setCollectionId(initialCollection); setKind(initialKind); namesForSave.current = initialNames; setNames(initialNames);
    })().catch(e => { if (stillCurrent()) setError(memoryErrorMessage(e)); }).finally(() => { if (stillCurrent()) setLoading(false); });
    return () => { loadSequence.current++; alive.current = false; repository.current = null; };
  }, [profile, chatStore, route.params?.entityId, route.params?.collectionId,
    route.params?.chatReply?.conversationId, route.params?.chatReply?.rowId, retry]);
  const run = useCallback(async (work: (db: SqliteMemoryRepository) => Promise<void>) => {
    if (!repository.current || pending.current) return;
    pending.current = true; setBusy(true); setError("");
    try { await work(repository.current); }
    catch (e) { if (alive.current) setError(e instanceof MemoryConflictError ? "Запись изменилась. Откройте её заново перед сохранением." : memoryErrorMessage(e)); }
    finally { pending.current = false; if (alive.current) setBusy(false); }
  }, []);
  const save = () => run(async db => {
    if (voiceActive) throw new Error("Завершите диктовку перед сохранением.");
    if (!title.trim() && !body.trim()) throw new Error("Введите заголовок или текст записи.");
    let collection = collectionId;
    if (!collection) {
      const all = await db.listCollections();
      let notes = all.find(c => c.slug === "notes");
      if (!notes) notes = await db.createCollection({ name: "Заметки", slug: "notes", sensitivity: "standard" });
      collection = notes.id;
    }
    if (allowAgent) {
      const notes = (await ensureSections(db)).find(c => c.slug === "notes" && c.sensitivity === "standard");
      if (!notes) throw new Error("Для доступа агенту нужен обычный раздел «Заметки».");
      collection = notes.id;
    }
    // Re-check source identity and current profile before writing a source-backed
    // copy. The existing SQLCipher writer is the only note write path.
    const fromChat = route.params?.chatReply && !selected
      ? prepareAssistantReplyNote(chatStore.getSnapshot().conversations, route.params.chatReply)
      : null;
    if (route.params?.chatReply && !selected &&
      (activeProfile.current !== profile || sourceAtOpen.current?.profile !== profile ||
       !fromChat || sourceAtOpen.current?.body !== fromChat.body))
      throw new Error("Исходный ответ или профиль изменился. Откройте ответ из диалога заново.");
    const finalTitle = title.trim() || body.trim().split("\n")[0].slice(0, 80);
    const payload = { ...selected?.payload, type: "note", title: finalTitle,
      // H-SAVE1a preserves Markdown and its trailing newlines exactly;
      // ordinary hand-written notes retain the established trim behavior.
      body: fromChat ? body : body.trim(), extracted_text: extractedText.trim(),
      ...(fromChat ? { chat_origin: { ...fromChat.provenance, label: fromChat.provenance.kind === "dialogue_summary" ? "Итог диалога" : "Ответ ИИ",
        savedAt: new Date().toISOString() } } : {}) };
    const base = baseline.current;
    const cardFields = { kind, aliases: splitNames(namesForSave.current), userTerms: splitNames(terms) };
    if (selected) {
      const textChanged = allowAgent || extractedText !== String(selected.payload.extracted_text || "") || title !== base.title || body !== base.body || collectionId !== base.collectionId;
      const metadataChanged = kind !== base.kind || cardFields.aliases.join(",") !== splitNames(base.names).join(",") || terms.trim() !== base.terms.trim();
      if (textChanged || metadataChanged) {
        // One durable entity revision, aliases and user-owned terms. Failure rolls back all.
        await db.reviseEntity(selected.id, selected.record_version, payload,
          allowAgent ? "Разрешён доступ агенту" : beforeAi ? "Подтверждённая правка ИИ" : "Редактирование записи",
          collection, allowAgent, undefined, cardFields);
      }
    } else {
      await db.createEntity({ collection_id: collection, domain: "notes", title: finalTitle, payload, kind,
        sensitivity: "inherit", source_kind: "user", source_ref: "device" }, undefined, cardFields);
    }
    if (profile) { scheduleIndexTerms(profile); scheduleVectors(profile); }
    if (alive.current) setLeaving(true);
  });
  const openPhotoOriginal = () => {
    if (!selected || !profile || busy || !localMemorySessionUnlocked()) return;
    const noteId = selected.id;
    void attachmentsForEntity(profile, noteId).then(files => {
      if (!alive.current || activeProfile.current !== profile || !localMemorySessionUnlocked()) return;
      const image = files.find(file => attachmentPreviewKind(file) === "image");
      if (image) navigation.push("MemoryNote", { entityId: noteId, photoAttachmentId: image.id });
      else setError("Оригинал фотографии не найден.");
    }).catch(e => { if (alive.current && activeProfile.current === profile) setError(memoryErrorMessage(e)); });
  };
  const rerunAttachment = (attachment: Attachment) => {
    if (!selected || !profile || activeProfile.current !== profile || busy || dirty || selected.record_status !== "active") return;
    // The second original wins even if an earlier preferences read resolves later.
    const request = ++repeatRequest.current;
    repeatApproval.current = null; setRepeatMessage(null);
    const note = selected;
    let kind: ReturnType<typeof mediaKind>;
    try { kind = mediaKind({uri:"file:///original",name:attachment.name,mimeType:attachment.mime}); }
    catch { setError("Распознавание этого формата недоступно."); return; }
    const localOcr = getRussianOcrStatus().ready;
    const remoteAllowed = maySendOriginalToProvider(note.sensitivity,
      collections.find(c => c.id === note.collection_id)?.sensitivity);
    const mode: ImageExtractionMode = (kind === "document" || kind === "image") && localOcr ? "offline-ocr" :
      kind === "image" ? "document-text" : "describe";
    void mediaConnections(profile).then(settings => {
      if (!alive.current || activeProfile.current !== profile || request !== repeatRequest.current) return;
      const localSpeech = settings.fileAsrMode === "device" && getWhisperStatus().state === "ready";
      if (!remoteAllowed && (kind === "video" || (kind === "image" && !localOcr) ||
          (kind === "audio" && !localSpeech))) {
        setError("Закрытая запись: требуется локальная модель OCR или Whisper. Оригинал не отправлен внешнему сервису."); return;
      }
      if (kind === "audio" && settings.fileAsrMode === "device" && !localSpeech) {
        setError("Локальный Whisper не установлен. Выберите онлайн или скачайте модель."); return;
      }
      if (kind === "audio" && settings.fileAsrMode === "online" && !officialAudioProvider(settings.speech)) {
        setError("Это подключение не поддерживает онлайн-распознавание файлов. Выберите официальный OpenAI."); return;
      }
      const destination = kind === "audio" ? localSpeech ? "Локальный Whisper" :
        settings.fileAsrMode === "device" ? "Локальный Whisper" : "внешний сервис речи" :
        (kind === "image" || kind === "document") && localOcr ? "локальное русское OCR" :
        kind === "document" || kind === "text" ? "локальный текстовый разбор" : "внешняя модель";
      const remote = destination.startsWith("внешн");
      const provider = kind === "audio" ? settings.speech : settings.vision;
      const name = remote ? "Провайдер: " + provider.provider + ", модель: " +
        String(kind === "audio" ? provider.transcriptionModel || "gpt-transcribe" : provider.model) :
        "Выполняется на телефоне";
      const message = "Файл: " + attachment.name + "\nОбработка: " + destination + "\n" + name +
        (remote ? "\nФайл будет передан указанному провайдеру только после подтверждения." :
          "\nОригинал не будет отправлен провайдеру.") +
        "\nПрежний текст не изменится до вашего подтверждения.";
      repeatApproval.current = {
        profileId: profile, noteId: note.id, recordVersion: note.record_version,
        attachmentId: attachment.id,
        start: () => void run(async db => {
          if (!profile || activeProfile.current !== profile) throw new Error("profile_missing");
          setCandidate(null); setRepeatFiles([]);
          const current = await db.entity(note.id);
          if (!current || current.record_version !== note.record_version ||
              current.record_status !== "active") throw new MemoryConflictError("stale_memory_version");
          const aborter = new AbortController();
          extraction.current = aborter;
          let uri = "";
          try {
            uri = await materializeAttachment(profile,attachment,aborter.signal);
            const sourceVersion = await savedOriginalRevision(profile,attachment);
            const beforeUpload = await db.entity(note.id);
            const permissions = await db.listCollections();
            const allowedNow = maySendOriginalToProvider(beforeUpload?.sensitivity,
              permissions.find(c => c.id === beforeUpload?.collection_id)?.sensitivity);
            if (!beforeUpload || beforeUpload.record_version !== note.record_version ||
                beforeUpload.record_status !== "active" || beforeUpload.collection_id !== note.collection_id ||
                (remoteAllowed && !allowedNow)) throw new MemoryConflictError("stale_memory_version");
            if (kind === "audio" && localSpeech && getWhisperStatus().state !== "ready") {
              throw new Error("Локальный Whisper больше не готов. Повторите действие после проверки модели.");
            }
            // Local paths never receive automatic cloud fallback on a race.
            const approveUpload = remote && remoteAllowed && allowedNow;
            const segments: ExtractionSegmentInput[] = [];
            const recognition = await extractMedia({uri,name:attachment.name,mimeType:attachment.mime},
              settings.vision,approveUpload,aborter.signal,undefined,{...settings.speech,fileAsrMode:settings.fileAsrMode},
              received => { segments.splice(0,segments.length,...received); },undefined,mode);
            if (aborter.signal.aborted || !alive.current || activeProfile.current !== profile) return;
            const providerId = destination === "Локальный Whisper" ? "local-whisper" :
              destination === "локальное русское OCR" ? "android-tesseract-5-rus" :
              destination === "локальный текстовый разбор" ? "local-document-text" :
              kind === "audio" ? "openai:" + String(settings.speech.transcriptionModel || "gpt-transcribe") :
              String(settings.vision.model || settings.vision.provider);
            setCandidate({
              text:recognition,attachment,sourceVersion,recordVersion:note.record_version,
              producerId:providerId,producerRevision:"user-repeat-v1",
              ...(segments.length ? {segments} : {}),
            });
          } finally {
            if (extraction.current === aborter) extraction.current = null;
            if (uri) { try { const file = new File(uri); if (file.exists) file.delete(); } catch { /* Lock may purge cache first. */ } }
          }
        }),
      };
      setRepeatMessage(message);
    }).catch(e => { if (alive.current && request === repeatRequest.current) setError(memoryErrorMessage(e)); });
  };
  const acceptCandidate = () => void run(async db => {
    if (!profile || activeProfile.current !== profile || !selected || !candidate) return;
    if (dirty || candidate.recordVersion !== selected.record_version)
      throw new MemoryConflictError("stale_memory_version");
    const updated = await applyRecognitionCandidate(db,{
      note:selected,attachment:candidate.attachment,
      expectedSourceVersion:candidate.sourceVersion,text:candidate.text,
      producerId:candidate.producerId,producerRevision:candidate.producerRevision,
      segments:candidate.segments,
    });
    if (alive.current) {
      setSelected(updated); setExtractedText(String(updated.payload.extracted_text || "")); setCandidate(null);
      scheduleIndexTerms(profile); scheduleVectors(profile);
    }
  });
  const loadDetails = () => run(async db => {
    if (!selected) return;
    const [revisions, observations, links] = await Promise.all([db.revisions("entity", selected.id), db.observations(selected.id), db.relationsForEntity(selected.id)]);
    const others = await Promise.all(links.map(r => db.entity(r.source_entity_id === selected.id ? r.target_entity_id : r.source_entity_id)));
    if (alive.current) { setHistory(revisions); setEvents(observations); setRelations(links); setRelated(others.filter((e): e is EntityRecord => Boolean(e))); setDetails(true); }
  });
  useEffect(() => {
    if (!linkOpen || !repository.current) return;
    let cancelled = false;
    const timer = setTimeout(() => { void repository.current?.searchNotes(linkSearch, 30).then(items => { if (!cancelled) setRelated(items); }).catch(e => { if (!cancelled) setError(memoryErrorMessage(e)); }); }, 200);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [linkOpen, linkSearch]);
  const field = { borderWidth: 1, borderColor: t.line, borderRadius: nebulaRadii.field, backgroundColor: t.panel, minHeight: nebulaTouch.minimum, padding: nebulaSpacing.md, color: t.text, ...nebulaTypography.body };
  const canEditWithAi = Boolean(body.trim());
  const saveDisabled = busy || voiceActive || (editing && !title.trim() && !body.trim());
  const readingTitle = selected ? memoryDisplayTitle({ ...selected, title, payload: { ...selected.payload, body } }) : title;
  // A persisted note owns the same provenance fields as its import draft.
  // Old notes without coverage remain explicitly "unknown", never upgraded.
  const sourceDescription = selected ? describeSourceProvenance({
    sourceUrl:selected.payload.source_url,coverage:selected.payload.source_text_coverage,
    sourceRef:selected.source_ref,
    publicationDate:selected.payload.source_publication_date,
    publicationEvidence:selected.payload.source_publication_evidence,
    publicationAttribute:selected.payload.source_publication_attribute,
  }) : null;
  const hasRecognizedText = memoryNoteHasRecognizedText(selected, extractedText);
  const button = { minHeight: nebulaTouch.minimum, borderRadius: nebulaRadii.field, justifyContent: "center" as const, padding: nebulaSpacing.md };
  return <KeyboardAvoidingView style={{ flex: 1, backgroundColor: t.bg }} behavior={Platform.OS === "ios" ? "padding" : "height"} keyboardVerticalOffset={Platform.OS === "ios" ? headerHeight : 0}>
    <ScrollView testID="note-editor-scroll" keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag" contentContainerStyle={{ padding: nebulaSpacing.md, paddingBottom: Math.max(insets.bottom, 24) + nebulaSpacing.xl, gap: nebulaSpacing.sm }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: nebulaSpacing.sm }}>
        <Text accessibilityRole="header" style={{ flex: 1, color: t.text, ...(editing ? nebulaTypography.heading : nebulaTypography.label), fontWeight: "600" }}>{editing ? selected ? "Редактирование" : "Новая запись" : collections.find(c => c.id === collectionId)?.name || "Заметка"}</Text>
        {selected && !editing && selected.record_status !== "trashed" ? <Pressable testID="note-edit-action" accessibilityRole="button" accessibilityLabel="Редактировать запись" disabled={busy} onPress={() => setEditing(true)}
          style={{ minHeight: nebulaTouch.minimum, minWidth: nebulaTouch.minimum, alignItems: "center", justifyContent: "center", borderRadius: nebulaRadii.field, backgroundColor: t.soft }}>
          <Feather name="edit-3" size={21} color={t.secondary} />
        </Pressable> : null}
        {selected && !editing ? <Pressable accessibilityRole="button" accessibilityLabel="Меню записи" style={{ ...button, minWidth: nebulaTouch.minimum, alignItems: "center" }} onPress={() => setNoteMenu(true)}><Feather name="more-vertical" size={22} color={t.text} /></Pressable> : null}
        {!loading && dirty ? <Text accessibilityLabel="Несохранённые изменения" style={{ color: t.muted, ...nebulaTypography.label }}>Не сохранено</Text> : null}
      </View>
      {!loading && repository.current && selected && !editing && selected.record_status === "trashed" ? <View testID="note-quick-actions"
        style={{ flexDirection: "row", flexWrap: "wrap", gap: nebulaSpacing.sm }}>
        <NebulaAction
          icon="rotate-ccw" label="Восстановить" accessibilityLabel="Восстановить запись из корзины" disabled={busy}
          onPress={() => void run(async db => {
            // The existing versioned writer checks ACL and record_version atomically.
            await db.changeNotes("restore", [selected], undefined);
            if (profile) scheduleVectors(profile);
            if (alive.current) setLeaving(true);
          })} />
      </View> : null}
      {loading ? <ActivityIndicator accessibilityLabel="Загрузка записи" /> : null}
      {!loading && route.params?.chatReply && !selected ? <Text style={{color:t.muted,...nebulaTypography.label}}>
        {sourceAtOpen.current?.kind === "dialogue_summary"
          ? "Итог диалога · проверьте полноту и исправьте текст перед сохранением. Запись в память только по кнопке «Сохранить»."
          : "Черновик из ответа ИИ · текст и разметку можно изменить. Сохранение выполняется на телефоне без запроса к модели."}
      </Text> : null}
      {!loading && selected?.payload.chat_origin && typeof selected.payload.chat_origin==="object" ? <Text style={{color:t.muted,...nebulaTypography.label}}>
        {((selected.payload.chat_origin as {kind?:string}).kind === "dialogue_summary")
          ? "Источник: созданный ИИ итог диалога. Сведения требуют проверки, оригиналы вложений не включены."
          : "Источник: ответ ИИ. Это сохранённый текст помощника, а не подтверждённый факт."}
      </Text> : null}

      {!loading && repository.current ? <>
        {!editing ? <>
          {selected && profile && route.params?.photoAttachmentId ? <AttachmentView key={selected.record_version + ":" + (route.params?.verifiedOriginal?.attachmentId || route.params?.photoAttachmentId || "")} profile={profile} entityId={selected.id} verifiedOriginal={route.params?.verifiedOriginal} photoAttachmentId={route.params?.photoAttachmentId} onRecognize={!editing && !busy && selected.record_status === "active" ? rerunAttachment : undefined} /> : null}
          {profile && selected && !route.params?.verifiedOriginal && !route.params?.photoAttachmentId && memoryNoteHasPhoto(selected) ? <Pressable
            testID="note-photo-open" accessibilityRole="button" accessibilityLabel="Открыть оригинал фотографии"
            disabled={busy} onPress={openPhotoOriginal} style={{ borderRadius: nebulaRadii.card, overflow: "hidden" }}>
            <MemoryCover profile={profile} entityId={selected.id} height={210} label={readingTitle} />
          </Pressable> : null}
          <Text accessibilityRole="header" selectable style={{ color: t.text, fontSize: 23, lineHeight: 31, fontWeight: "700" }}>{readingTitle || "Без названия"}</Text>
          {body && body.trim() !== readingTitle ? <NoteReadPreview
            testID="note-read-body" text={body} fullTitle="Полный текст заметки"
            actionLabel="Читать полностью" maxLines={6} /> : null}
          {body.trim() ? <NebulaAction icon="zap" label="Изменить с ИИ" size="compact" accessibilityLabel="Изменить заметку с ИИ"
            disabled={busy || !canEditWithAi} onPress={() => setAiField("body")} /> : null}
          {profile && selected?.kind === "person" && selected.record_status === "active" ? <VerifiedRelativeConversations key={profile + ":" + selected.id + ":" + selected.record_version} profile={profile} personId={selected.id} personTitle={readingTitle} /> : null}
          {profile && selected?.kind === "person" && selected.record_status === "active" &&
            ["standard","inherit"].includes(selected.sensitivity) &&
            collections.some(c=>c.id===selected.collection_id&&c.sensitivity==="standard") ?
            <MemoryTemporalTimeline key={profile + ":" + selected.id + ":" + selected.record_version}
              profile={profile} subjectId={selected.id} collectionId={selected.collection_id}/> : null}
          {selected && profile && !route.params?.photoAttachmentId ? <AttachmentView key={selected.record_version + ":" + (route.params?.verifiedOriginal?.attachmentId || route.params?.photoAttachmentId || "")} profile={profile} entityId={selected.id} verifiedOriginal={route.params?.verifiedOriginal} photoAttachmentId={route.params?.photoAttachmentId} collapsedByDefault={!route.params?.verifiedOriginal && memoryNoteHasPhoto(selected)} onRecognize={!editing && !busy && selected.record_status === "active" ? rerunAttachment : undefined} /> : null}
          {selected && profile && ["active", "archived"].includes(selected.record_status) ? <AppendNoteAttachments
            key={profile + selected.id} profile={profile} note={selected} disabled={working || dirty || voiceActive}
            onBusyChange={setAttachmentBusy} onDraftChange={setAttachmentDraft}
            onSaved={updated => { setSelected(updated); setBeforeAi(null); scheduleVectors(profile); }} /> : null}
          {extractedText && extractedText.trim() !== body.trim() ? <NoteReadPreview
            testID="note-extracted-summary" text={extractedText}
            heading="Текст из файла" fullTitle="Полный распознанный текст"
            actionLabel="Читать текст файла" maxLines={4} /> : null}
          {extractedText.trim() ? <NebulaAction icon="zap" label="Улучшить текст файла с ИИ" size="compact"
            disabled={busy} onPress={() => setAiField("extracted")} /> : null}
          {sourceDescription ? <SourceProvenanceCard source={sourceDescription} onOpenError={()=>setError("Не удалось открыть источник.")}/> : null}
        </> : <>
        <TextInput testID="note-title-input" accessibilityLabel="Заголовок заметки" value={title} onChangeText={value => { setBeforeAi(null); setTitle(value); }} editable={!busy} maxLength={160} placeholder="Заголовок — необязательно" placeholderTextColor={t.muted} style={field} />
        {selected && profile && !route.params?.photoAttachmentId && memoryNoteHasPhoto(selected) ? <Pressable
          accessibilityRole="button" accessibilityLabel="Открыть оригинал фотографии"
          disabled={busy} onPress={openPhotoOriginal} style={{ borderRadius: nebulaRadii.card, overflow: "hidden" }}>
          <MemoryCover profile={profile} entityId={selected.id} height={132} label={readingTitle} />
        </Pressable> : null}
        {selected && profile && ["active", "archived"].includes(selected.record_status) ? <AppendNoteAttachments
          key={profile + selected.id} profile={profile} note={selected} disabled={working || dirty || voiceActive}
          onBusyChange={setAttachmentBusy} onDraftChange={setAttachmentDraft}
          onSaved={updated => { setSelected(updated); setBeforeAi(null); scheduleVectors(profile); }} /> : null}
        <TextInput testID="note-body-input" accessibilityLabel="Текст заметки" multiline value={body} onChangeText={value => { setBeforeAi(null); setBody(value); }} editable={!busy && !voiceActive} placeholder="Что нужно запомнить?" placeholderTextColor={t.muted} style={{ ...field, minHeight: 200, textAlignVertical: "top", lineHeight: 23 }} />
        {!body && extractedText ? <NebulaAction icon="file-text" label="Вставить распознанный текст" size="compact"
          onPress={() => setBody(extractedText)} /> : null}
        <View style={{ flexDirection: "row", alignItems: "center", flexWrap: "wrap", gap: nebulaSpacing.sm }}>
          <VoiceInput value={body} onChange={value => { setBeforeAi(null); setBody(value); }} maxLength={60000}
            disabled={busy || aiOpen} onActiveChange={setVoiceActive} onError={setError} />
          <Text style={{ color: t.muted, marginRight: nebulaSpacing.sm }}>Диктовка</Text>
          <Pressable testID="note-ai-edit-action" accessibilityRole="button" accessibilityLabel="Изменить заметку с ИИ"
            disabled={busy || voiceActive || !canEditWithAi} accessibilityState={{ disabled: busy || voiceActive || !canEditWithAi }}
            onPress={() => { Keyboard.dismiss(); setAiField("body"); }}
            style={{ flexDirection: "row", alignItems: "center", gap: nebulaSpacing.xs, minHeight: nebulaTouch.minimum,
              paddingHorizontal: nebulaSpacing.sm, borderRadius: nebulaRadii.field, backgroundColor: t.soft,
              opacity: canEditWithAi ? 1 : .45 }}>
            <Feather name="zap" size={19} color={t.secondary} />
            <Text style={{ color: t.secondary, fontWeight: "600" }}>Улучшить</Text>
          </Pressable>
        </View>

        <Pressable accessibilityRole="button" accessibilityLabel="Выбрать раздел записи" onPress={() => setSectionOpen(true)}
          style={{ ...button, backgroundColor: t.soft, flexDirection: "row", alignItems: "center", gap: nebulaSpacing.xs }}>
          <Feather name="folder" size={18} color={t.secondary} />
          <Text numberOfLines={2} style={{ flex: 1, color: t.secondary, ...nebulaTypography.body }}>Раздел: {collections.find(c => c.id === collectionId)?.name || "Заметки"}</Text>
          <Feather name="chevron-down" size={20} color={t.secondary} />
        </Pressable>
        {beforeAi ? <NebulaAction icon="rotate-ccw" label="Отменить правку ИИ" size="compact"
          accessibilityLabel="Вернуть текст до правки ИИ"
          onPress={() => { if (beforeAi.extracted !== undefined) setExtractedText(beforeAi.extracted); else { setTitle(beforeAi.title); setBody(beforeAi.body); } setBeforeAi(null); }} /> : null}
        <NoteEditorSection testID="note-metadata-toggle" title="Дополнительно" summary="Тип, другие названия и поиск"
          expanded={metadataOpen} onToggle={() => { Keyboard.dismiss(); setMetadataOpen(open => !open); }}>
        <Text style={{ color: t.muted, fontSize: 12 }}>Тип записи</Text>
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
          {MEMORY_KINDS.map(k => { const chosen = k === kind; return <Pressable key={k} accessibilityRole="button" accessibilityLabel={"Тип записи: " + KIND_NAMES[k]}
            accessibilityState={{ selected: chosen }} aria-selected={chosen} disabled={busy} onPress={() => { kindTouched.current = true; setKind(k); }}
            style={{ minHeight: nebulaTouch.minimum, paddingHorizontal: nebulaSpacing.sm, justifyContent: "center", borderRadius: nebulaRadii.chip, borderWidth: 1, borderColor: chosen ? t.accent : t.line, backgroundColor: chosen ? t.soft : t.panel }}>
            <Text style={{ color: chosen ? t.secondary : t.text, fontSize: 13 }}>{KIND_NAMES[k]}</Text></Pressable>; })}
        </View>
        <TextInput accessibilityLabel="Другие имена и прозвища" value={names} onChangeText={next => { namesForSave.current = next; setNames(next); }} editable={!busy} maxLength={600}
          placeholder={kind === "person" ? "Другие имена через запятую: Маша, Мария Петровна" : "Другие названия через запятую (по желанию)"} placeholderTextColor={t.muted} style={field} />
        <Text style={{ color: t.muted, fontSize: 12 }}>Необязательно. По этим именам запись тоже находится в поиске.</Text>
        {termsOpen || terms.trim() ? <TextInput accessibilityLabel="Слова для поиска" value={terms} onChangeText={setTerms} editable={!busy} maxLength={600}
          placeholder="Слова для поиска через запятую: автомобиль, шкода" placeholderTextColor={t.muted} style={field} /> :
          <NebulaAction icon="plus" label="Добавить слова для поиска" size="compact" disabled={busy} onPress={() => setTermsOpen(true)} />}
        {modelTerms.length ? <Text accessibilityLabel="Слова, подобранные моделью" style={{ color: t.muted, fontSize: 12, lineHeight: 18 }}>Поисковые слова ИИ: {modelTerms.join(", ")}. Пересчитываются после правки текста.</Text> : null}
        </NoteEditorSection>
        {selected && hasRecognizedText ? <NoteEditorSection
          testID="note-extracted-toggle" title="Текст из файла"
          summary="Распознанное содержимое участвует в поиске по памяти"
          expanded={fileContentOpen} onToggle={() => { Keyboard.dismiss(); setFileContentOpen(open => !open); }}>
          <Text style={{ color: t.muted, ...nebulaTypography.label }}>Проверьте распознанный текст. Он индексируется вместе с записью.</Text>
          <TextInput accessibilityLabel="Распознанное содержимое файла" multiline scrollEnabled
            editable={!busy} value={extractedText} onChangeText={value => {setBeforeAi(null); setExtractedText(value);}} maxLength={60_000}
            style={{ ...field, height: 184, maxHeight: 220, textAlignVertical: "top" }} />
          {extractedText.trim() ? <NebulaAction icon="zap" label="Улучшить текст файла с ИИ" size="compact" disabled={busy} onPress={() => setAiField("extracted")} /> : null}
          <Pressable disabled={busy || dirty || selected.record_status !== "active"} accessibilityRole="button"
            accessibilityLabel="Распознать сохранённый файл заново"
            style={{...button,borderWidth:1,borderColor:t.secondary,backgroundColor:t.panel}}
            onPress={() => {
              if (!profile) return;
              setError("");
              void attachmentsForEntity(profile,selected.id).then(files => {
                if (!alive.current || activeProfile.current !== profile) return;
                if (!files.length) setError("Оригиналы не найдены.");
                else if (files.length === 1) rerunAttachment(files[0]);
                else setRepeatFiles(files);
              }).catch(e => { if (alive.current) setError(memoryErrorMessage(e)); });
            }}>
            <Text style={{color:t.secondary,fontWeight:"700"}}>Распознать заново</Text>
          </Pressable>
          {dirty ? <Text style={{color:t.muted}}>Сначала сохраните несохранённые изменения, чтобы не потерять ручные правки.</Text> : null}
          {repeatFiles.length > 1 ? <View style={{gap:nebulaSpacing.xs}}>
            <Text style={{color:t.muted}}>Выберите конкретный оригинал:</Text>
            {repeatFiles.map(file => <Pressable key={file.id} accessibilityRole="button"
              accessibilityLabel={"Распознать заново " + file.name}
              onPress={() => rerunAttachment(file)}
              style={{...button,backgroundColor:t.soft}}>
              <Text numberOfLines={2} style={{color:t.secondary}}>{file.name}</Text>
            </Pressable>)}
            <NebulaAction icon="x" label="Отмена выбора" size="compact" onPress={()=>setRepeatFiles([])} />
          </View> : null}
        </NoteEditorSection> : null}
        {selected && (selected.sensitivity === "sensitive" || collections.find(c => c.id === selected.collection_id)?.sensitivity !== "standard") ? <>
          <Text style={{ color: t.muted }}>Запись закрыта для агента. Локальная векторизация доступна, но текст не передаётся модели.</Text>
          <NebulaAction icon="shield" label={allowAgent ? "Доступ будет разрешён после сохранения" : "Разрешить агенту находить запись"}
            disabled={busy} onPress={() => setConfirmKind("agent")} />
        </> : null}
        {sourceDescription ? <SourceProvenanceCard source={sourceDescription} onOpenError={()=>setError("Не удалось открыть источник.")}/> : null}
        {Array.isArray(selected?.payload.merged_sources) ? <View><Text style={{ color: t.muted }}>Исходные записи, их даты и связи сохранены:</Text>{(selected.payload.merged_sources as { id: string; title: string }[]).filter(n => n.id !== selected.id).map(n => <Pressable key={n.id} style={button} onPress={() => navigation.push("MemoryNote", { entityId: n.id })}><Text style={{ color: t.secondary }}>{n.title || "Исходная запись"}</Text></Pressable>)}</View> : null}
        {selected && profile && !route.params?.photoAttachmentId ? <AttachmentView key={selected.record_version + ":" + (route.params?.verifiedOriginal?.attachmentId || route.params?.photoAttachmentId || "")} profile={profile} entityId={selected.id} verifiedOriginal={route.params?.verifiedOriginal} photoAttachmentId={route.params?.photoAttachmentId} collapsedByDefault={!route.params?.verifiedOriginal && memoryNoteHasPhoto(selected)} /> : null}
        {selected ? <>
          {selected.record_status === "trashed" ? <Text style={{ color: t.muted }}>Запись в корзине. Восстановите её на странице памяти, чтобы агент снова мог её находить.</Text> : null}
          <Pressable accessibilityRole="button" accessibilityLabel="История, события и связи" accessibilityState={{ expanded: details }} onPress={() => details ? setDetails(false) : void loadDetails()} style={{ ...button, backgroundColor: t.soft }}><Text style={{ color: t.text }}>История, события и связи {details ? "⌃" : "⌄"}</Text></Pressable>
          {details ? <View style={{ gap: 12, padding: 16, borderWidth: 1, borderColor: t.line, borderRadius: 20 }}>
            <Text style={{ color: t.text, fontWeight: "700" }}>История изменений · версия {selected.record_version}</Text>
            {history.map(r => <Text key={r.id} style={{ color: t.muted }}>{new Date(r.created_at).toLocaleDateString()} · {noteHistoryLabel(r.reason)}</Text>)}
            <Text style={{ color: t.text, fontWeight: "700" }}>События</Text>
            {events.map(e => <Text key={e.id} style={{ color: t.muted }}>{new Date(e.occurred_at).toLocaleDateString()} · {String(e.payload.text || e.kind)}</Text>)}
            <TextInput accessibilityLabel="Новое событие" value={eventText} onChangeText={setEventText} placeholder="Что произошло?" placeholderTextColor={t.muted} style={field} />
            <NebulaAction icon="plus" label="Добавить событие" size="compact" disabled={busy || !eventText.trim()}
              onPress={() => void run(async db => {
              await db.createObservation({ entity_id: selected.id, kind: "note_event", occurred_at: new Date().toISOString(), payload: { text: eventText.trim() }, sensitivity: "inherit", source_kind: "user", source_ref: "device" });
              if (alive.current) { setEvents(await db.observations(selected.id)); setEventText(""); }
            })} />
            <Text style={{ color: t.text, fontWeight: "700" }}>Связанные записи ({relations.length})</Text>
            {relations.map(r => { const other = related.find(e => e.id === (r.source_entity_id === selected.id ? r.target_entity_id : r.source_entity_id));
              return <Text key={r.id} style={{ color: t.muted }}>{(other?.title || "Другая запись") + (other?.kind ? " · " + KIND_NAMES[other.kind] : "") + (r.kind === "about" ? (r.source_entity_id === selected.id ? " — о ком запись" : " — запись об этом человеке") : "")}</Text>; })}
            <NebulaAction icon="link-2" label="Связать с другой записью" size="compact"
              onPress={() => setLinkOpen(true)} />
          </View> : null}
          <NebulaAction icon="archive"
            accessibilityLabel={selected.record_status === "archived" ? "Вернуть запись из архива" : "Архивировать запись"}
            label={selected.record_status === "archived" ? "Вернуть из архива" : "Перенести в архив"}
            disabled={busy || dirty || !["active", "archived"].includes(selected.record_status)}
            onPress={() => void run(async db => {
              await db.setEntityStatus(selected.id, selected.record_version, selected.record_status === "archived" ? "active" : "archived");
              if (alive.current) setLeaving(true);
            })} />
        </> : null}
        </>}

      </> : null}
      {error ? <Text accessibilityRole="alert" style={{ color: t.err }}>{error}</Text> : null}
      {!loading && !repository.current ? <NebulaAction icon="refresh-cw"
        label="Повторить загрузку" onPress={() => setRetry(n => n + 1)} /> : null}
    </ScrollView>
    {!loading && repository.current && editing ? <View style={{ paddingHorizontal: nebulaSpacing.md, paddingTop: nebulaSpacing.xs, paddingBottom: keyboardOpen ? nebulaSpacing.xs : insets.bottom + nebulaSpacing.xs, borderTopWidth: 1, borderTopColor: t.line, backgroundColor: t.bg }}>
      <Pressable testID="note-save-button" accessibilityRole="button" accessibilityLabel="Сохранить запись" disabled={saveDisabled} accessibilityState={{ disabled: saveDisabled }}
        onPress={() => { Keyboard.dismiss(); void save(); }}
        style={{ ...button, backgroundColor: t.accent, opacity: saveDisabled ? 0.45 : 1, alignItems: "center" }}>
        <Text style={{ color: "#fff", fontWeight: "700" }}>{busy ? "Сохранение…" : "Сохранить запись"}</Text>
      </Pressable>
    </View> : null}
    {aiOpen && profile ? <NoteAiEditor profile={profile} draft={{ title: aiField === "extracted" ? "" : title, body: aiField === "extracted" ? extractedText : body }}
      allowed={mayEditNoteText(selected?.sensitivity || "inherit", collections.find(c => c.id === collectionId)?.sensitivity || (!selected && !collectionId ? "standard" : undefined), selected ? collections.find(c => c.id === selected.collection_id)?.sensitivity || "unclassified" : undefined)}
      onClose={closeAi} onApply={draft => { if (aiField === "extracted") {
        setBeforeAi({title, body, extracted: extractedText}); setExtractedText(draft.body); setFileContentOpen(true);
      } else {
        setBeforeAi({title, body}); setTitle(draft.title); setBody(draft.body);
      }
      setEditing(true); }} /> : null}
    <BottomSheet visible={Boolean(candidate)} title="Сравнить результат" onClose={() => setCandidate(null)}>
          {candidate ? <View testID="re-recognition-review" style={{borderColor:t.line,borderWidth:1,
            borderRadius:nebulaRadii.card,padding:nebulaSpacing.md,gap:nebulaSpacing.sm,backgroundColor:t.panel}}>
            <Text accessibilityRole="header" style={{color:t.text,fontWeight:"700"}}>Новый результат · {candidate.attachment.name}</Text>
            <Text style={{color:t.muted}}>Текущий текст сохраняется до применения. Применение заменит только распознанный текст; ваш комментарий сохранится.</Text>
            <Text style={{color:t.secondary}}>Текущий текст</Text>
            <ScrollView nestedScrollEnabled style={{maxHeight:160}}><Text selectable style={{color:t.text}}>{extractedText}</Text></ScrollView>
            <Text style={{color:t.secondary}}>Новый текст файла</Text>
            <ScrollView nestedScrollEnabled style={{maxHeight:240}}>
              <Text selectable style={{color:t.text,lineHeight:23}}>{candidate.text}</Text>
            </ScrollView>
            <View style={{flexDirection:"row",flexWrap:"wrap",gap:nebulaSpacing.sm}}>
              <NebulaAction icon="x" label="Оставить текущий"
                accessibilityLabel="Оставить текущий текст" onPress={()=>setCandidate(null)} />
              <NebulaAction icon="check" label="Применить новый"
                accessibilityLabel="Применить новый текст" variant="primary"
                disabled={busy || dirty} onPress={acceptCandidate} />
            </View>
          </View> : null}
    </BottomSheet>
    <BottomSheet visible={noteMenu} title="Запись" onClose={() => setNoteMenu(false)}>
      {selected?.record_status !== "trashed" ? <>
      <Pressable accessibilityRole="button" style={{...button,backgroundColor:t.soft}} onPress={() => { setNoteMenu(false); setEditing(true); setMetadataOpen(true); }}><Text style={{ color: t.text }}>Свойства и доступ</Text></Pressable>
      <Pressable accessibilityRole="button" style={{...button,backgroundColor:t.soft}} onPress={() => { setNoteMenu(false); setEditing(true); void loadDetails(); }}><Text style={{ color: t.text }}>История, события и связи</Text></Pressable>
      {hasRecognizedText ? <Pressable accessibilityRole="button" style={{...button,backgroundColor:t.soft}} onPress={() => { setNoteMenu(false); setEditing(true); setFileContentOpen(true); }}><Text style={{ color: t.text }}>Распознанный текст и оригиналы</Text></Pressable> : null}
      </> : <Text style={{ color: t.muted }}>Восстановите запись из корзины, чтобы редактировать её.</Text>}
    </BottomSheet>
    <BottomSheet visible={sectionOpen} title="Раздел записи" onClose={() => setSectionOpen(false)}>
      {collections.length ? collections.map(c => <Pressable key={c.id} accessibilityRole="button" accessibilityLabel={"Поместить в раздел " + c.name} accessibilityState={{ selected: c.id === collectionId }} style={button} onPress={() => { setCollectionId(c.id); setSectionOpen(false); if (!selected && !kindTouched.current) setKind(defaultKind(c.slug)); }}><Text style={{ color: c.id === collectionId ? t.secondary : t.text }}>{c.name}</Text></Pressable>) : <Text style={{ color: t.muted }}>Первая запись будет в разделе «Заметки». Другие разделы можно создать на странице памяти.</Text>}
    </BottomSheet>
    <BottomSheet visible={linkOpen} title="Связать записи" onClose={() => { setLinkOpen(false); void loadDetails(); }}>
      <TextInput accessibilityLabel="Найти связанную запись" value={linkSearch} onChangeText={setLinkSearch} placeholder="Поиск" placeholderTextColor={t.muted} style={field} />
      {related.filter(e => e.id !== selected?.id && !relations.some(r => r.source_entity_id === e.id || r.target_entity_id === e.id)).map(e => <Pressable key={e.id} accessibilityRole="button" style={button} onPress={() => void run(async db => {
        if (!selected) return; await db.linkEntities(selected.id, e.id, "related_to");
        if (alive.current) { setRelations(await db.relationsForEntity(selected.id)); setLinkOpen(false); }
      })}><Text style={{ color: t.secondary }}>{e.title || "Без названия"}</Text></Pressable>)}
      {error ? <Text accessibilityRole="alert" style={{ color: t.err }}>{error}</Text> : null}
    </BottomSheet>
    <NebulaConfirmSheet visible={repeatMessage !== null}
      title="Распознать заново?" message={repeatMessage || ""}
      confirmLabel="Распознать" cancelLabel="Оставить прежний текст"
      disabled={busy || dirty}
      onCancel={() => { repeatRequest.current++; repeatApproval.current = null; setRepeatMessage(null); }}
      onConfirm={() => {
        const approved = repeatApproval.current;
        repeatRequest.current++; repeatApproval.current = null; setRepeatMessage(null);
        if (!approved) return;
        if (!recognitionApprovalMatches({
          approved, activeProfile: activeProfile.current, selected, busy, dirty,
          unlocked: localMemorySessionUnlocked(),
        })) {
          setError("Запись изменилась или приложение заблокировано. Выберите оригинал заново.");
          return;
        }
        approved.start();
      }} />
    <NebulaConfirmSheet visible={confirmKind !== null}
      title={confirmKind === "leave" ? "Изменения не сохранены" : "Разрешить доступ агенту?"}
      message={confirmKind === "leave"
        ? "Изменения в записи не сохранятся. Продолжить редактирование или выйти без сохранения?"
        : "После сохранения запись перейдёт в обычные «Заметки». Текст и распознанное содержимое смогут передаваться модели при поиске. Оригинал автоматически не отправляется."}
      confirmLabel={confirmKind === "leave" ? "Выйти без сохранения" : "Разрешить"}
      cancelLabel={confirmKind === "leave" ? "Продолжить редактирование" : "Отмена"}
      danger={confirmKind === "leave"} disabled={busy}
      onCancel={() => setConfirmKind(null)}
      onConfirm={() => {
        if (confirmKind === "leave") { setConfirmKind(null); setLeaving(true); }
        else if (confirmKind === "agent") { setConfirmKind(null); setAllowAgent(true); }
      }} />
  </KeyboardAvoidingView>;
}

