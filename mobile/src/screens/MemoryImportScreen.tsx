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
import { ActivityIndicator, Alert, Image, KeyboardAvoidingView, Platform, Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { useProfile } from "../profile/ProfileContext";
import { loadDirectConnections, anonymousLocalAllowed, defaultDirectPreferences } from "../direct-agent/settings";
import type { DirectConnection } from "../direct-agent/settings";
import { saveMediaNote } from "../media/attachments";
import { extractMedia, mediaKind } from "../media/extract";
import type { ImportFile } from "../media/extract";
import type { RootStackParams } from "../navigation";
import { withNativeInteraction } from "../security/native-interaction";
import { memoryErrorMessage } from "../local-memory/errors";
import { useTheme } from "../theme";
import { NoteEditorSection } from "../design/nebula/NoteEditorSection";
import { useWhisperStatus } from "../media/whisper";
import { scheduleIndexTerms } from "../direct-agent/enrich-runner";
import { scheduleVectors } from "../media/vector-runner";

export function MemoryImportScreen() {
  const route = useRoute<RouteProp<RootStackParams, "MemoryImport">>();
  const incoming = route.params?.incoming;
  const [keepOriginal, setKeepOriginal] = useState(true);
  const [sourceUrl, setSourceUrl] = useState(""); // Confirmed provenance only.
  const [linkDraft, setLinkDraft] = useState(""); // Unconfirmed URL never changes saved provenance.
  const [sourcePickerOpen, setSourcePickerOpen] = useState(true);
  const [processingOptionsOpen, setProcessingOptionsOpen] = useState(false);
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
  const [file, setFile] = useState<ImportFile | null>(null);
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
    if (alive.current) { setCollections(cols); setCollectionId(cols.find(c => c.slug === "notes")?.id || ""); }
  }).catch(() => { if (alive.current) setNotice("Не удалось загрузить разделы."); }); }, [profile]);
  useEffect(() => {
    const payload = incoming?.[position]; if (!payload) return;
    let cancelled = false;
    setPreparing(true); setTitle(""); setFile(null); setBody(""); setExtractedText(""); setNotice(""); setSourceUrl(""); setLinkDraft(""); setSourcePickerOpen(false); setProcessingOptionsOpen(false); setKeepOriginal(true);
    void (async () => {
      if (incoming!.length > 30) throw new Error("Отправляйте не более 30 файлов за один раз.");
      const text = payload.shareType === "text" || payload.shareType === "url";
      if (!payload.value || (text && payload.value.length > 60_000)) throw new Error("Пустой или слишком длинный материал.");
      if (text) { if (!cancelled) { if (payload.shareType === "url") { setSourceUrl(payload.value); setLinkDraft(payload.value); } setTitle(payload.shareType === "url" ? "Ссылка" : payload.value.split("\n")[0].slice(0, 160)); setBody(payload.value); } return; }
      const source = new File(payload.value);
      const dir = new Directory(Paths.cache, "persai-incoming"); dir.create({ intermediates: true, idempotent: true });
      const target = new File(dir, Crypto.randomUUID());
      await FileSystem.copyAsync({ from: payload.value, to: target.uri });
      if (cancelled) { if (target.exists) target.delete(); return; }
      ownedFiles.current.push(target.uri);
      const asset = { uri: target.uri, name: source.name || "Входящий файл", mimeType: payload.mimeType };
      mediaKind(asset); setFile(asset); setTitle(asset.name.slice(0, 160));
    })().catch(e => { if (!cancelled) setNotice(memoryErrorMessage(e)); }).finally(() => { if (!cancelled) setPreparing(false); });
    return () => { cancelled = true; };
  }, [incoming, position, prepareAttempt]);
  usePreventRemove(!leaving && Boolean(incoming || file || body || extractedText), ({ data }) => {
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
  const canExtract = kind === "text" || localAudio || (kind === "video" && whisper.state === "ready") || Boolean(processor && classification === "standard" &&
    (processor.apiKey || anonymousLocalAllowed(processor)) && !(kind === "audio" && processor.provider === "anthropic"));
  const field = { color: t.text, backgroundColor: t.panel, borderWidth: 1, borderColor: t.line, borderRadius: 16, padding: 14, minHeight: 50 };
  const button = { backgroundColor: t.accent, padding: 14, borderRadius: 17, minHeight: 50, justifyContent: "center" as const, alignItems: "center" as const };

  async function camera() {
    try {
      const permission = await withNativeInteraction(() => ImagePicker.requestCameraPermissionsAsync());
      if (!permission.granted) throw new Error("Разрешите камеру в настройках телефона.");
      const shot = await withNativeInteraction(() => ImagePicker.launchCameraAsync({ mediaTypes: ["images"], quality: 1 }));
      if (shot.canceled || !alive.current) return;
      const asset = shot.assets[0];
      const dir = new Directory(Paths.cache, "persai-incoming"); dir.create({ intermediates: true, idempotent: true });
      const target = new File(dir, Crypto.randomUUID() + ".jpg");
      try { await FileSystem.copyAsync({ from: asset.uri, to: target.uri }); }
      finally { await FileSystem.deleteAsync(asset.uri, { idempotent: true }); }
      if (!alive.current) { if (target.exists) target.delete(); return; }
      ownedFiles.current.push(target.uri);
      setFile({ uri: target.uri, name: asset.fileName || "camera.jpg", mimeType: asset.mimeType || "image/jpeg" });
      setTitle("Снимок"); setSourceUrl(""); setLinkDraft(""); setSourcePickerOpen(false); setProcessingOptionsOpen(false); setKeepOriginal(false); setExtractedText(""); setBody("");
    } catch (e) { if (alive.current) setNotice(memoryErrorMessage(e)); }
  }
  useEffect(() => { if (route.params?.camera && !cameraStarted.current) { cameraStarted.current = true; void camera(); } }, [route.params?.camera]);
  async function readLink() {
    if (busy) return;
    const aborter = new AbortController(); controller.current = aborter; setBusy(true); setNotice("");
    try {
      const result = await importLink(linkDraft, aborter.signal);
      if (!alive.current || aborter.signal.aborted) { if (result.file) await FileSystem.deleteAsync(result.file.uri, { idempotent: true }); return; }
      if (result.file) { ownedFiles.current.push(result.file.uri); setFile(result.file); setExtractedText(""); setKeepOriginal(true); setTitle(result.file.name); }
      else { setFile(null); setExtractedText(result.text || ""); setKeepOriginal(false); setTitle("Материал по ссылке"); }
      setSourceUrl(result.source); setLinkDraft(result.source); setSourcePickerOpen(false); setProcessingOptionsOpen(false); setBody("");
    } catch (e) { if (alive.current) setNotice(linkImportErrorMessage(e)); }
    finally { if (alive.current) setBusy(false); }
  }
  async function pick() {
    setNotice("");
    try {
      const result = await withNativeInteraction(() => DocumentPicker.getDocumentAsync({
        type: ["image/*", "audio/*", "video/*", "text/*", "application/json"], copyToCacheDirectory: true, multiple: false,
      }));
      if (!alive.current || result.canceled || !result.assets.length) return;
      const asset = result.assets[0];
      if (FileSystem.cacheDirectory && asset.uri.startsWith(FileSystem.cacheDirectory)) ownedFiles.current.push(asset.uri);
      mediaKind(asset);
      setFile(asset); setSourceUrl(""); setLinkDraft(""); setSourcePickerOpen(false); setProcessingOptionsOpen(false); setKeepOriginal(true); setTitle(asset.name.slice(0, 160)); setBody(""); setExtractedText(""); setClassification("standard");
    } catch (e) { if (alive.current) setNotice((e as Error).message); }
  }
  async function extract() {
    if (!file || !canExtract || busy) return;
    const aborter = new AbortController(); controller.current = aborter; setBusy(true); setNotice("");
    try {
      const text = await extractMedia(file, selected || { ...defaultDirectPreferences, apiKey: "", webSearchKey: "" }, classification === "standard", aborter.signal, undefined, connections.find(c => c.id === speechConnectionId) || selected);
      if (alive.current && !aborter.signal.aborted) { setExtractedText(text); setNotice("Проверьте и отредактируйте текст. В памяти он появится после сохранения."); }
    } catch (e) { if (alive.current) setNotice(aborter.signal.aborted ? "Разбор остановлен." : (e as Error).message); }
    finally { if (alive.current) setBusy(false); if (controller.current === aborter) controller.current = null; }
  }
  async function save() {
    if (!keepOriginal && !body.trim() && !extractedText.trim()) { setNotice("Добавьте текст или распознайте материал перед сохранением без оригинала."); return; }
    if (!profile || (!file && !body.trim() && !extractedText.trim()) || busy || preparing) return;
    setBusy(true); setNotice("");
    try {
      const aborter = new AbortController(); controller.current = aborter;
      const content = !extractedText.trim() && file && mediaKind(file) === "text"
        ? await extractMedia(file, selected || { ...defaultDirectPreferences, apiKey: "", webSearchKey: "" }, false, aborter.signal)
        : extractedText;
      await saveMediaNote(profile, { file: keepOriginal ? file || undefined : undefined, title, body, extractedText: content, sourceUrl: sourceUrl || undefined, sensitivity: classification, collectionId: collectionId || undefined, ...(incoming ? { receipt: JSON.stringify(incoming[position]) } : {}) }, aborter.signal);
      scheduleIndexTerms(profile); scheduleVectors(profile);
      if (!keepOriginal && file) { await FileSystem.deleteAsync(file.uri, { idempotent: true }).catch(() => {}); }
      if (alive.current) { if (incoming && position + 1 < incoming.length) setPosition(p => p + 1); else setLeaving(true); }
    } catch (e) { if (alive.current) setNotice("Не удалось сохранить: " + memoryErrorMessage(e)); }
    finally { if (alive.current) setBusy(false); }
  }
  return <KeyboardAvoidingView style={{ flex: 1, backgroundColor: t.bg }} behavior={Platform.OS === "ios" ? "padding" : undefined} keyboardVerticalOffset={header}>
    <ScrollView keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag" contentContainerStyle={{ padding: 18, gap: 15, paddingBottom: insets.bottom + 24 }}>
      <Text accessibilityRole="header" style={{ color: t.text, fontSize: 25, fontWeight: "800" }}>{incoming ? `Новая заметка · ${position + 1}/${incoming.length}` : "Добавить в память"}</Text>
      <Text style={{ color: t.muted, lineHeight: 21 }}>Выберите источник, проверьте текст и сохраните. Распознавание необязательно; сохранённый оригинал шифруется.</Text>
      <Text accessibilityRole="header" style={{ color: t.text, fontSize: 18, fontWeight: "700" }}>1 · Источник</Text>
      {incoming ? <Text style={{ color: t.muted }}>Получено через «Поделиться». Сохранение — только после подтверждения.</Text> : null}
      {!incoming && (file || extractedText) && !sourcePickerOpen ? <Pressable disabled={busy || preparing} accessibilityRole="button" accessibilityLabel="Изменить источник" onPress={() => setSourcePickerOpen(true)}
        style={{ minHeight: 48, justifyContent: "center", padding: 12, backgroundColor: t.panel, borderColor: t.line, borderWidth: 1, borderRadius: 14 }}>
        <Text style={{ color: t.secondary, fontWeight: "700" }}>Изменить источник</Text>
        <Text style={{ color: t.muted, fontSize: 12 }}>Текущий материал останется до успешного выбора другого.</Text>
      </Pressable> : null}
      {!incoming && (sourcePickerOpen || (!file && !extractedText)) ? <View testID="import-source-choices" style={{ gap: 12, padding: 14, borderRadius: 18, borderWidth: 1, borderColor: t.line, backgroundColor: t.panel }}>
        <Pressable disabled={busy || preparing} accessibilityRole="button" accessibilityLabel="Выбрать файл для памяти" style={button} onPress={() => void pick()}><Text style={{ color: "#fff", fontWeight: "700" }}>Выбрать файл с телефона</Text></Pressable>
        <Pressable disabled={busy || preparing} accessibilityRole="button" accessibilityLabel="Сфотографировать и распознать" style={button} onPress={() => void camera()}><Text style={{ color: "#fff" }}>Сфотографировать</Text></Pressable>
        <Text style={{ color: t.text, fontWeight: "600" }}>Или публичная HTTPS-ссылка</Text>
        <TextInput accessibilityLabel="Ссылка для импорта" value={linkDraft} onChangeText={setLinkDraft} editable={!busy} placeholder="https://…" placeholderTextColor={t.muted} style={field} />
        <Pressable disabled={busy || !linkDraft.trim()} accessibilityRole="button" style={[button, { opacity: busy || !linkDraft.trim() ? .5 : 1 }]} onPress={() => void readLink()}><Text style={{ color: "#fff" }}>Загрузить по ссылке</Text></Pressable>
        <Text style={{ color: t.muted, fontSize: 12 }}>Без cookies и ключей. Закрытые сайты и перенаправления не поддерживаются.</Text>
      </View> : null}
      {file || extractedText ? <Text style={{ color: t.muted, fontSize: 12 }}>Выбранный источник: {file ? file.name : "Текст по ссылке"}</Text> : null}
      {preparing ? <ActivityIndicator accessibilityLabel="Подготовка входящего файла" /> : null}
      {file || extractedText ? <Text accessibilityRole="header" style={{ color: t.text, fontSize: 18, fontWeight: "700" }}>2 · Предпросмотр и распознавание</Text> : null}
      {file ? <View style={{ backgroundColor: t.panel, padding: 16, borderRadius: 20, borderWidth: 1, borderColor: t.line, gap: 10 }}>
        <Text style={{ color: t.text, fontWeight: "700" }}>{file.name}</Text>
        {kind === "image" ? <Image source={{ uri: file.uri }} resizeMode="contain" style={{ width: "100%", height: 180, borderRadius: 14 }} /> : null}
        <Text style={{ color: t.muted, fontSize: 12 }}>{kind === "video" ? "Речь и пять выборочных кадров обрабатываются отдельно. Максимум 10 минут; частичные результаты явно отмечены." : kind === "audio" ? (localAudio ? "Речь распознаётся на телефоне моделью Whisper; файл никуда не отправляется." : "Речь преобразуется в текст сервисом подключения. Чтобы распознавать на телефоне, скачайте модель: Настройки → Голосовой ввод → Голос без интернета.") : kind === "text" ? "Текстовый файл читается на телефоне, без отправки в интернет." : "Выбранная модель должна поддерживать изображения."}</Text>
        <Text style={{ color: t.text, fontWeight: "600" }}>Обработка файла</Text>
        {([ ["sensitive", "Личные — только на телефоне"], ["standard", "Обычные — доступны агенту и разбору у провайдера"] ] as const).map(([id, label]) =>
          <Pressable disabled={busy} key={id} accessibilityRole="button" accessibilityLabel={label} onPress={() => setClassification(id)} style={{ minHeight: 46, justifyContent: "center" }}>
            <Text style={{ color: classification === id ? t.secondary : t.text }}>{classification === id ? "● " : "○ "}{label}</Text>
          </Pressable>)}
        {kind !== "text" && !localAudio ? <NoteEditorSection testID="import-processing-options" title="Параметры распознавания" summary="Модель и подключение" expanded={processingOptionsOpen} onToggle={() => setProcessingOptionsOpen(v => !v)}>
          <Text style={{ color: t.muted, fontSize: 12 }}>При разборе файл или кадры отправляются выбранному сервису.</Text>
          <Text style={{ color: t.text, fontWeight: "600" }}>Подключение для разбора</Text>
          {connections.map(c => <Pressable disabled={busy} key={c.id} accessibilityRole="button" accessibilityLabel={"Разобрать через " + c.name} style={{ minHeight: 44, justifyContent: "center" }} onPress={() => setConnectionId(c.id)}>
            <Text style={{ color: connectionId === c.id ? t.secondary : t.text }}>{connectionId === c.id ? "● " : "○ "}{c.name} · {c.model}</Text>
          </Pressable>)}
          {kind === "audio" && selected?.provider === "anthropic" ? <Text style={{ color: t.err }}>Для аудио выберите OpenAI-совместимое подключение с распознаванием речи.</Text> : null}
        </NoteEditorSection> : null}
        {kind === "audio" || kind === "video" ? <View><Text style={{ color: t.text }}>Подключение для речи (локальный Whisper имеет приоритет)</Text>{connections.map(c => <Pressable key={c.id} disabled={busy} onPress={() => setSpeechConnectionId(c.id)} style={{ minHeight: 44 }}><Text style={{ color: c.id === speechConnectionId ? t.secondary : t.text }}>{c.id === speechConnectionId ? "● " : "○ "}{c.name} · {c.transcriptionModel || "whisper-1"}</Text></Pressable>)}</View> : null}
        <Pressable disabled={busy || !canExtract} accessibilityRole="button" accessibilityLabel="Извлечь сведения из файла" style={[button, { opacity: canExtract ? 1 : .5 }]} onPress={() => void extract()}>
          <Text style={{ color: "#fff", fontWeight: "700" }}>{kind === "text" ? "Прочитать текст на телефоне" : localAudio ? "Распознать речь на телефоне" : "Передать файл провайдеру и разобрать"}</Text>
        </Pressable>
      </View> : null}
      {busy ? <><ActivityIndicator /><Pressable accessibilityRole="button" onPress={() => controller.current?.abort()} style={{ minHeight: 44 }}><Text style={{ color: t.err }}>Остановить</Text></Pressable></> : null}
      {incoming && !preparing ? <View style={{ flexDirection: "row", gap: 16 }}>
        <Pressable disabled={busy} style={{ minHeight: 44 }} onPress={() => setPrepareAttempt(n => n + 1)}><Text style={{ color: t.secondary }}>Повторить подготовку</Text></Pressable>
        {position + 1 < incoming.length ? <Pressable disabled={busy} style={{ minHeight: 44 }} onPress={() => Alert.alert("Пропустить материал?", "Этот материал не будет сохранён.", [{ text: "Отмена", style: "cancel" }, { text: "Пропустить", onPress: () => setPosition(p => p + 1) }])}><Text style={{ color: t.secondary }}>Пропустить</Text></Pressable> : null}
      </View> : null}
      {notice ? <Text accessibilityRole="alert" style={{ color: t.muted }}>{notice}</Text> : null}
      {file || extractedText || (incoming && !preparing) ? <>
        <Text accessibilityRole="header" style={{ color: t.text, fontSize: 18, fontWeight: "700" }}>3 · Проверить и сохранить</Text>
        {file ? <Pressable disabled={busy} accessibilityRole="checkbox" accessibilityState={{ checked: !keepOriginal }} onPress={() => setKeepOriginal(v => !v)} style={{ minHeight: 44 }}><Text style={{ color: t.secondary }}>{keepOriginal ? "□" : "☑"} Не сохранять оригинал — оставить только текст</Text></Pressable> : null}
        <Text style={{ color: t.text }}>Раздел</Text>
        {collections.find(c => c.id === collectionId)?.sensitivity !== "standard" ? <Text style={{ color: t.muted }}>Выбранный раздел закрыт для агента независимо от настройки записи.</Text> : null}
        {collections.map(c => <Pressable key={c.id} disabled={busy} accessibilityRole="button" accessibilityLabel={"Раздел: " + c.name} onPress={() => setCollectionId(c.id)} style={{ minHeight: 44 }}><Text style={{ color: c.id === collectionId ? t.secondary : t.text }}>{c.id === collectionId ? "● " : "○ "}{c.name}</Text></Pressable>)}
        {!file ? <Pressable disabled={busy} accessibilityRole="button" style={button} onPress={() => setClassification(classification === "standard" ? "sensitive" : "standard")}><Text style={{ color: "#fff" }}>{classification === "standard" ? "Доступно агенту" : "Только на телефоне — нажмите, чтобы разрешить агенту"}</Text></Pressable> : null}
        <Text style={{ color: t.text, fontWeight: "600" }}>Название заметки</Text>
        <TextInput accessibilityLabel="Название импортируемой заметки" editable={!busy} value={title} onChangeText={setTitle} style={field} />
        <Text style={{ color: t.text, fontWeight: "600" }}>Ваша заметка к файлу</Text>
        <TextInput accessibilityLabel="Сведения из файла" editable={!busy} multiline value={body} onChangeText={setBody} maxLength={60_000} style={[field, { minHeight: 200, textAlignVertical: "top" }]} placeholder="Ваш текст" placeholderTextColor={t.muted} />
        <Text style={{ color: t.text }}>Распознанное содержимое — также участвует в поиске</Text>
        <TextInput accessibilityLabel="Распознанное содержимое файла" editable={!busy} multiline value={extractedText} onChangeText={setExtractedText} maxLength={60_000} style={field} />
        <Text style={{ color: t.muted }}>Личные записи не видны агенту. Для поиска по содержимому фото или аудио сначала выполните распознавание. Векторизация работает на телефоне после загрузки модели поиска.</Text>
        <Pressable disabled={busy} accessibilityRole="button" accessibilityLabel="Сохранить сведения в память" style={[button, { opacity: busy ? .5 : 1 }]} onPress={() => void save()}>
          <Text style={{ color: "#fff", fontWeight: "700" }}>Сохранить сведения в память</Text>
        </Pressable>
        <Text style={{ color: t.muted, fontSize: 12 }}>При сохранении оригинала он остаётся в зашифрованной памяти и входит в резервную копию. Текст можно добавить сейчас или позже. Максимум — 80 МБ на файл.</Text>
      </> : null}
    </ScrollView>
  </KeyboardAvoidingView>;
}
