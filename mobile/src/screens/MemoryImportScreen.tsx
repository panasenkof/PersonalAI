import { useNavigation, useRoute, usePreventRemove } from "@react-navigation/native";
import type { NavigationAction } from "@react-navigation/native";
import type { RouteProp } from "@react-navigation/native";
import { localMemoryRepository } from "../local-memory/repository";
import { ensureSections } from "../local-memory/sections";
import type { CollectionRecord } from "../local-memory/types";
import { loadMediaPreferences, type FileAsrMode } from "../media/preferences";
import { onLocalMemorySessionChange } from "../local-memory/storage";
import * as ImagePicker from "expo-image-picker";
import { importLink, linkImportErrorMessage, publicImportUrl, type HtmlPublicationClaim } from "../media/link-import";
import { sharedLinkPreview } from "../media/messenger-share-links";
import { pdfCoverageMessage } from "../media/pdf-pages";
import { useRussianOcrStatus } from "../media/russian-ocr";
import { RussianOcrControls } from "../media/RussianOcrControls";
import type { PdfPageCoverage } from "../media/pdf-pages";
import * as Crypto from "expo-crypto";
import { File, Directory, Paths } from "expo-file-system";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { useHeaderHeight } from "@react-navigation/elements";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import * as DocumentPicker from "expo-document-picker";
import * as FileSystem from "expo-file-system/legacy";
import React, { useEffect, useRef, useState } from "react";
import { ActivityIndicator, Alert, Image, Keyboard, KeyboardAvoidingView, Platform, Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { useProfile } from "../profile/ProfileContext";
import { loadDirectConnections, anonymousLocalAllowed, defaultDirectPreferences } from "../direct-agent/settings";
import type { DirectConnection } from "../direct-agent/settings";
import { MAX_ORIGINALS_PER_NOTE, MAX_TOTAL_ORIGINAL_BYTES, saveMediaNote } from "../media/attachments";
import { NoteAiEditor } from "../components/NoteAiEditor";
import { replaceFileText, combinedRecognitionText, recognizeFilesSequentially, type FileRecognition } from "../media/batch-recognition";
import { analyzeFilesTogether } from "../media/joint-recognition";
import { extractMedia, mediaKind, officialAudioProvider } from "../media/extract";
import type { ImageExtractionMode } from "../media/extract";
import type { ImportFile } from "../media/extract";
import type { RootStackParams } from "../navigation";
import { withNativeInteraction } from "../security/native-interaction";
import { memoryErrorMessage } from "../local-memory/errors";
import { useTheme } from "../theme";
import { BottomSheet } from "../components/BottomSheet";
import { NebulaConfirmSheet } from "../components/NebulaConfirmSheet";
import { NoteEditorSection } from "../design/nebula/NoteEditorSection";
import { NebulaAction } from "../design/nebula/components";
import { ImportFileSummary } from "../design/nebula/ImportFileSummary";
import Feather from "@expo/vector-icons/Feather";
import { useWhisperStatus } from "../media/whisper";
import { scheduleIndexTerms } from "../direct-agent/enrich-runner";
import { scheduleVectors } from "../media/vector-runner";
import { discardCameraPhotoDraft83 } from "../media/vision-chat-camera";
import { autoIndexNotePhotos83 } from "../media/auto-index-note-photos";

const IMPORT_KIND_LABELS: Record<string, string> = {
  image: "Фото", document: "Документ", audio: "Аудио", video: "Видео", text: "Текст",
};

export function MemoryImportScreen() {
  const route = useRoute<RouteProp<RootStackParams, "MemoryImport">>();
  const incoming = route.params?.incoming;
  // One Android Share event containing files (including an optional caption)
  // is one proposed note. Text-only multi-item Share keeps the existing
  // sequential confirmation workflow.
  const groupedIncoming = Boolean(incoming && incoming.length > 1 &&
    incoming.some(item => item.shareType !== "text" && item.shareType !== "url"));
  const [keepOriginal, setKeepOriginal] = useState(true);
  const [publicationClaim,setPublicationClaim] = useState<HtmlPublicationClaim|null>(null);
  const [sourceUrl, setSourceUrl] = useState(""); // Confirmed provenance only.
  const [linkDraft, setLinkDraft] = useState(""); // Unconfirmed URL never changes saved provenance.
  const [linkOnly, setLinkOnly] = useState(false); // Confirmed draft without fetched content.
  const [sourceChoice, setSourceChoice] = useState(route.params?.source);
  const [sourcePickerOpen, setSourcePickerOpen] = useState(true);
  const [processingOptionsOpen, setProcessingOptionsOpen] = useState(false);
  const [recognitionOpen, setRecognitionOpen] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [sectionOpen, setSectionOpen] = useState(false);
  const [keyboardOpen, setKeyboardOpen] = useState(false);
  useEffect(() => {
    const show = Keyboard.addListener("keyboardDidShow", () => setKeyboardOpen(true));
    const hide = Keyboard.addListener("keyboardDidHide", () => setKeyboardOpen(false));
    return () => { show.remove(); hide.remove(); };
  }, []);
  const cameraStarted = useRef(false);
  const [position, setPosition] = useState(0);
  const [collections, setCollections] = useState<CollectionRecord[]>([]);
  const [collectionId, setCollectionId] = useState("");
  const [leaving, setLeaving] = useState(false);
  const leaveAction = useRef<NavigationAction | null>(null);
  const leaveDispatched = useRef(false);
  const [leaveApproval, setLeaveApproval] = useState(false);
  const [skipApproval, setSkipApproval] = useState<{ profile: string; position: number } | null>(null);
  const [prepareAttempt, setPrepareAttempt] = useState(0);
  const [preparing, setPreparing] = useState(false);
  const whisper = useWhisperStatus();
  const russianOcr = useRussianOcrStatus();
  const t = useTheme();
  // Shared visual treatment for mutually exclusive choices in this form.
  // Selection changes only the user's existing local draft, never saves or
  // uploads anything without the canonical operation and confirmation.
  const choiceStyle = (selected: boolean, disabled = false) => ({
    minHeight: 48,
    justifyContent: "center" as const,
    paddingVertical: 12,
    paddingHorizontal: 14,
    borderRadius: 14,
    borderWidth: selected ? 2 : 1,
    borderColor: selected ? t.accent : t.line,
    backgroundColor: selected ? t.soft : t.panel,
    opacity: disabled ? 0.5 : 1,
  });
  const header = useHeaderHeight(); const insets = useSafeAreaInsets();
  const profile = useProfile();
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParams>>();
  const [files, setFiles] = useState<ImportFile[]>([]);
  const file = files[0] || null;
  const [recognitionResults, setRecognitionResults] = useState<FileRecognition[]>([]);
  const [recognizingIndex, setRecognizingIndex] = useState(-1);
  const [recognitionMode, setRecognitionMode] = useState<"sequential" | "joint">("sequential");
  const [imageExtractionMode, setImageExtractionMode] = useState<ImageExtractionMode>("describe");
  const [jointAnalyzing, setJointAnalyzing] = useState(false);
  const [connections, setConnections] = useState<DirectConnection[]>([]);
  const [connectionId, setConnectionId] = useState("");
  const [speechConnectionId, setSpeechConnectionId] = useState("");
  const [fileAsrMode, setFileAsrMode] = useState<FileAsrMode>("device");
  const [classification, setClassification] = useState<"sensitive" | "standard">("standard");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [extractedText, setExtractedText] = useState("");
  const [notice, setNotice] = useState("");
  const [aiField, setAiField] = useState<"body" | "extracted" | null>(null);
  const [comparison, setComparison] = useState<{ scope: string; result: FileRecognition; updated: string } | null>(null);
  const [audioApproval, setAudioApproval] = useState<{ scope: string; service: string; model: string; index?: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const alive = useRef(true);
  const controller = useRef<AbortController | null>(null);
  const ownedFiles = useRef<string[]>([]);
  useEffect(() => {
    alive.current = true;
    if (profile) void Promise.all([loadDirectConnections(profile), loadMediaPreferences(profile)]).then(([v, prefs]) => {
      if (alive.current) { setConnections(v.connections); setConnectionId(prefs.visionId || v.activeId); setSpeechConnectionId(prefs.speechId || v.activeId); setFileAsrMode(prefs.fileAsrMode); }
    }).catch(() => { if (alive.current) setNotice("Не удалось прочитать подключения. Откройте настройки модели."); });
    return () => {
      alive.current = false; controller.current?.abort();
      for (const uri of ownedFiles.current) void FileSystem.deleteAsync(uri, { idempotent: true }).catch(() => {});
    };
  }, [profile]);
  useEffect(() => { if (profile) void localMemoryRepository(profile).then(ensureSections).then(cols => {
    if (alive.current) { setCollections(cols); setCollectionId(cols.find(c => c.id === route.params?.collectionId)?.id || cols.find(c => c.slug === "notes")?.id || ""); }
  }).catch(() => { if (alive.current) setNotice("Не удалось загрузить разделы."); }); }, [profile]);
  useEffect(() => {
    const payload = incoming?.[position]; if (!payload) return;
    let cancelled = false; const staged: File[] = [];
    const cleanup = () => { for (const copy of staged) {
      try { if (copy.exists) copy.delete(); } catch { /* Only our private cache. */ }
    } };
    const off = onLocalMemorySessionChange(unlocked => {
      if (unlocked) return;
      cancelled = true; cleanup(); setFiles([]); setPreparing(false);
      setNotice("Подготовка прервана блокировкой. Повторите приём после разблокировки.");
    });
    setPreparing(true); setTitle(""); setFiles([]); setRecognitionResults([]); setRecognizingIndex(-1); setBody(""); setExtractedText(""); setNotice(""); setSourceUrl(""); setPublicationClaim(null); setLinkDraft(""); setLinkOnly(false); setSourcePickerOpen(false); setProcessingOptionsOpen(false); setKeepOriginal(true);
    void (async () => {
      if (incoming!.length > 30) throw new Error("Отправляйте не более 30 материалов за один раз.");
      if (groupedIncoming) {
        // MSG-2.A: the existing canonical saveMediaNote(files) handles every
        // original in ONE note. No per-file note writes, no external fetch.
        const captions: string[] = [];
        const assets: ImportFile[] = [];
        const dir = new Directory(Paths.cache, "persai-incoming");
        dir.create({ intermediates: true, idempotent: true });
        let bytes = 0;
        for (const item of incoming!) {
          if (cancelled) { cleanup(); return; }
          const isText = item.shareType === "text" || item.shareType === "url";
          if (!item.value || (isText && item.value.length > 60_000))
            throw new Error("Пустой или слишком длинный входящий материал.");
          if (isText) { captions.push(item.value); continue; }
          if (!["file", "image", "audio", "video"].includes(item.shareType) ||
              !/^(content|file):\/\//.test(item.value))
            throw new Error("Оригинал недоступен. Отправьте файлы из приложения ещё раз.");
          if (assets.length >= MAX_ORIGINALS_PER_NOTE)
            throw new Error("Не более 10 файлов в одной заметке. Отправьте альбом частями.");
          const source = new File(item.value);
          const target = new File(dir, Crypto.randomUUID());
          staged.push(target);
          await FileSystem.copyAsync({ from: item.value, to: target.uri });
          if (cancelled) { cleanup(); return; }
          const size = target.size;
          if (!Number.isFinite(size) || size < 0 || (bytes += size) > MAX_TOTAL_ORIGINAL_BYTES)
            throw new Error("Суммарный размер оригиналов превышает 80 МБ.");
          const asset: ImportFile = {
            uri: target.uri, name: source.name || "Входящий файл", mimeType: item.mimeType,
          };
          mediaKind(asset);
          assets.push(asset);
        }
        const caption = captions.join("\n\n");
        if (caption.length > 60_000) throw new Error("Общая подпись длиннее 60 000 символов.");
        if (cancelled) { cleanup(); return; }
        // Do not mark any URL within the caption as verified source metadata
        // for every file in the album. It remains ordinary user-provided text.
        ownedFiles.current.push(...staged.map(copy => copy.uri));
        setFiles(assets);
        setBody(caption);
        setTitle(caption.split("\n").find(line => line.trim())?.slice(0, 160) ||
          (assets.length > 1 ? "Полученные материалы" : assets[0]?.name.slice(0, 160) || "Материал"));
        setNotice("Один черновик для всех файлов и подписи. Сохранение только после подтверждения.");
        return;
      }
      const text = payload.shareType === "text" || payload.shareType === "url";
      if (!payload.value || (text && payload.value.length > 60_000)) throw new Error("Пустой или слишком длинный материал.");
      if (text) {
        // MSG-0/1: inspect ONLY the actual Share payload. Never fetch, infer
        // author/date, read another URL from a multi-link message or save.
        // A link stays URL-only until the user explicitly asks to load it.
        const link=sharedLinkPreview(payload);
        if(!cancelled){
          if(link){
            // Reuse the existing canonical HTTPS/SSRF gate even for Share text.
            const checked=publicImportUrl(link.url);
            if(link.kind!=="restricted"){
              setSourceUrl(checked);setLinkDraft(checked);setLinkOnly(true);
              setKeepOriginal(false);
            }else{
              setNotice("Ссылка-приглашение или закрытая ссылка не является публичным постом. Откройте сообщение и выберите «Поделиться». Содержимое не загружено.");
            }
          }else if(payload.shareType==="url"){
            setNotice("Адрес не прошёл проверку публичной HTTPS-ссылки. Сохраните только текст или отправьте другую ссылку.");
          }
          setTitle(payload.shareType==="url"?"Ссылка":payload.value.split("\n")[0].slice(0,160));
          setBody(payload.value);
        }
        return;
      }
      const source = new File(payload.value);
      const dir = new Directory(Paths.cache, "persai-incoming"); dir.create({ intermediates: true, idempotent: true });
      const target = new File(dir, Crypto.randomUUID()); staged.push(target);
      await FileSystem.copyAsync({ from: payload.value, to: target.uri });
      if (cancelled) { cleanup(); return; }
      ownedFiles.current.push(target.uri);
      const asset = { uri: target.uri, name: source.name || "Входящий файл", mimeType: payload.mimeType };
      mediaKind(asset); setFiles([asset]); setRecognitionResults([]); setTitle(asset.name.slice(0, 160));
    })().catch(e => { cleanup(); if (!cancelled) setNotice(memoryErrorMessage(e)); }).finally(() => { if (!cancelled) setPreparing(false); });
    return () => { cancelled = true; off(); cleanup(); };
  }, [incoming, position, prepareAttempt]);
  usePreventRemove(!leaving && Boolean(incoming || file || body || extractedText || linkDraft.trim()), ({ data }) => {
    if (busy || preparing) { setNotice("Дождитесь завершения операции или остановите её."); return; }
    leaveAction.current = data.action;
    setLeaveApproval(true);
  });
  useEffect(() => {
    if (!leaving || leaveDispatched.current) return;
    leaveDispatched.current = true;
    const original = leaveAction.current;
    leaveAction.current = null;
    if (original) navigation.dispatch(original);
    else navigation.goBack();
  }, [leaving, navigation]);
  useEffect(() => onLocalMemorySessionChange(unlocked => {
    if (!unlocked) {
      controller.current?.abort(); leaveAction.current = null;
      setLeaveApproval(false); setSkipApproval(null); setAudioApproval(null); setComparison(null); setAiField(null);
    }
  }), []);
  useEffect(() => {
    leaveAction.current = null; setLeaveApproval(false);
    setSkipApproval(null); setAudioApproval(null); setComparison(null); setAiField(null);
  }, [profile]);
  useEffect(() => { setSkipApproval(null); setAudioApproval(null); setComparison(null); setAiField(null); }, [position, prepareAttempt]);
  // Both target record AND collection must permit provider egress.
  const collectionAllowsProvider = collections.find(c => c.id === collectionId)?.sensitivity === "standard";
  const providerApproved = classification === "standard" && collectionAllowsProvider;
  const selected = connections.find(c => c.id === connectionId);
  const kind = file ? mediaKind(file) : null;
  const localAudio = kind === "audio" && fileAsrMode === "device" && whisper.state === "ready";
  const speechSelected = connections.find(c => c.id === speechConnectionId);
  const processor = kind === "audio" ? speechSelected : selected;
  const canExtractFile = (item: ImportFile) => {
    const currentKind = mediaKind(item);
    const currentProcessor = currentKind === "audio" ? speechSelected : selected;
    if (imageExtractionMode === "offline-ocr" && (currentKind === "document" || currentKind === "image"))
      return russianOcr.ready;
    return currentKind === "text" || currentKind === "document" ||
      (currentKind === "audio" && fileAsrMode === "device" && whisper.state === "ready") ||
      (currentKind === "video" && fileAsrMode === "device" && whisper.state === "ready") ||
      Boolean(currentProcessor && providerApproved && (currentProcessor.apiKey || anonymousLocalAllowed(currentProcessor)) &&
        (currentKind !== "audio" || (fileAsrMode === "online" && officialAudioProvider(currentProcessor))));
  };
  const canExtract = files.some(canExtractFile);
  const field = { color: t.text, backgroundColor: t.panel, borderWidth: 1, borderColor: t.line, borderRadius: 16, padding: 14, minHeight: 50 };
  const button = { backgroundColor: t.accent, padding: 14, borderRadius: 17, minHeight: 50, justifyContent: "center" as const, alignItems: "center" as const };

  function cancelPicker() {
    if (!alive.current) return;
    if (file || extractedText) {
      setSourcePickerOpen(false);
      setLinkDraft(sourceUrl);
    } else if (route.params?.source || route.params?.camera) {
      navigation.goBack();
    }
  }
  async function gallery() {
    setPreparing(true);
    const copies: ImportFile[] = [];
    try {
      const result = await withNativeInteraction(() => ImagePicker.launchImageLibraryAsync({ mediaTypes: ["images"], allowsMultipleSelection: true, selectionLimit: MAX_ORIGINALS_PER_NOTE, quality: 1 }));
      if (result.canceled) { cancelPicker(); return; }
      if (!alive.current) return;
      const originals = result.assets.map(asset => ({ uri: asset.uri, name: asset.fileName || "photo.jpg", mimeType: asset.mimeType || "image/jpeg" }));
      if (originals.length > MAX_ORIGINALS_PER_NOTE || originals.reduce((sum, asset) => sum + new File(asset.uri).size, 0) > MAX_TOTAL_ORIGINAL_BYTES) throw new Error("Выберите до 10 фото общим размером до 80 МБ.");
      const directory = new Directory(Paths.cache, "persai-incoming"); directory.create({ intermediates: true, idempotent: true });
      for (const original of originals) {
        const target = new File(directory, Crypto.randomUUID() + (original.name.match(/\.[a-z0-9]{1,8}$/i)?.[0] || ".jpg"));
        copies.push({ ...original, uri: target.uri });
        await FileSystem.copyAsync({ from: original.uri, to: target.uri });
      }
      if (!alive.current) { for (const copy of copies) await FileSystem.deleteAsync(copy.uri, { idempotent: true }); return; }
      ownedFiles.current.push(...copies.map(copy => copy.uri));
      setFiles(copies); setRecognitionResults([]); setTitle(""); setSourceUrl(""); setPublicationClaim(null); setLinkDraft(""); setLinkOnly(false); setSourcePickerOpen(false); setProcessingOptionsOpen(false); setKeepOriginal(true); setExtractedText(""); setBody("");
    } catch (e) {
      for (const copy of copies) await FileSystem.deleteAsync(copy.uri, { idempotent: true }).catch(() => {});
      if (alive.current) setNotice(memoryErrorMessage(e));
    } finally { if (alive.current) setPreparing(false); }
  }
  async function camera() {
    setPreparing(true);
    try {
      const permission = await withNativeInteraction(() => ImagePicker.requestCameraPermissionsAsync());
      if (!alive.current) return;
      if (!permission.granted) throw new Error("Разрешите камеру в настройках телефона.");
      const shot = await withNativeInteraction(() => ImagePicker.launchCameraAsync({ mediaTypes: ["images"], quality: 1 }));
      if (shot.canceled) { cancelPicker(); return; }
      if (!alive.current) return;
      const asset = shot.assets[0];
      const dir = new Directory(Paths.cache, "persai-incoming"); dir.create({ intermediates: true, idempotent: true });
      const target = new File(dir, Crypto.randomUUID() + ".jpg");
      try { await FileSystem.copyAsync({ from: asset.uri, to: target.uri }); }
      finally { await FileSystem.deleteAsync(asset.uri, { idempotent: true }); }
      if (!alive.current) { if (target.exists) target.delete(); return; }
      ownedFiles.current.push(target.uri);
      setFiles([{ uri: target.uri, name: asset.fileName || "camera.jpg", mimeType: asset.mimeType || "image/jpeg" }]); setRecognitionResults([]);
      setTitle("Снимок"); setSourceUrl(""); setPublicationClaim(null); setLinkDraft(""); setLinkOnly(false); setSourcePickerOpen(false); setProcessingOptionsOpen(false); setKeepOriginal(true); setExtractedText(""); setBody("");
    } catch (e) { if (alive.current) setNotice(memoryErrorMessage(e)); }
    finally { if (alive.current) setPreparing(false); }
  }
  useEffect(() => {
    const uri=route.params?.initialPhotoUri;
    if(!uri || cameraStarted.current)return;
    cameraStarted.current=true;
    const folder=Paths.cache.uri.replace(/\/$/,"")+"/persai-camera-drafts/";
    if(!uri.startsWith(folder) || uri.slice(folder.length).includes("/")){
      setNotice("Недопустимый источник снимка.");return;
    }
    setPreparing(true);
    void (async()=>{
      let target:File|undefined;
      try{
        const dir=new Directory(Paths.cache,"persai-incoming");
        dir.create({intermediates:true,idempotent:true});
        const extension=uri.match(/\.(jpg|jpeg|png|webp)$/i)?.[0]?.toLowerCase() || ".jpg";
        const mime=extension===".png"?"image/png":extension===".webp"?"image/webp":"image/jpeg";
        target=new File(dir,Crypto.randomUUID()+extension);
        await FileSystem.copyAsync({from:uri,to:target.uri});
        if(!alive.current){if(target.exists)target.delete();return;}
        ownedFiles.current.push(target.uri);
        setFiles([{uri:target.uri,name:"Снимок"+extension,mimeType:mime}]);
        setTitle("Снимок");setSourceChoice("photo");setSourcePickerOpen(false);
        setProcessingOptionsOpen(false);setKeepOriginal(true);
        setExtractedText("");setBody("");setNotice("");
      }catch(e){if(target?.exists)target.delete();if(alive.current)setNotice(memoryErrorMessage(e));}
      finally{discardCameraPhotoDraft83(uri);if(alive.current)setPreparing(false);}
    })();
  },[route.params?.initialPhotoUri]);
  useEffect(() => {
    if (cameraStarted.current || incoming || route.params?.initialPhotoUri) return;
    const source = route.params?.camera ? "camera" : route.params?.source;
    if (source !== "camera" && source !== "gallery" && source !== "file") return;
    cameraStarted.current = true;
    if (source === "camera") void camera();
    else if (source === "gallery") void gallery();
    else void pick();
  }, [incoming, route.params]);
  // A URL-only preview is a user decision, never an implicit save or network call.
  function previewLinkOnly() {
    if (busy || preparing || controller.current) return;
    try {
      const source = publicImportUrl(linkDraft);
      const domain = new URL(source).hostname;
      setSourceUrl(source); setPublicationClaim(null);
      setLinkDraft(source);
      setLinkOnly(true);
      setFiles([]);
      setRecognitionResults([]);
      setRecognizingIndex(-1);
      setExtractedText("");
      setKeepOriginal(false);
      setTitle(current => file || !current.trim() ? "Ссылка · " + domain : current);
      setSourcePickerOpen(false);
      setProcessingOptionsOpen(false);
      setNotice("Сохранится только адрес и ваша заметка. Содержимое сайта не загружено.");
      // body is the user's annotation and must survive failed and retried imports.
    } catch (error) { setNotice(linkImportErrorMessage(error)); }
  }
  async function readLink() {
    if (busy || controller.current) return;
    const aborter = new AbortController(); controller.current = aborter; setBusy(true); setNotice("");
    try {
      const result = await importLink(linkDraft, aborter.signal);
      if (!alive.current || aborter.signal.aborted) { if (result.file) await FileSystem.deleteAsync(result.file.uri, { idempotent: true }); return; }
      if (result.file) { ownedFiles.current.push(result.file.uri); setFiles([result.file]); setExtractedText(""); setKeepOriginal(true); setTitle(result.file.name); }
      else { setFiles([]); setExtractedText(result.text || ""); setKeepOriginal(false); setTitle(result.title || "Материал по ссылке"); }
      setRecognitionResults([]);
      setLinkOnly(false); setPublicationClaim(result.publicationClaim || null); setSourceUrl(result.source); setLinkDraft(result.source); setSourcePickerOpen(false); setProcessingOptionsOpen(false);
      if (result.text) setNotice((result.textCoverage === "telegram_post_text_only"
        ? "Текст именно этого сообщения Telegram найден в публичном HTML. Фото, видео, вложения, автор и дата не подтверждены и не загружены. Сохранится только доступный текст и ссылка."
        : result.partial
          ? "Получен фрагмент страницы: разметка обрывается. Проверьте текст перед сохранением."
          : "Текст страницы извлечён. Проверьте заголовки и полноту: сайт мог предоставить только часть статьи.") +
          (result.publicationClaim ? " Дата публикации по метаданным сайта: " + result.publicationClaim.date + " (не проверена независимо)." : ""));
    } catch (e) { if (alive.current) setNotice(linkImportErrorMessage(e)); }
    finally { if (controller.current === aborter) controller.current = null; if (alive.current) setBusy(false); }
  }
  async function pick() {
    setPreparing(true);
    setNotice("");
    try {
      const result = await withNativeInteraction(() => DocumentPicker.getDocumentAsync({
        type: ["image/*", "audio/*", "video/*", "text/*", "application/json", "application/pdf"], copyToCacheDirectory: true, multiple: true,
      }));
      if (result.canceled || !result.assets.length) { cancelPicker(); return; }
      if (!alive.current) return;
      const chosen = result.assets.map(asset => ({ uri: asset.uri, name: asset.name, mimeType: asset.mimeType, size: asset.size }));
      if (chosen.length > MAX_ORIGINALS_PER_NOTE) throw new Error("Не более 10 вложений в одной заметке.");
      chosen.forEach(mediaKind);
      const knownBytes = chosen.reduce((sum, item) => sum + (item.size || 0), 0);
      if (knownBytes > MAX_TOTAL_ORIGINAL_BYTES) throw new Error("Суммарный размер вложений — не более 80 МБ.");
      for (const asset of chosen) {
        if (FileSystem.cacheDirectory && asset.uri.startsWith(FileSystem.cacheDirectory)) ownedFiles.current.push(asset.uri);
      }
      setFiles(chosen); setRecognitionResults([]); setRecognizingIndex(-1);
      setSourceUrl(""); setPublicationClaim(null); setLinkDraft(""); setLinkOnly(false); setSourcePickerOpen(false); setProcessingOptionsOpen(false);
      setKeepOriginal(true); setTitle(chosen[0].name.slice(0, 160)); setBody(""); setExtractedText(""); setClassification("standard");
    } catch (e) { if (alive.current) setNotice((e as Error).message); }
    finally { if (alive.current) setPreparing(false); }
  }
  // Ephemeral scope for a particular draft, set of originals, extraction method
  // and current user edits. No consent is persisted or carried between files.
  const replacementScope = () => JSON.stringify({ profile,
    files: files.map(item => [item.uri, item.name, item.size]), extractedText,
    imageExtractionMode, recognitionMode, classification, collectionId,
    connectionId, speechConnectionId, fileAsrMode,
    speechService: speechSelected?.name, speechModel: speechSelected?.transcriptionModel,
  });
  async function extract(index?: number, onlineConsent = false) {
    const source = index === undefined ? file : files[index];
    if (!source || !canExtract || busy || controller.current) return;
    const sourceKind = mediaKind(source);
    const targets = index === undefined ? files : [source];
    if (fileAsrMode === "online" && targets.some(item => ["audio", "video"].includes(mediaKind(item))) && !onlineConsent) {
      if (!speechSelected || !officialAudioProvider(speechSelected)) {
        setNotice("Для онлайн-распознавания аудиофайла выберите официальное подключение OpenAI."); return;
      }
      setAudioApproval({ scope: replacementScope(), service: speechSelected.name,
        model: speechSelected.transcriptionModel || "gpt-transcribe", index });
      return;
    }
    const aborter = new AbortController(); controller.current = aborter; setBusy(true); setNotice("");
    try {
      const vision = selected || { ...defaultDirectPreferences, apiKey: "", webSearchKey: "" };
      const speechBase = connections.find(c => c.id === speechConnectionId) || selected;
      const speech = speechBase ? { ...speechBase, fileAsrMode } : { ...vision, fileAsrMode };
      if (targets.length === 1) {
        let timedSegments: FileRecognition["segments"];
        let pdfCoverage: PdfPageCoverage | undefined;
        const text = await extractMedia(source, vision, providerApproved, aborter.signal, undefined, speech,
          segments => { timedSegments = segments; }, coverage => { pdfCoverage = coverage; }, imageExtractionMode);
        if (alive.current && !aborter.signal.aborted) {
          const result: FileRecognition = { index: index ?? 0, name: source.name, status: "success", text,
            ...(sourceKind === "audio" ? { asrProducerId: fileAsrMode === "device" ? "local-whisper" : "openai:" + (speech.transcriptionModel || "gpt-transcribe") } : {}),
            ...(timedSegments ? { segments: timedSegments } : {}),
            ...(pdfCoverage ? { pdfCoverage } : {}),
            ...((sourceKind === "image" || (sourceKind === "document" && imageExtractionMode === "offline-ocr")) ? { imageMode: imageExtractionMode } : {}) };
          if (index !== undefined) {
            setComparison({scope: replacementScope(), result, updated: replaceFileText(extractedText, files.map(item => item.name), index, text)});
          } else {
            setRecognitionResults([result]); setExtractedText(text);
          }
          setNotice(pdfCoverage ? (imageExtractionMode === "offline-ocr" ? pdfCoverageMessage(pdfCoverage).replace("OCR пока не выполнялся.", "Остались страницы без прочитанного текста.") : pdfCoverageMessage(pdfCoverage)) :
            kind === "image" && imageExtractionMode === "document-text"
              ? "ИИ предложил текст фотографии, но не подтвердил точность. Проверьте все числа и исправьте ошибки перед сохранением."
              : "Проверьте и отредактируйте текст. В памяти он появится после сохранения.");
        }
      } else {
        const segmentsByFile = new Map<number, NonNullable<FileRecognition["segments"]>>();
        const pdfByFile = new Map<number, PdfPageCoverage>();
        const rawResults = await recognizeFilesSequentially(files,
          async (item, index) => extractMedia(item, vision, providerApproved,
            aborter.signal, undefined, speech, segments => { segmentsByFile.set(index, segments); },
            coverage => { pdfByFile.set(index, coverage); }, imageExtractionMode),
          aborter.signal, (done, current) => {
            if (alive.current) {
              setRecognitionResults(done);
              setRecognizingIndex(current < files.length ? current : -1);
              try { setExtractedText(combinedRecognitionText(done, files.length)); } catch { /* final length check reports failure */ }
            }
          });
        const results = rawResults.map(item => item.status === "success"
          ? { ...item,
              ...(mediaKind(files[item.index]) === "audio" ? { asrProducerId: fileAsrMode === "device" ? "local-whisper" : "openai:" + (speech.transcriptionModel || "gpt-transcribe") } : {}), ...(segmentsByFile.has(item.index) ? { segments: segmentsByFile.get(item.index)! } : {}),
              ...(pdfByFile.has(item.index) ? { pdfCoverage: pdfByFile.get(item.index)! } : {}),
              ...((mediaKind(files[item.index]) === "image" || (mediaKind(files[item.index]) === "document" && imageExtractionMode === "offline-ocr")) ? { imageMode: imageExtractionMode } : {}) } : item);
        if (alive.current && !aborter.signal.aborted) {
          setRecognitionResults(results);
          const text = combinedRecognitionText(results, files.length);
          // Keep the original per-file text, even when the additional joint
          // request fails; that failure must never erase recognized sources.
          setExtractedText(text);
          const errors = results.filter(r => r.status === "error").length;
          if (recognitionMode === "joint" && results.some(r => r.status === "success")) {
            if (!providerApproved) throw new Error("Для совместного анализа нужны обычная запись и обычная коллекция с разрешённым подключением.");
            setJointAnalyzing(true);
            try {
              const analysis = await analyzeFilesTogether(results.filter(r => r.status === "success" && r.text).map(r => ({ index: r.index, name: r.name, text: r.text! })),
                vision, providerApproved, aborter.signal);
              if (alive.current && !aborter.signal.aborted) {
                const merged = text + "\n\nСовместный анализ материалов:\n" + analysis;
                if (merged.length > 60_000) throw new Error("Результат совместного анализа превышает 60 000 символов.");
                setExtractedText(merged);
                setNotice(errors ? `Общий анализ готов по ${results.length - errors} из ${files.length} файлов, ${errors} не распознано. Проверьте текст.` :
                  "Все материалы сопоставлены одной моделью. Проверьте итог и сохраните заметку.");
              }
            } catch (e) {
              if (alive.current && !aborter.signal.aborted) setNotice("Исходные результаты сохранены, но совместный анализ не получился: " + (e as Error).message);
              else throw e;
            } finally { if (alive.current) setJointAnalyzing(false); }
          } else {
            setNotice(errors ? `Готово: ${results.length - errors} из ${files.length}. Не распознано: ${errors}. Результаты сохраните после проверки.` :
              "Все файлы распознаны по очереди. Проверьте общий текст и сохраните заметку.");
          }
        }
      }
    } catch (e) { if (alive.current) setNotice(aborter.signal.aborted ? "Разбор остановлен." : (e as Error).message); }
    finally { if (alive.current) { setBusy(false); setRecognizingIndex(-1); } if (controller.current === aborter) controller.current = null; }
  }
  async function save() {
    if (!keepOriginal && !body.trim() && !extractedText.trim() && !linkOnly) { setNotice("Добавьте текст или распознайте материал перед сохранением без оригинала."); return; }
    if (!profile || (!file && !body.trim() && !extractedText.trim() && !(linkOnly && sourceUrl)) || busy || preparing || controller.current) return;
    const aborter = new AbortController(); controller.current = aborter;
    setBusy(true); setNotice("");
    try {
      const content = !extractedText.trim() && files.length === 1 && file && mediaKind(file) === "text"
        ? await extractMedia(file, selected || { ...defaultDirectPreferences, apiKey: "", webSearchKey: "" }, false, aborter.signal)
        : extractedText;
      // Captured per-file recognitions are immutable evidence; user edits of
      // the combined text (or an extra joint analysis) are only note content.
      // When a text file is opened locally at Save without prior recognition,
      // record that successful read under its own original as well.
      const sourceRecognitions: FileRecognition[] = recognitionResults.length
        ? recognitionResults
        : keepOriginal && files.length === 1 && file && mediaKind(file) === "text" && content.trim()
          ? [{ index: 0, name: file.name, status: "success", text: content }]
          : [];
      const savedId = await saveMediaNote(profile, {
        ...(keepOriginal && files.length > 1 ? { files } : { file: keepOriginal ? file || undefined : undefined }),
        title, body, extractedText: content,
        ...(keepOriginal && sourceRecognitions.length ? { recognitions: sourceRecognitions } : {}),
        sourceUrl: sourceUrl || undefined,
        ...(sourceUrl && !linkOnly && publicationClaim && !keepOriginal ? {publicationClaim} : {}),
        sensitivity: classification, collectionId: collectionId || undefined,
        ...(incoming ? { receipt: JSON.stringify(groupedIncoming ? incoming : incoming[position]) } : {}),
      }, aborter.signal);
      scheduleIndexTerms(profile); scheduleVectors(profile);
      // Derived visual vectors are written only after the note commits.
      // A failed model must never imply the original note was not saved.
      if (keepOriginal && files.length) {
        try {
          const indexed = await autoIndexNotePhotos83(profile, savedId, aborter.signal);
          if (indexed.pending || indexed.failed) {
            Alert.alert("Заметка сохранена", "Не все фотографии удалось подготовить для поиска. Повторите индексацию в настройках фото.");
          }
        } catch {
          Alert.alert("Заметка сохранена", "Фото сохранено, но индексация не завершена. Повторите её в настройках.");
        }
      }
      if (!keepOriginal) for (const item of files) { await FileSystem.deleteAsync(item.uri, { idempotent: true }).catch(() => {}); }
      if (alive.current) { if (incoming && !groupedIncoming && position + 1 < incoming.length) setPosition(p => p + 1); else setLeaving(true); }
    } catch (e) { if (alive.current) setNotice("Не удалось сохранить: " + memoryErrorMessage(e)); }
    finally { if (controller.current === aborter) controller.current = null; if (alive.current) setBusy(false); }
  }
  const incomingLink=incoming?.[position]?sharedLinkPreview(incoming[position]):null;
  const hasMaterial = Boolean(file || extractedText || linkOnly || (incoming && !preparing));
  const saveDisabled = busy || preparing || (!body.trim() && !extractedText.trim() && !(file && keepOriginal) && !(linkOnly && sourceUrl));
  return <View style={{ flex: 1, backgroundColor: t.bg, paddingBottom: keyboardOpen ? 0 : insets.bottom }}>
  <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === "ios" ? "padding" : "height"} keyboardVerticalOffset={Platform.OS === "ios" ? header : 0}>
    <ScrollView keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag" contentContainerStyle={{ padding: 18, gap: 15, paddingBottom: 24 }}>
      <Text accessibilityRole="header" style={{ color: t.text, fontSize: 25, fontWeight: "800" }}>{incoming ? `Новая заметка · ${position + 1}/${incoming.length}` : file || extractedText ? "Проверьте и сохраните" : sourceChoice === "link" ? "Добавить ссылку" : sourceChoice === "file" ? "Файл" : sourceChoice === "camera" ? "Камера" : sourceChoice === "gallery" ? "Галерея" : "Выберите материал"}</Text>
      {!hasMaterial && !sourceChoice ? <Text style={{ color: t.muted, lineHeight: 21 }}>Фото, документы и ссылки сохраняются в заметку. Распознавание — по вашему выбору.</Text> : null}

      {incoming ? <Text style={{ color: t.muted }}>Получено через «Поделиться». Сохранение — только после подтверждения.</Text> : null}
      {!incoming && (file || extractedText || linkOnly) && !sourcePickerOpen ? <Pressable disabled={busy || preparing} accessibilityRole="button" accessibilityLabel="Заменить вложение" onPress={() => { setSourceChoice(undefined); setSourcePickerOpen(true); }}
        style={{ minHeight: 48, justifyContent: "center", padding: 12, backgroundColor: t.panel, borderColor: t.line, borderWidth: 1, borderRadius: 14 }}>
        <Text style={{ color: t.secondary, fontWeight: "700" }}>Заменить вложение</Text>
      </Pressable> : null}
      {!incoming && (sourcePickerOpen || (!file && !extractedText && !linkOnly)) ? <View testID="import-source-choices" style={{ gap: 12, padding: 14, borderRadius: 18, borderWidth: 1, borderColor: t.line, backgroundColor: t.panel }}>
        {(!sourceChoice || sourceChoice === "file") ? <Pressable disabled={busy || preparing} accessibilityRole="button" accessibilityLabel="Выбрать файл для памяти" style={{ ...button, backgroundColor: t.soft, alignItems: "flex-start" }} onPress={() => void pick()}><Text style={{ color: t.text, fontSize: 16, fontWeight: "700" }}>Выбрать файл с телефона</Text><Text style={{ color: t.muted }}>Документ, аудио или видео</Text></Pressable> : null}
        {(!sourceChoice || sourceChoice === "photo" || sourceChoice === "gallery") ? <>
        <Pressable disabled={busy || preparing} accessibilityRole="button" accessibilityLabel="Выбрать фото из галереи" style={{ ...button, backgroundColor: t.soft, alignItems: "flex-start" }} onPress={() => void gallery()}><Text style={{ color: t.text, fontSize: 16 }}>Выбрать фото из галереи</Text></Pressable>
        </> : null}
        {(!sourceChoice || sourceChoice === "photo" || sourceChoice === "camera") ? <>
        <Pressable disabled={busy || preparing} accessibilityRole="button" accessibilityLabel="Сфотографировать" style={{ ...button, backgroundColor: t.soft, alignItems: "flex-start" }} onPress={() => void camera()}><Text style={{ color: t.text, fontSize: 16 }}>Сфотографировать</Text></Pressable>
        </> : null}
        {!sourceChoice ? <Pressable accessibilityRole="button" disabled={busy || preparing} style={{...button, backgroundColor:t.soft}} onPress={() => setSourceChoice("link")}><Text style={{color:t.text}}>Ссылка</Text></Pressable> : null}
        {sourceChoice === "link" ? <>
        <Text style={{ color: t.text, fontWeight: "600" }}>Ссылка на статью или файл</Text>
        <TextInput autoFocus accessibilityLabel="Ссылка для импорта" value={linkDraft} onChangeText={setLinkDraft} editable={!busy} autoCapitalize="none" autoCorrect={false} keyboardType="url" placeholder="https://…" placeholderTextColor={t.muted} style={field} />
        <Pressable disabled={busy || !linkDraft.trim()} accessibilityRole="button" style={[button, { opacity: busy || !linkDraft.trim() ? .5 : 1 }]} onPress={() => void readLink()}><Text style={{ color: t.userText }}>Загрузить по ссылке</Text></Pressable>
        <Pressable disabled={busy || !linkDraft.trim()} accessibilityRole="button" accessibilityLabel="Продолжить только со ссылкой"
          style={{ minHeight: 48, justifyContent: "center", alignItems: "center", borderWidth: 1, borderColor: t.line, borderRadius: 16, opacity: busy || !linkDraft.trim() ? .5 : 1 }}
          onPress={previewLinkOnly}><Text style={{ color: t.secondary, fontWeight: "700" }}>Продолжить только со ссылкой</Text></Pressable>
        <Text style={{ color: t.muted, fontSize: 13, lineHeight: 20 }}>Загрузка требует публичную HTTPS-ссылку. Если сайт недоступен, можно сохранить адрес без текста.</Text>
        </> : null}
        {hasMaterial ? <Pressable accessibilityRole="button" disabled={busy || preparing} style={button} onPress={cancelPicker}><Text style={{color:t.userText}}>Оставить текущее</Text></Pressable> : null}
      </View> : null}
      {sourceUrl ? <View style={{ padding: 14, borderWidth: 1, borderColor: t.line, borderRadius: 20, backgroundColor: t.panel, gap: 6 }}>
        <Text style={{ color: t.text, fontWeight: "700" }}>{linkOnly ? "Ссылка · без текста страницы" : "Источник · загружен"}</Text>
        <Text numberOfLines={2} selectable style={{ color: t.secondary, fontSize: 14 }}>{sourceUrl}</Text>
        {linkOnly ? <Text style={{ color: t.muted, fontSize: 13 }}>Содержание сайта не получено. Поиск сможет учитывать название и вашу заметку, но не текст статьи.</Text> : null}
        {incoming && incomingLink && incomingLink.url===sourceUrl ? <>
          <Text style={{color:t.muted,fontSize:13}}>
            {incomingLink.platform==="telegram"?"Telegram":incomingLink.platform==="max"?"MAX":"Веб-ссылка"}
            {" · "}{incomingLink.kind==="public_post_candidate"
              ?"Формат публичного поста. Доступность и автор не проверены."
              :"Сохранится только ссылка. Это не подтверждённый текст публикации."}
          </Text>
          {incomingLink.canFetch && linkOnly ?
            <NebulaAction icon="download" label="Загрузить публичное содержимое"
              size="compact" disabled={busy || preparing}
              accessibilityLabel="Загрузить содержимое публичной ссылки после согласия"
              onPress={()=>void readLink()} /> : null}
        </> : null}
      </View> : null}
      {!file && extractedText ? <Text style={{ color: t.muted, fontSize: 12 }}>Выбранный источник: текст по ссылке</Text> : null}
      {preparing ? <ActivityIndicator accessibilityLabel="Подготовка входящего файла" /> : null}

      {file ? <ImportFileSummary key={files.map(item => item.uri).join("|")}
        files={files.map(item => ({ id: item.uri, name: item.name, kind: IMPORT_KIND_LABELS[mediaKind(item)] || "Файл" }))}
        preview={kind === "image" ? <Image source={{ uri: file.uri }} resizeMode="contain"
          style={{ width: "100%", height: 180, borderRadius: 14 }} /> : undefined} /> : null}
      {busy ? <View style={{ gap: 8 }}><ActivityIndicator />
        <NebulaAction icon="square" label="Остановить разбор" variant="danger"
          onPress={() => controller.current?.abort()} />
      </View> : null}
      {groupedIncoming && files.length ? <Text style={{ color: t.muted, fontSize: 13 }}>
        Файлов в одной заметке: {files.length}. Подпись можно отредактировать перед сохранением.
      </Text> : null}
      {incoming && !preparing ? <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
        <NebulaAction icon="refresh-cw" label="Повторить подготовку" size="compact" disabled={busy}
          onPress={() => setPrepareAttempt(n => n + 1)} />
        {!groupedIncoming && position + 1 < incoming.length ? <NebulaAction icon="skip-forward" label="Пропустить материал" size="compact"
          disabled={busy || preparing} onPress={() => { if (profile) setSkipApproval({ profile, position }); }} /> : null}
      </View> : null}
      {notice ? <Text accessibilityRole="alert" style={{ color: t.muted }}>{notice}</Text> : null}
      {hasMaterial ? <>
        <TextInput accessibilityLabel="Сведения из файла" editable={!busy} multiline value={body} onChangeText={setBody} maxLength={60_000} style={[field, { minHeight: 96, textAlignVertical: "top" }]} placeholder={linkOnly ? "Моя заметка — что важно сохранить? (необязательно)" : "Добавьте подпись — необязательно"} placeholderTextColor={t.muted} />
        {body.trim() ? <NebulaAction icon="zap" label="Улучшить подпись с ИИ" size="compact" disabled={busy} onPress={() => setAiField("body")} /> : null}
        <Pressable accessibilityRole="button" accessibilityLabel="Выбрать коллекцию" disabled={busy} onPress={() => { Keyboard.dismiss(); setSectionOpen(true); }} style={{ ...button, backgroundColor: t.panel, alignItems: "flex-start" }}><Text style={{ color: t.text }}>Коллекция: {collections.find(c => c.id === collectionId)?.name || "Заметки"} · Изменить</Text></Pressable>
        <View testID="import-access-options" style={{ gap: 8 }}>
          <Text accessibilityRole="header" style={{ color: t.text, fontWeight: "700" }}>Доступ к записи</Text>
          <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
            {([
              ["sensitive", "Личные", "Только на телефоне", "lock", "Личные — только на телефоне"],
              ["standard", "Обычные", "Агент может использовать текст; отправка оригинала — по подтверждению", "globe", "Обычные — доступны агенту и разбору у провайдера"],
            ] as const).map(([id, title, description, icon, label]) => {
              const checked = classification === id;
              return <Pressable key={id} accessibilityRole="radio" accessibilityLabel={label}
                accessibilityState={{ checked, disabled: busy }} aria-checked={checked} disabled={busy}
                onPress={() => { setClassification(id); if (id === "sensitive") setRecognitionMode("sequential"); }}
                style={{ flexGrow: 1, flexBasis: 130, minHeight: 84, padding: 10, gap: 5,
                  borderRadius: 14, borderWidth: checked ? 2 : 1,
                  borderColor: checked ? t.accent : t.line, backgroundColor: checked ? t.soft : t.panel }}>
                <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
                  <Feather name={icon} size={17} color={checked ? t.secondary : t.muted} />
                  <Text style={{ flex: 1, color: t.text, fontWeight: "700" }}>{title}</Text>
                  <Feather name={checked ? "check-circle" : "circle"} size={17} color={checked ? t.secondary : t.muted} />
                </View>
                <Text style={{ color: t.muted, fontSize: 12, lineHeight: 17 }}>{description}</Text>
              </Pressable>;
            })}
          </View>
          {collections.find(c => c.id === collectionId)?.sensitivity !== "standard"
            ? <Text style={{ color: t.muted }}>Выбранная коллекция закрыта для агента независимо от настройки записи.</Text> : null}
        </View>
        {file ? <NoteEditorSection title="Распознавание" summary={extractedText ? "Текст получен · можно повторить" : "Необязательно · для поиска по содержимому"} expanded={recognitionOpen} onToggle={() => setRecognitionOpen(v => !v)}>
        <Text style={{ color: t.muted, fontSize: 12 }}>{kind === "video" ? "Речь и пять выборочных кадров обрабатываются отдельно. Максимум 10 минут; частичные результаты явно отмечены." : kind === "audio" ? (fileAsrMode === "device" ? "На телефоне · Whisper. Без сети и без автоматического переключения. Если модель не скачана, установите её в настройках голоса." : "Онлайн · только официальный OpenAI. Оригинал звука уйдёт провайдеру после подтверждения, возможна оплата.") : kind === "text" ? "Текстовый файл читается на телефоне, без отправки в интернет." : kind === "document" ? "PDF читается локально: Android 15+ или Android 12–14 с расширением S v13+. У сканов без текстового слоя страницы останутся непрочитанными; оригинал сохранится." : "Выбранная модель должна поддерживать изображения."}</Text>
        {files.some(item => mediaKind(item) === "image") ? <View style={{ gap: 6 }}>
          <Text style={{ color: t.text, fontWeight: "700" }}>Что сделать с фотографией</Text>
          <Pressable accessibilityRole="button" accessibilityLabel="Описать фотографию" accessibilityState={{ selected: imageExtractionMode === "describe" }} disabled={busy}
            onPress={() => setImageExtractionMode("describe")} style={choiceStyle(imageExtractionMode === "describe", busy)}>
            <Text style={{ color: imageExtractionMode === "describe" ? t.secondary : t.text }}>{imageExtractionMode === "describe" ? "● " : "○ "}Описать содержание фото</Text>
          </Pressable>
          <Pressable accessibilityRole="button" accessibilityLabel="Прочитать текст фотографии через ИИ" accessibilityState={{ selected: imageExtractionMode === "document-text" }} disabled={busy}
            onPress={() => setImageExtractionMode("document-text")} style={choiceStyle(imageExtractionMode === "document-text", busy)}>
            <Text style={{ color: imageExtractionMode === "document-text" ? t.secondary : t.text }}>{imageExtractionMode === "document-text" ? "● " : "○ "}Прочитать текст документа (ИИ)</Text>
          </Pressable>
          <Pressable accessibilityRole="button" accessibilityLabel="Прочитать фотографию на телефоне" accessibilityState={{ selected: imageExtractionMode === "offline-ocr" }} disabled={busy}
            onPress={() => setImageExtractionMode("offline-ocr")} style={choiceStyle(imageExtractionMode === "offline-ocr", busy)}>
            <Text style={{ color: imageExtractionMode === "offline-ocr" ? t.secondary : t.text }}>{imageExtractionMode === "offline-ocr" ? "● " : "○ "}Прочитать русский текст на телефоне (OCR)</Text>
          </Pressable>
          {imageExtractionMode === "document-text" ? <Text accessibilityRole="text" style={{ color: t.muted, fontSize: 13, lineHeight: 19 }}>
            Фото отправится выбранной модели по вашему нажатию на кнопку разбора. Это не локальное OCR: возможны ошибки в буквах и цифрах; проверьте результат. Для личной записи или закрытой коллекции отправка запрещена: сохраните оригинал без распознавания.
          </Text> : null}
        </View> : null}
        {kind === "document" ? <View style={{ gap: 6 }}>
          <Text style={{ color: t.text, fontWeight: "700" }}>Чтение PDF</Text>
          <Pressable accessibilityRole="button" accessibilityLabel="Только текстовый слой PDF"
            accessibilityState={{ selected: imageExtractionMode !== "offline-ocr" }} disabled={busy}
            onPress={() => setImageExtractionMode("describe")} style={choiceStyle(imageExtractionMode !== "offline-ocr", busy)}>
            <Text style={{ color: imageExtractionMode !== "offline-ocr" ? t.secondary : t.text }}>○ Текстовый слой — быстро, без OCR</Text>
          </Pressable>
          <Pressable accessibilityRole="button" accessibilityLabel="Распознать сканы PDF на телефоне"
            accessibilityState={{ selected: imageExtractionMode === "offline-ocr" }} disabled={busy}
            onPress={() => setImageExtractionMode("offline-ocr")} style={choiceStyle(imageExtractionMode === "offline-ocr", busy)}>
            <Text style={{ color: imageExtractionMode === "offline-ocr" ? t.secondary : t.text }}>○ Добавить локальное OCR отсутствующих страниц</Text>
          </Pressable>
          <Text style={{ color: t.muted, fontSize: 12 }}>
            До 8 сканированных страниц за порцию; текстовый слой не повторяется. Русский OCR не гарантирует точность чисел. Сканы не отправляются провайдеру.
          </Text>
        </View> : null}
        {imageExtractionMode === "offline-ocr" && (kind === "image" || kind === "document")
          ? <RussianOcrControls /> : null}
        {files.length > 1 ? <View style={{ gap: 6 }}>
          <Text style={{ color: t.text, fontWeight: "700" }}>Режим распознавания</Text>
          <Pressable disabled={busy} accessibilityRole="button" accessibilityLabel="Распознавать по очереди"
            accessibilityState={{ selected: recognitionMode === "sequential" }} onPress={() => setRecognitionMode("sequential")}
            style={choiceStyle(recognitionMode === "sequential", busy)}>
            <Text style={{ color: recognitionMode === "sequential" ? t.secondary : t.text }}>{recognitionMode === "sequential" ? "● " : "○ "}По очереди — результат каждого файла отдельно</Text>
          </Pressable>
          <Pressable disabled={busy || !providerApproved} accessibilityRole="button" accessibilityLabel="Распознавать вместе"
            accessibilityState={{ selected: recognitionMode === "joint", disabled: !providerApproved }} onPress={() => setRecognitionMode("joint")}
            style={choiceStyle(recognitionMode === "joint", busy || !providerApproved)}>
            <Text style={{ color: recognitionMode === "joint" ? t.secondary : t.text }}>{recognitionMode === "joint" ? "● " : "○ "}Вместе — дополнительно сопоставить все материалы</Text>
          </Pressable>
          <Text style={{ color: t.muted, fontSize: 12 }}>
            В режиме «Вместе» сначала распознаём каждый файл, затем отправляем полученный текст выбранной LLM для общего анализа. Это дополнительный запрос, время и возможные расходы. Для личных записей и закрытых коллекций этот режим недоступен.
          </Text>
        </View> : null}
        {(files.length > 1 || (kind !== "text" && kind !== "document" && !localAudio)) ? <NoteEditorSection testID="import-processing-options" title="Параметры распознавания" summary="Модель и подключение" expanded={processingOptionsOpen} onToggle={() => setProcessingOptionsOpen(v => !v)}>
          <Text style={{ color: t.muted, fontSize: 12 }}>Для локального OCR файлы не отправляются. Для прочих режимов выбранная модель может получить файл или кадры.</Text>
          <Text style={{ color: t.text, fontWeight: "600" }}>Подключение для разбора</Text>
          {connections.map(c => <Pressable disabled={busy} key={c.id} accessibilityRole="button" accessibilityLabel={"Разобрать через " + c.name} accessibilityState={{selected:connectionId === c.id,disabled:busy}} style={choiceStyle(connectionId === c.id, busy)} onPress={() => setConnectionId(c.id)}>
            <Text style={{ color: connectionId === c.id ? t.secondary : t.text }}>{connectionId === c.id ? "● " : "○ "}{c.name} · {c.model}</Text>
          </Pressable>)}
        </NoteEditorSection> : null}
        {files.some(item => ["audio", "video"].includes(mediaKind(item))) ? <View style={{ gap: 6 }}>
          <Text style={{ color: t.text, fontWeight: "700" }}>Распознавание речи из файла</Text>
          {([ ["device", "На телефоне · Whisper"], ["online", "Онлайн · OpenAI" ] ] as const).map(([id, label]) => <Pressable key={id} accessibilityRole="radio" accessibilityLabel={"Способ распознавания аудиофайла: " + label}
            accessibilityState={{ checked: fileAsrMode === id, disabled: busy }} disabled={busy} onPress={() => setFileAsrMode(id)}
            style={choiceStyle(fileAsrMode === id, busy)}><Text style={{ color: fileAsrMode === id ? t.secondary : t.text }}>{fileAsrMode === id ? "● " : "○ "}{label}</Text></Pressable>)}
          {fileAsrMode === "online" ? <>
            <Text style={{ color: t.muted, fontSize: 12 }}>Будет отправлен исходный звук; требуется разрешение на каждый запрос. Для личных и закрытых записей отправка запрещена.</Text>
            <Text style={{ color: t.text }}>Подключение для распознавания</Text>
            {connections.filter(c => officialAudioProvider(c)).map(c => <Pressable key={c.id} accessibilityRole="radio" accessibilityLabel={"Аудио через " + c.name}
              accessibilityState={{ checked: c.id === speechConnectionId, disabled: busy }} disabled={busy}
              onPress={() => setSpeechConnectionId(c.id)} style={choiceStyle(c.id === speechConnectionId, busy)}>
              <Text style={{ color: c.id === speechConnectionId ? t.secondary : t.text }}>{c.id === speechConnectionId ? "● " : "○ "}{c.name} · {c.transcriptionModel || "gpt-transcribe"}</Text>
            </Pressable>)}
            {!speechSelected || !officialAudioProvider(speechSelected) ? <Text style={{ color: t.err }}>Выберите подключение OpenAI с поддержкой аудиофайлов. Произвольный LLM/DeepSeek не подходит.</Text> : null}
          </> : whisper.state !== "ready" ? <Text style={{ color: t.muted, fontSize: 12 }}>Whisper пока не установлен. Скачайте его в настройках голосового ввода либо выберите онлайн.</Text> : null}
        </View> : null}
        {!extractedText && <Pressable disabled={busy || !canExtract} accessibilityRole="button" accessibilityLabel="Извлечь сведения из файла" style={[button, { opacity: canExtract ? 1 : .5 }]} onPress={() => void extract()}>
          <Text style={{ color: "#fff", fontWeight: "700" }}>{files.length > 1 ? recognitionMode === "joint" ? "Распознать и сопоставить" : "Распознать все по очереди" : kind === "text" ? "Прочитать текст на телефоне" : kind === "image" && imageExtractionMode === "offline-ocr" ? "Прочитать фото без интернета" : kind === "image" && imageExtractionMode === "document-text" ? "Отправить фото модели и прочитать текст" : kind === "document" && imageExtractionMode === "offline-ocr" ? "Распознать сканы PDF на телефоне" : kind === "document" ? "Прочитать страницы PDF на телефоне" : localAudio ? "Распознать речь на телефоне" : "Передать файл провайдеру и разобрать"}</Text>
        </Pressable>}
        {jointAnalyzing ? <Text accessibilityLiveRegion="polite" style={{ color: t.secondary }}>Сопоставляю результаты всех файлов…</Text> : null}
        {recognizingIndex >= 0 ? <Text accessibilityLiveRegion="polite" style={{ color: t.secondary }}>
          Распознаю файл {recognizingIndex + 1} из {files.length}: {files[recognizingIndex]?.name}
        </Text> : null}
        {recognitionResults.length > 0 && files.length > 1 ? recognitionResults.map(item =>
          <Text key={item.index} style={{ color: item.status === "error" ? t.err : t.muted }}>
            {item.index + 1}. {item.name}: {item.status === "success"
              ? item.pdfCoverage ? pdfCoverageMessage(item.pdfCoverage) : "Распознано" : "Не распознано — " + item.error}
          </Text>) : null}
        </NoteEditorSection> : null}
        {extractedText ? <>
          <Text style={{ color: t.text }}>Распознанный текст</Text>
          <TextInput accessibilityLabel="Распознанное содержимое файла" editable={!busy} multiline
            scrollEnabled value={extractedText} onChangeText={setExtractedText} maxLength={60_000}
            style={[field, { minHeight: 140, maxHeight: 188, textAlignVertical: "top" }]} />
          <NebulaAction icon="zap" label="Улучшить текст файла с ИИ" size="compact" disabled={busy} onPress={() => setAiField("extracted")} />
          {files.map((source, index) => <NebulaAction key={source.uri} icon="refresh-cw" size="compact"
            label={files.length === 1 ? "Распознать заново" : "Распознать заново · " + source.name}
            disabled={busy || !canExtractFile(source)} onPress={() => void extract(index)} />)}
        </> : null}
        <NoteEditorSection title="Дополнительные параметры" summary="Название и сохранение оригинала" expanded={detailsOpen} onToggle={() => setDetailsOpen(v => !v)}>
          <Text style={{ color: t.text }}>Название — необязательно</Text>
          <TextInput accessibilityLabel="Название импортируемой заметки" editable={!busy} value={title} onChangeText={setTitle} style={field} />
        {file ? <Pressable disabled={busy} accessibilityRole="checkbox" accessibilityState={{ checked: !keepOriginal }} onPress={() => setKeepOriginal(v => !v)} style={{ minHeight: 44 }}><Text style={{ color: t.secondary }}>{keepOriginal ? "□" : "☑"} Не сохранять оригинал — оставить только текст</Text></Pressable> : null}
          <Text style={{ color: t.muted, fontSize: 13 }}>Оригиналы хранятся зашифрованными. До 10 файлов и 80 МБ в одной записи.</Text>
        </NoteEditorSection>
        {file && !keepOriginal && !body.trim() && !extractedText.trim() ? <Text accessibilityRole="alert" style={{ color: t.muted }}>Добавьте подпись или распознайте файл, чтобы сохранить только текст.</Text> : null}
      </> : null}
    </ScrollView>
    {hasMaterial ? <View testID="import-save-bar" style={{ padding: 12, backgroundColor: t.bg, borderTopWidth: 1, borderTopColor: t.line }}>
      <Pressable disabled={saveDisabled} accessibilityRole="button" accessibilityState={{ disabled: saveDisabled }} accessibilityLabel="Сохранить сведения в память" style={[button, { opacity: saveDisabled ? .45 : 1 }]} onPress={() => { Keyboard.dismiss(); void save(); }}>
        <Text style={{ color: t.userText, fontWeight: "700" }}>{busy ? "Подождите…" : linkOnly ? "Сохранить ссылку" : "Сохранить в память"}</Text>
      </Pressable>
    </View> : null}
  </KeyboardAvoidingView>
  <NebulaConfirmSheet visible={leaveApproval}
    title="Закрыть без сохранения?"
    message="Несохранённые материалы будут отменены. Сохранённые заметки и оригиналы не затрагиваются."
    confirmLabel="Закрыть без сохранения" cancelLabel="Продолжить редактирование" danger disabled={busy || preparing}
    onCancel={() => { leaveAction.current = null; setLeaveApproval(false); }}
    onConfirm={() => { if (busy || preparing) return; setLeaveApproval(false); setLeaving(true); }} />
  <NebulaConfirmSheet visible={skipApproval !== null && skipApproval.profile === profile}
    title="Пропустить материал?"
    message="Текущий материал не будет сохранён. Следующий материал откроется для проверки без автоматического сохранения."
    confirmLabel="Пропустить материал без сохранения" cancelLabel="Оставить текущий материал" danger disabled={busy || preparing}
    onCancel={() => setSkipApproval(null)}
    onConfirm={() => {
      const approval = skipApproval; setSkipApproval(null);
      if (!approval || approval.profile !== profile || approval.position !== position ||
        !incoming || position + 1 >= incoming.length || busy || preparing) return;
      setPosition(p => p + 1);
    }} />
  <NebulaConfirmSheet visible={audioApproval !== null}
    title="Передать исходный звук?"
    message={`Выбранные аудио/видеофайлы будут отправлены через ${audioApproval?.service || "сервис"} (модель ${audioApproval?.model || "—"}). Возможны оплата и расход трафика (до 20 МБ на аудиофайл). Согласие только на этот запуск.`}
    confirmLabel="Отправить и распознать" cancelLabel="Не отправлять" disabled={busy || preparing}
    onCancel={() => setAudioApproval(null)}
    onConfirm={() => {
      const approval = audioApproval; setAudioApproval(null);
      if (!approval || !profile || approval.scope !== replacementScope() || busy || preparing || !file ||
        !files.some(item => ["audio", "video"].includes(mediaKind(item))) ||
        !speechSelected || !officialAudioProvider(speechSelected) || fileAsrMode !== "online" ||
        !providerApproved || !canExtract) {
        setNotice("Файл, подключение или доступ изменились. Проверьте параметры и подтвердите передачу заново.");
        return;
      }
      void extract(approval.index, true);
    }} />
  {aiField && profile ? <NoteAiEditor key={profile + position + aiField} profile={profile}
    allowed={providerApproved} draft={{title: "", body: aiField === "body" ? body : extractedText}}
    onClose={() => setAiField(null)} onApply={draft => {
      if (providerApproved) (aiField === "body" ? setBody : setExtractedText)(draft.body);
    }} /> : null}
  <BottomSheet visible={Boolean(comparison && comparison.scope === replacementScope())}
    title={"Сравнить текст · " + (comparison?.result.name ?? "")} onClose={() => setComparison(null)}>
    <NebulaAction icon="check" label="Применить новый" variant="primary" onPress={() => {
      if (!comparison || comparison.scope !== replacementScope()) return;
      setExtractedText(comparison.updated);
      setRecognitionResults(previous => [...previous.filter(item => item.index !== comparison.result.index), comparison.result].sort((a,b) => a.index-b.index));
      setComparison(null);
    }} />
    <NebulaAction icon="x" label="Оставить текущий" onPress={() => setComparison(null)} />
    <Text style={{color:t.secondary}}>Текущий текст</Text><Text selectable style={{color:t.text}}>{extractedText}</Text>
    <Text style={{color:t.secondary}}>После замены</Text><Text selectable style={{color:t.text}}>{comparison?.updated}</Text>
  </BottomSheet>
  <BottomSheet visible={sectionOpen} title="Коллекция для записи" onClose={() => setSectionOpen(false)}>
        {collections.map(c => <Pressable key={c.id} disabled={busy} accessibilityRole="button" accessibilityLabel={"Коллекция: " + c.name} onPress={() => { setCollectionId(c.id); setSectionOpen(false); }} style={choiceStyle(c.id === collectionId, busy)}><Text style={{ color: c.id === collectionId ? t.secondary : t.text }}>{c.id === collectionId ? "● " : "○ "}{c.name}</Text></Pressable>)}
  </BottomSheet>
  </View>;
}
