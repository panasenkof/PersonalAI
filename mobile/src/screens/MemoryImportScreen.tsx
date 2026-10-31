import { useNavigation, useRoute, usePreventRemove } from "@react-navigation/native";
import type { RouteProp } from "@react-navigation/native";
import { localMemoryRepository } from "../local-memory/repository";
import { ensureSections } from "../local-memory/sections";
import type { CollectionRecord } from "../local-memory/types";
import { loadMediaPreferences } from "../media/preferences";
import { onLocalMemorySessionChange } from "../local-memory/storage";
import * as ImagePicker from "expo-image-picker";
import { importLink, linkImportErrorMessage } from "../media/link-import";
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
import { combinedRecognitionText, recognizeFilesSequentially, type FileRecognition } from "../media/batch-recognition";
import { analyzeFilesTogether } from "../media/joint-recognition";
import { extractMedia, mediaKind } from "../media/extract";
import type { ImportFile } from "../media/extract";
import type { RootStackParams } from "../navigation";
import { withNativeInteraction } from "../security/native-interaction";
import { memoryErrorMessage } from "../local-memory/errors";
import { useTheme } from "../theme";
import { BottomSheet } from "../components/BottomSheet";
import { NoteEditorSection } from "../design/nebula/NoteEditorSection";
import { useWhisperStatus } from "../media/whisper";
import { scheduleIndexTerms } from "../direct-agent/enrich-runner";
import { scheduleVectors } from "../media/vector-runner";
import { discardCameraPhotoDraft83 } from "../media/vision-chat-camera";
import { autoIndexNotePhotos83 } from "../media/auto-index-note-photos";

export function MemoryImportScreen() {
  const route = useRoute<RouteProp<RootStackParams, "MemoryImport">>();
  const incoming = route.params?.incoming;
  const [keepOriginal, setKeepOriginal] = useState(true);
  const [sourceUrl, setSourceUrl] = useState(""); // Confirmed provenance only.
  const [linkDraft, setLinkDraft] = useState(""); // Unconfirmed URL never changes saved provenance.
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
  const [prepareAttempt, setPrepareAttempt] = useState(0);
  const [preparing, setPreparing] = useState(false);
  const whisper = useWhisperStatus();
  const t = useTheme();
  const header = useHeaderHeight(); const insets = useSafeAreaInsets();
  const profile = useProfile();
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParams>>();
  const [files, setFiles] = useState<ImportFile[]>([]);
  const file = files[0] || null;
  const [recognitionResults, setRecognitionResults] = useState<FileRecognition[]>([]);
  const [recognizingIndex, setRecognizingIndex] = useState(-1);
  const [recognitionMode, setRecognitionMode] = useState<"sequential" | "joint">("sequential");
  const [jointAnalyzing, setJointAnalyzing] = useState(false);
  const [connections, setConnections] = useState<DirectConnection[]>([]);
  const [connectionId, setConnectionId] = useState("");
  const [speechConnectionId, setSpeechConnectionId] = useState("");
  const [classification, setClassification] = useState<"sensitive" | "standard">("standard");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [extractedText, setExtractedText] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const alive = useRef(true);
  const controller = useRef<AbortController | null>(null);
  const ownedFiles = useRef<string[]>([]);
  useEffect(() => {
    alive.current = true;
    if (profile) void Promise.all([loadDirectConnections(profile), loadMediaPreferences(profile)]).then(([v, prefs]) => {
      if (alive.current) { setConnections(v.connections); setConnectionId(prefs.visionId || v.activeId); setSpeechConnectionId(prefs.speechId || v.activeId); }
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
    let cancelled = false; let staged: File | undefined;
    const cleanup = () => { try { if (staged?.exists) staged.delete(); } catch { /* Cache may already be removed. */ } };
    const off = onLocalMemorySessionChange(unlocked => {
      if (unlocked) return;
      cancelled = true; cleanup(); setFiles([]); setPreparing(false);
      setNotice("Подготовка прервана блокировкой. Повторите приём после разблокировки.");
    });
    setPreparing(true); setTitle(""); setFiles([]); setRecognitionResults([]); setRecognizingIndex(-1); setBody(""); setExtractedText(""); setNotice(""); setSourceUrl(""); setLinkDraft(""); setSourcePickerOpen(false); setProcessingOptionsOpen(false); setKeepOriginal(true);
    void (async () => {
      if (incoming!.length > 30) throw new Error("Отправляйте не более 30 файлов за один раз.");
      const text = payload.shareType === "text" || payload.shareType === "url";
      if (!payload.value || (text && payload.value.length > 60_000)) throw new Error("Пустой или слишком длинный материал.");
      if (text) { if (!cancelled) { if (payload.shareType === "url") { setSourceUrl(payload.value); setLinkDraft(payload.value); } setTitle(payload.shareType === "url" ? "Ссылка" : payload.value.split("\n")[0].slice(0, 160)); setBody(payload.value); } return; }
      const source = new File(payload.value);
      const dir = new Directory(Paths.cache, "persai-incoming"); dir.create({ intermediates: true, idempotent: true });
      const target = new File(dir, Crypto.randomUUID()); staged = target;
      await FileSystem.copyAsync({ from: payload.value, to: target.uri });
      if (cancelled) { cleanup(); return; }
      ownedFiles.current.push(target.uri);
      const asset = { uri: target.uri, name: source.name || "Входящий файл", mimeType: payload.mimeType };
      mediaKind(asset); setFiles([asset]); setRecognitionResults([]); setTitle(asset.name.slice(0, 160));
    })().catch(e => { cleanup(); if (!cancelled) setNotice(memoryErrorMessage(e)); }).finally(() => { if (!cancelled) setPreparing(false); });
    return () => { cancelled = true; off(); cleanup(); };
  }, [incoming, position, prepareAttempt]);
  usePreventRemove(!leaving && Boolean(incoming || file || body || extractedText || linkDraft.trim()), ({ data }) => {
    if (busy) { setNotice("Дождитесь завершения операции или остановите её."); return; }
    Alert.alert("Закрыть без сохранения?", "Несохранённые материалы будут отменены.", [{ text: "Продолжить", style: "cancel" }, { text: "Закрыть", style: "destructive", onPress: () => navigation.dispatch(data.action) }]);
  });
  useEffect(() => { if (leaving) navigation.goBack(); }, [leaving, navigation]);
  useEffect(() => onLocalMemorySessionChange(unlocked => { if (!unlocked) controller.current?.abort(); }), []);
  const selected = connections.find(c => c.id === connectionId);
  const kind = file ? mediaKind(file) : null;
  const localAudio = kind === "audio" && whisper.state === "ready";
  const speechSelected = connections.find(c => c.id === speechConnectionId);
  const processor = kind === "audio" ? speechSelected : selected;
  const canExtract = files.some(item => {
    const currentKind = mediaKind(item);
    const currentProcessor = currentKind === "audio" ? speechSelected : selected;
    return currentKind === "text" || currentKind === "document" ||
      (currentKind === "audio" && whisper.state === "ready") ||
      (currentKind === "video" && whisper.state === "ready") ||
      Boolean(currentProcessor && classification === "standard" && (currentProcessor.apiKey || anonymousLocalAllowed(currentProcessor)) &&
        !(currentKind === "audio" && currentProcessor.provider === "anthropic"));
  });
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
      setFiles(copies); setRecognitionResults([]); setTitle(""); setSourceUrl(""); setLinkDraft(""); setSourcePickerOpen(false); setProcessingOptionsOpen(false); setKeepOriginal(true); setExtractedText(""); setBody("");
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
      setTitle("Снимок"); setSourceUrl(""); setLinkDraft(""); setSourcePickerOpen(false); setProcessingOptionsOpen(false); setKeepOriginal(true); setExtractedText(""); setBody("");
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
  async function readLink() {
    if (busy) return;
    const aborter = new AbortController(); controller.current = aborter; setBusy(true); setNotice("");
    try {
      const result = await importLink(linkDraft, aborter.signal);
      if (!alive.current || aborter.signal.aborted) { if (result.file) await FileSystem.deleteAsync(result.file.uri, { idempotent: true }); return; }
      if (result.file) { ownedFiles.current.push(result.file.uri); setFiles([result.file]); setExtractedText(""); setKeepOriginal(true); setTitle(result.file.name); }
      else { setFiles([]); setExtractedText(result.text || ""); setKeepOriginal(false); setTitle("Материал по ссылке"); }
      setRecognitionResults([]);
      setSourceUrl(result.source); setLinkDraft(result.source); setSourcePickerOpen(false); setProcessingOptionsOpen(false); setBody("");
    } catch (e) { if (alive.current) setNotice(linkImportErrorMessage(e)); }
    finally { if (alive.current) setBusy(false); }
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
      setSourceUrl(""); setLinkDraft(""); setSourcePickerOpen(false); setProcessingOptionsOpen(false);
      setKeepOriginal(true); setTitle(chosen[0].name.slice(0, 160)); setBody(""); setExtractedText(""); setClassification("standard");
    } catch (e) { if (alive.current) setNotice((e as Error).message); }
    finally { if (alive.current) setPreparing(false); }
  }
  async function extract() {
    if (!file || !canExtract || busy) return;
    const aborter = new AbortController(); controller.current = aborter; setBusy(true); setNotice("");
    try {
      const vision = selected || { ...defaultDirectPreferences, apiKey: "", webSearchKey: "" };
      const speech = connections.find(c => c.id === speechConnectionId) || selected;
      if (files.length === 1) {
        let timedSegments: FileRecognition["segments"];
        const text = await extractMedia(file, vision, classification === "standard", aborter.signal, undefined, speech,
          segments => { timedSegments = segments; });
        if (alive.current && !aborter.signal.aborted) {
          setRecognitionResults([{ index: 0, name: file.name, status: "success", text,
            ...(timedSegments ? { segments: timedSegments } : {}) }]);
          setExtractedText(text);
          setNotice("Проверьте и отредактируйте текст. В памяти он появится после сохранения.");
        }
      } else {
        const segmentsByFile = new Map<number, NonNullable<FileRecognition["segments"]>>();
        const rawResults = await recognizeFilesSequentially(files,
          async (item, index) => extractMedia(item, vision, classification === "standard",
            aborter.signal, undefined, speech, segments => { segmentsByFile.set(index, segments); }),
          aborter.signal, (done, current) => {
            if (alive.current) {
              setRecognitionResults(done);
              setRecognizingIndex(current < files.length ? current : -1);
              try { setExtractedText(combinedRecognitionText(done, files.length)); } catch { /* final length check reports failure */ }
            }
          });
        const results = rawResults.map(item => item.status === "success" && segmentsByFile.has(item.index)
          ? { ...item, segments: segmentsByFile.get(item.index)! } : item);
        if (alive.current && !aborter.signal.aborted) {
          setRecognitionResults(results);
          const text = combinedRecognitionText(results, files.length);
          // Keep the original per-file text, even when the additional joint
          // request fails; that failure must never erase recognized sources.
          setExtractedText(text);
          const errors = results.filter(r => r.status === "error").length;
          if (recognitionMode === "joint" && results.some(r => r.status === "success")) {
            if (classification !== "standard") throw new Error("Для совместного анализа разрешите обработку обычных записей выбранным подключением.");
            setJointAnalyzing(true);
            try {
              const analysis = await analyzeFilesTogether(results.filter(r => r.status === "success" && r.text).map(r => ({ index: r.index, name: r.name, text: r.text! })),
                vision, true, aborter.signal);
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
    if (!keepOriginal && !body.trim() && !extractedText.trim()) { setNotice("Добавьте текст или распознайте материал перед сохранением без оригинала."); return; }
    if (!profile || (!file && !body.trim() && !extractedText.trim()) || busy || preparing) return;
    setBusy(true); setNotice("");
    try {
      const aborter = new AbortController(); controller.current = aborter;
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
        sourceUrl: sourceUrl || undefined, sensitivity: classification, collectionId: collectionId || undefined,
        ...(incoming ? { receipt: JSON.stringify(incoming[position]) } : {}),
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
      if (alive.current) { if (incoming && position + 1 < incoming.length) setPosition(p => p + 1); else setLeaving(true); }
    } catch (e) { if (alive.current) setNotice("Не удалось сохранить: " + memoryErrorMessage(e)); }
    finally { if (alive.current) setBusy(false); }
  }
  const hasMaterial = Boolean(file || extractedText || (incoming && !preparing));
  const saveDisabled = busy || preparing || (!body.trim() && !extractedText.trim() && !(file && keepOriginal));
  return <View style={{ flex: 1, backgroundColor: t.bg, paddingBottom: keyboardOpen ? 0 : insets.bottom }}>
  <KeyboardAvoidingView style={{ flex: 1 }} behavior={Platform.OS === "ios" ? "padding" : "height"} keyboardVerticalOffset={Platform.OS === "ios" ? header : 0}>
    <ScrollView keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag" contentContainerStyle={{ padding: 18, gap: 15, paddingBottom: 24 }}>
      <Text accessibilityRole="header" style={{ color: t.text, fontSize: 25, fontWeight: "800" }}>{incoming ? `Новая заметка · ${position + 1}/${incoming.length}` : file || extractedText ? "Проверьте и сохраните" : sourceChoice === "link" ? "Добавить ссылку" : sourceChoice === "file" ? "Файл" : sourceChoice === "camera" ? "Камера" : sourceChoice === "gallery" ? "Галерея" : "Выберите материал"}</Text>
      {!hasMaterial && !sourceChoice ? <Text style={{ color: t.muted, lineHeight: 21 }}>Фото, документы и ссылки сохраняются в заметку. Распознавание — по вашему выбору.</Text> : null}

      {incoming ? <Text style={{ color: t.muted }}>Получено через «Поделиться». Сохранение — только после подтверждения.</Text> : null}
      {!incoming && (file || extractedText) && !sourcePickerOpen ? <Pressable disabled={busy || preparing} accessibilityRole="button" accessibilityLabel="Заменить вложение" onPress={() => { setSourceChoice(undefined); setSourcePickerOpen(true); }}
        style={{ minHeight: 48, justifyContent: "center", padding: 12, backgroundColor: t.panel, borderColor: t.line, borderWidth: 1, borderRadius: 14 }}>
        <Text style={{ color: t.secondary, fontWeight: "700" }}>Заменить вложение</Text>
      </Pressable> : null}
      {!incoming && (sourcePickerOpen || (!file && !extractedText)) ? <View testID="import-source-choices" style={{ gap: 12, padding: 14, borderRadius: 18, borderWidth: 1, borderColor: t.line, backgroundColor: t.panel }}>
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
        <Text style={{ color: t.muted, fontSize: 13, lineHeight: 20 }}>Ссылка должна открываться без входа на сайт.</Text>
        </> : null}
        {hasMaterial ? <Pressable accessibilityRole="button" disabled={busy || preparing} style={button} onPress={cancelPicker}><Text style={{color:t.userText}}>Оставить текущее</Text></Pressable> : null}
      </View> : null}
      {!file && extractedText ? <Text style={{ color: t.muted, fontSize: 12 }}>Выбранный источник: текст по ссылке</Text> : null}
      {preparing ? <ActivityIndicator accessibilityLabel="Подготовка входящего файла" /> : null}

      {file ? <View style={{ backgroundColor: t.panel, padding: 16, borderRadius: 20, borderWidth: 1, borderColor: t.line, gap: 10 }}>
        <Text style={{ color: t.text, fontWeight: "700" }}>{files.length > 1 ? "Вложения · " + files.length : file.name}</Text>
        {files.length > 1 ? files.map((item, index) => <Text key={index} style={{ color: t.muted }}>
          {index + 1}. {item.name} · {mediaKind(item)}
        </Text>) : null}
        {kind === "image" ? <Image source={{ uri: file.uri }} resizeMode="contain" style={{ width: "100%", height: 180, borderRadius: 14 }} /> : null}
      </View> : null}
      {busy ? <><ActivityIndicator /><Pressable accessibilityRole="button" onPress={() => controller.current?.abort()} style={{ minHeight: 44 }}><Text style={{ color: t.err }}>Остановить</Text></Pressable></> : null}
      {incoming && !preparing ? <View style={{ flexDirection: "row", gap: 16 }}>
        <Pressable disabled={busy} style={{ minHeight: 44 }} onPress={() => setPrepareAttempt(n => n + 1)}><Text style={{ color: t.secondary }}>Повторить подготовку</Text></Pressable>
        {position + 1 < incoming.length ? <Pressable disabled={busy} style={{ minHeight: 44 }} onPress={() => Alert.alert("Пропустить материал?", "Этот материал не будет сохранён.", [{ text: "Отмена", style: "cancel" }, { text: "Пропустить", onPress: () => setPosition(p => p + 1) }])}><Text style={{ color: t.secondary }}>Пропустить</Text></Pressable> : null}
      </View> : null}
      {notice ? <Text accessibilityRole="alert" style={{ color: t.muted }}>{notice}</Text> : null}
      {hasMaterial ? <>
        <TextInput accessibilityLabel="Сведения из файла" editable={!busy} multiline value={body} onChangeText={setBody} maxLength={60_000} style={[field, { minHeight: 96, textAlignVertical: "top" }]} placeholder="Добавьте подпись — необязательно" placeholderTextColor={t.muted} />
        <Pressable accessibilityRole="button" accessibilityLabel="Выбрать коллекцию" disabled={busy} onPress={() => { Keyboard.dismiss(); setSectionOpen(true); }} style={{ ...button, backgroundColor: t.panel, alignItems: "flex-start" }}><Text style={{ color: t.text }}>Коллекция: {collections.find(c => c.id === collectionId)?.name || "Заметки"} · Изменить</Text></Pressable>
        {collections.find(c => c.id === collectionId)?.sensitivity !== "standard" ? <Text style={{ color: t.muted }}>Выбранная коллекция закрыта для агента независимо от настройки записи.</Text> : null}
        <Text style={{ color: t.text, fontWeight: "600" }}>Доступ к записи</Text>
        {([ ["sensitive", "Личные — только на телефоне"], ["standard", "Обычные — доступны агенту и разбору у провайдера"] ] as const).map(([id, label]) =>
          <Pressable disabled={busy} key={id} accessibilityRole="button" accessibilityLabel={label} onPress={() => { setClassification(id); if (id === "sensitive") setRecognitionMode("sequential"); }} style={{ minHeight: 46, justifyContent: "center" }}>
            <Text style={{ color: classification === id ? t.secondary : t.text }}>{classification === id ? "● " : "○ "}{label}</Text>
          </Pressable>)}
        {file ? <NoteEditorSection title="Распознавание" summary={extractedText ? "Текст получен · можно повторить" : "Необязательно · для поиска по содержимому"} expanded={recognitionOpen} onToggle={() => setRecognitionOpen(v => !v)}>
        <Text style={{ color: t.muted, fontSize: 12 }}>{kind === "video" ? "Речь и пять выборочных кадров обрабатываются отдельно. Максимум 10 минут; частичные результаты явно отмечены." : kind === "audio" ? (localAudio ? "Речь распознаётся на телефоне моделью Whisper; файл никуда не отправляется." : "Речь преобразуется в текст сервисом подключения. Чтобы распознавать на телефоне, скачайте модель: Настройки → Голосовой ввод → Голос без интернета.") : kind === "text" ? "Текстовый файл читается на телефоне, без отправки в интернет." : kind === "document" ? "PDF читается локально на Android 15+ при наличии текстового слоя. Скан без текста можно сохранить как оригинал." : "Выбранная модель должна поддерживать изображения."}</Text>
        {files.length > 1 ? <View style={{ gap: 6 }}>
          <Text style={{ color: t.text, fontWeight: "700" }}>Режим распознавания</Text>
          <Pressable disabled={busy} accessibilityRole="button" accessibilityLabel="Распознавать по очереди"
            accessibilityState={{ selected: recognitionMode === "sequential" }} onPress={() => setRecognitionMode("sequential")}
            style={{ minHeight: 44, justifyContent: "center" }}>
            <Text style={{ color: recognitionMode === "sequential" ? t.secondary : t.text }}>{recognitionMode === "sequential" ? "● " : "○ "}По очереди — результат каждого файла отдельно</Text>
          </Pressable>
          <Pressable disabled={busy || classification !== "standard"} accessibilityRole="button" accessibilityLabel="Распознавать вместе"
            accessibilityState={{ selected: recognitionMode === "joint", disabled: classification !== "standard" }} onPress={() => setRecognitionMode("joint")}
            style={{ minHeight: 44, justifyContent: "center", opacity: classification === "standard" ? 1 : .5 }}>
            <Text style={{ color: recognitionMode === "joint" ? t.secondary : t.text }}>{recognitionMode === "joint" ? "● " : "○ "}Вместе — дополнительно сопоставить все материалы</Text>
          </Pressable>
          <Text style={{ color: t.muted, fontSize: 12 }}>
            В режиме «Вместе» сначала распознаём каждый файл, затем отправляем полученный текст выбранной LLM для общего анализа. Это дополнительный запрос, время и возможные расходы. Для личных записей этот режим недоступен.
          </Text>
        </View> : null}
        {(files.length > 1 || (kind !== "text" && kind !== "document" && !localAudio)) ? <NoteEditorSection testID="import-processing-options" title="Параметры распознавания" summary="Модель и подключение" expanded={processingOptionsOpen} onToggle={() => setProcessingOptionsOpen(v => !v)}>
          <Text style={{ color: t.muted, fontSize: 12 }}>При разборе файл или кадры отправляются выбранному сервису.</Text>
          <Text style={{ color: t.text, fontWeight: "600" }}>Подключение для разбора</Text>
          {connections.map(c => <Pressable disabled={busy} key={c.id} accessibilityRole="button" accessibilityLabel={"Разобрать через " + c.name} style={{ minHeight: 44, justifyContent: "center" }} onPress={() => setConnectionId(c.id)}>
            <Text style={{ color: connectionId === c.id ? t.secondary : t.text }}>{connectionId === c.id ? "● " : "○ "}{c.name} · {c.model}</Text>
          </Pressable>)}
          {kind === "audio" && selected?.provider === "anthropic" ? <Text style={{ color: t.err }}>Для аудио выберите OpenAI-совместимое подключение с распознаванием речи.</Text> : null}
        </NoteEditorSection> : null}
        {files.some(item => ["audio", "video"].includes(mediaKind(item))) ? <View><Text style={{ color: t.text }}>Подключение для речи (локальный Whisper имеет приоритет)</Text>{connections.map(c => <Pressable key={c.id} disabled={busy} onPress={() => setSpeechConnectionId(c.id)} style={{ minHeight: 44 }}><Text style={{ color: c.id === speechConnectionId ? t.secondary : t.text }}>{c.id === speechConnectionId ? "● " : "○ "}{c.name} · {c.transcriptionModel || "whisper-1"}</Text></Pressable>)}</View> : null}
        <Pressable disabled={busy || !canExtract} accessibilityRole="button" accessibilityLabel="Извлечь сведения из файла" style={[button, { opacity: canExtract ? 1 : .5 }]} onPress={() => void extract()}>
          <Text style={{ color: "#fff", fontWeight: "700" }}>{files.length > 1 ? recognitionMode === "joint" ? "Распознать и сопоставить" : "Распознать все по очереди" : kind === "text" ? "Прочитать текст на телефоне" : kind === "document" ? "Прочитать страницы PDF на телефоне" : localAudio ? "Распознать речь на телефоне" : "Передать файл провайдеру и разобрать"}</Text>
        </Pressable>
        {jointAnalyzing ? <Text accessibilityLiveRegion="polite" style={{ color: t.secondary }}>Сопоставляю результаты всех файлов…</Text> : null}
        {recognizingIndex >= 0 ? <Text accessibilityLiveRegion="polite" style={{ color: t.secondary }}>
          Распознаю файл {recognizingIndex + 1} из {files.length}: {files[recognizingIndex]?.name}
        </Text> : null}
        {recognitionResults.length > 0 && files.length > 1 ? recognitionResults.map(item =>
          <Text key={item.index} style={{ color: item.status === "error" ? t.err : t.muted }}>
            {item.index + 1}. {item.name}: {item.status === "success" ? "Распознано" : "Не распознано — " + item.error}
          </Text>) : null}
        </NoteEditorSection> : null}
        {extractedText ? <>
          <Text style={{ color: t.text }}>Распознанный текст</Text>
          <TextInput accessibilityLabel="Распознанное содержимое файла" editable={!busy} multiline value={extractedText} onChangeText={setExtractedText} maxLength={60_000} style={field} />
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
        <Text style={{ color: t.userText, fontWeight: "700" }}>{busy ? "Подождите…" : "Сохранить в память"}</Text>
      </Pressable>
    </View> : null}
  </KeyboardAvoidingView>
  <BottomSheet visible={sectionOpen} title="Коллекция для записи" onClose={() => setSectionOpen(false)}>
        {collections.map(c => <Pressable key={c.id} disabled={busy} accessibilityRole="button" accessibilityLabel={"Коллекция: " + c.name} onPress={() => { setCollectionId(c.id); setSectionOpen(false); }} style={{ minHeight: 44 }}><Text style={{ color: c.id === collectionId ? t.secondary : t.text }}>{c.id === collectionId ? "● " : "○ "}{c.name}</Text></Pressable>)}
  </BottomSheet>
  </View>;
}
