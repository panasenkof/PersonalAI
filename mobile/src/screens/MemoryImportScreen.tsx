import { useNavigation } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { useHeaderHeight } from "@react-navigation/elements";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import * as DocumentPicker from "expo-document-picker";
import * as FileSystem from "expo-file-system/legacy";
import React, { useEffect, useRef, useState } from "react";
import { ActivityIndicator, Image, KeyboardAvoidingView, Platform, Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { useProfile } from "../profile/ProfileContext";
import { loadDirectConnections, anonymousLocalAllowed, defaultDirectPreferences } from "../direct-agent/settings";
import type { DirectConnection } from "../direct-agent/settings";
import { localMemoryRepository } from "../local-memory/repository";
import { extractMedia, mediaKind } from "../media/extract";
import type { ImportFile } from "../media/extract";
import type { RootStackParams } from "../navigation";
import { withNativeInteraction } from "../security/native-interaction";
import { memoryErrorMessage } from "../local-memory/errors";
import { useTheme } from "../theme";
import { useWhisperStatus } from "../media/whisper";

export function MemoryImportScreen() {
  const whisper = useWhisperStatus();
  const t = useTheme();
  const header = useHeaderHeight(); const insets = useSafeAreaInsets();
  const profile = useProfile();
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParams>>();
  const [file, setFile] = useState<ImportFile | null>(null);
  const [connections, setConnections] = useState<DirectConnection[]>([]);
  const [connectionId, setConnectionId] = useState("");
  const [classification, setClassification] = useState<"sensitive" | "standard">("sensitive");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const alive = useRef(true);
  const controller = useRef<AbortController | null>(null);
  const ownedFiles = useRef<string[]>([]);
  useEffect(() => {
    alive.current = true;
    if (profile) void loadDirectConnections(profile).then(v => {
      if (alive.current) { setConnections(v.connections); setConnectionId(v.activeId); }
    }).catch(() => { if (alive.current) setNotice("Не удалось прочитать подключения. Откройте настройки модели."); });
    return () => {
      alive.current = false; controller.current?.abort();
      for (const uri of ownedFiles.current) void FileSystem.deleteAsync(uri, { idempotent: true }).catch(() => {});
    };
  }, [profile]);
  const selected = connections.find(c => c.id === connectionId);
  const kind = file ? mediaKind(file) : null;
  const localAudio = kind === "audio" && whisper.state === "ready";
  const canExtract = kind === "text" || localAudio || Boolean(selected && classification === "standard" &&
    (selected.apiKey || anonymousLocalAllowed(selected)) && !(kind === "audio" && selected.provider === "anthropic"));
  const field = { color: t.text, backgroundColor: t.panel, borderWidth: 1, borderColor: t.line, borderRadius: 16, padding: 14, minHeight: 50 };
  const button = { backgroundColor: t.accent, padding: 14, borderRadius: 17, minHeight: 50, justifyContent: "center" as const, alignItems: "center" as const };

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
      setFile(asset); setTitle(asset.name.slice(0, 160)); setBody(""); setClassification("sensitive");
    } catch (e) { if (alive.current) setNotice((e as Error).message); }
  }
  async function extract() {
    if (!file || !canExtract || busy) return;
    const aborter = new AbortController(); controller.current = aborter; setBusy(true); setNotice("");
    try {
      const text = await extractMedia(file, selected || { ...defaultDirectPreferences, apiKey: "", webSearchKey: "" }, classification === "standard", aborter.signal);
      if (alive.current && !aborter.signal.aborted) { setBody(text); setNotice("Проверьте и отредактируйте текст. В памяти он появится после сохранения."); }
    } catch (e) { if (alive.current) setNotice(aborter.signal.aborted ? "Разбор остановлен." : (e as Error).message); }
    finally { if (alive.current) setBusy(false); if (controller.current === aborter) controller.current = null; }
  }
  async function save() {
    if (!profile || !file || busy || !body.trim()) return;
    setBusy(true); setNotice("");
    try {
      const repo = await localMemoryRepository(profile);
      const cols = await repo.listCollections();
      let col = cols.find(c => c.slug === "notes");
      if (!col) col = await repo.createCollection({ name: "Заметки", slug: "notes", sensitivity: "standard" });
      await repo.createEntity({ collection_id: col.id, domain: "notes", title: title.trim().slice(0, 160),
        payload: { type: "note", title: title.trim().slice(0, 160), body: body.trim(), source_file: file.name, source_media: kind },
        sensitivity: classification, source_kind: "user", source_ref: "device-import",
      });
      if (alive.current) navigation.goBack();
    } catch (e) { if (alive.current) setNotice("Не удалось сохранить: " + memoryErrorMessage(e)); }
    finally { if (alive.current) setBusy(false); }
  }
  return <KeyboardAvoidingView style={{ flex: 1, backgroundColor: t.bg }} behavior={Platform.OS === "ios" ? "padding" : undefined} keyboardVerticalOffset={header}>
    <ScrollView keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag" contentContainerStyle={{ padding: 18, gap: 15, paddingBottom: insets.bottom + 24 }}>
      <Text style={{ color: t.text, fontSize: 27, fontWeight: "800" }}>Сведения из файла</Text>
      <Text style={{ color: t.muted, lineHeight: 21 }}>Извлеките текст и полезные сведения, проверьте результат и сохраните заметку в памяти телефона.</Text>
      <Pressable disabled={busy} accessibilityRole="button" accessibilityLabel="Выбрать файл для памяти" style={button} onPress={() => void pick()}>
        <Text style={{ color: "#fff", fontWeight: "700" }}>{file ? "Выбрать другой файл" : "Выбрать фото, аудио, видео или текст"}</Text>
      </Pressable>
      {file ? <View style={{ backgroundColor: t.panel, padding: 16, borderRadius: 20, borderWidth: 1, borderColor: t.line, gap: 10 }}>
        <Text style={{ color: t.text, fontWeight: "700" }}>{file.name}</Text>
        {kind === "image" ? <Image source={{ uri: file.uri }} resizeMode="contain" style={{ width: "100%", height: 180, borderRadius: 14 }} /> : null}
        <Text style={{ color: t.muted, fontSize: 12 }}>{kind === "video" ? "Пять кадров по всей длительности. Звук в этот разбор не входит." : kind === "audio" ? (localAudio ? "Речь распознаётся на телефоне моделью Whisper; файл никуда не отправляется." : "Речь преобразуется в текст сервисом подключения. Чтобы распознавать на телефоне, скачайте модель: Настройки → Голосовой ввод → Голос без интернета.") : kind === "text" ? "Текстовый файл читается на телефоне, без отправки в интернет." : "Выбранная модель должна поддерживать изображения."}</Text>
        <Text style={{ color: t.text, fontWeight: "600" }}>Обработка файла</Text>
        {([ ["sensitive", "Личные — только на телефоне"], ["standard", "Обычные — разрешить разбор у провайдера"] ] as const).map(([id, label]) =>
          <Pressable disabled={busy} key={id} accessibilityRole="button" accessibilityLabel={label} onPress={() => setClassification(id)} style={{ minHeight: 46, justifyContent: "center" }}>
            <Text style={{ color: classification === id ? t.accent : t.text }}>{classification === id ? "● " : "○ "}{label}</Text>
          </Pressable>)}
        {kind !== "text" && !localAudio ? <>
          <Text style={{ color: t.muted, fontSize: 12 }}>При разборе файл или кадры отправляются выбранному сервису.</Text>
          <Text style={{ color: t.text, fontWeight: "600" }}>Подключение для разбора</Text>
          {connections.map(c => <Pressable disabled={busy} key={c.id} accessibilityRole="button" accessibilityLabel={"Разобрать через " + c.name} style={{ minHeight: 44, justifyContent: "center" }} onPress={() => setConnectionId(c.id)}>
            <Text style={{ color: connectionId === c.id ? t.accent : t.text }}>{connectionId === c.id ? "● " : "○ "}{c.name} · {c.model}</Text>
          </Pressable>)}
          {kind === "audio" && selected?.provider === "anthropic" ? <Text style={{ color: t.err }}>Для аудио выберите OpenAI-совместимое подключение с распознаванием речи.</Text> : null}
        </> : null}
        <Pressable disabled={busy || !canExtract} accessibilityRole="button" accessibilityLabel="Извлечь сведения из файла" style={[button, { opacity: canExtract ? 1 : .5 }]} onPress={() => void extract()}>
          <Text style={{ color: "#fff", fontWeight: "700" }}>{kind === "text" ? "Прочитать текст на телефоне" : localAudio ? "Распознать речь на телефоне" : "Передать файл провайдеру и разобрать"}</Text>
        </Pressable>
      </View> : null}
      {busy ? <><ActivityIndicator /><Pressable accessibilityRole="button" onPress={() => controller.current?.abort()} style={{ minHeight: 44 }}><Text style={{ color: t.err }}>Остановить разбор</Text></Pressable></> : null}
      {notice ? <Text accessibilityRole="alert" style={{ color: t.muted }}>{notice}</Text> : null}
      {file ? <>
        <Text style={{ color: t.text, fontWeight: "600" }}>Название заметки</Text>
        <TextInput accessibilityLabel="Название импортируемой заметки" editable={!busy} value={title} onChangeText={setTitle} style={field} />
        <Text style={{ color: t.text, fontWeight: "600" }}>Проверьте сведения</Text>
        <TextInput accessibilityLabel="Сведения из файла" editable={!busy} multiline value={body} onChangeText={setBody} maxLength={60_000} style={[field, { minHeight: 200, textAlignVertical: "top" }]} placeholder="Результат разбора или ваш текст" placeholderTextColor={t.muted} />
        <Pressable disabled={busy || !body.trim()} accessibilityRole="button" accessibilityLabel="Сохранить сведения в память" style={[button, { opacity: body.trim() ? 1 : .5 }]} onPress={() => void save()}>
          <Text style={{ color: "#fff", fontWeight: "700" }}>Сохранить сведения в память</Text>
        </Pressable>
        <Text style={{ color: t.muted, fontSize: 12 }}>Сохраняется текст и имя источника. Исходный медиафайл в резервную копию заметок не входит.</Text>
      </> : null}
    </ScrollView>
  </KeyboardAvoidingView>;
}
