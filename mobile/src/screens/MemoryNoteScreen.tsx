import { useNavigation, usePreventRemove, useRoute } from "@react-navigation/native";
import type { RouteProp } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { useHeaderHeight } from "@react-navigation/elements";
import React, { useCallback, useEffect, useRef, useState } from "react";
import Feather from "@expo/vector-icons/Feather";
import { ActivityIndicator, Alert, Keyboard, KeyboardAvoidingView, Linking, Platform, Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useProfile } from "../profile/ProfileContext";
import { BottomSheet } from "../components/BottomSheet";
import { VoiceInput } from "../components/VoiceInput";
import { localMemoryRepository } from "../local-memory/repository";
import type { SqliteMemoryRepository } from "../local-memory/repository";
import { MemoryConflictError } from "../local-memory/types";
import type { CollectionRecord, EntityRecord, ObservationRecord, RelationRecord, RevisionRecord } from "../local-memory/types";
import { onLocalMemorySessionChange } from "../local-memory/storage";
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
import { attachmentForEntity, materializeAttachment } from "../media/attachments";
import { extractMedia } from "../media/extract";
import { maySendOriginalToProvider } from "../media/recognitionPolicy";
import { mediaConnections } from "../media/preferences";
import { AttachmentView } from "../media/AttachmentView";
import { useTheme } from "../theme";
import { nebulaRadii, nebulaSpacing, nebulaTouch, nebulaTypography } from "../design/nebula/tokens";
import { NoteEditorSection } from "../design/nebula/NoteEditorSection";

export function MemoryNoteScreen() {
  const t = useTheme(); const insets = useSafeAreaInsets(); const headerHeight = useHeaderHeight();
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParams>>();
  const route = useRoute<RouteProp<RootStackParams, "MemoryNote">>();
  const profile = useProfile();
  const extraction = useRef<AbortController | null>(null);
  useEffect(() => { const off = onLocalMemorySessionChange(unlocked => { if (!unlocked) extraction.current?.abort(); }); return () => { off(); extraction.current?.abort(); }; }, []);
  const repository = useRef<SqliteMemoryRepository | null>(null); const alive = useRef(true); const pending = useRef(false);
  const [selected, setSelected] = useState<EntityRecord | null>(null);
  const [collections, setCollections] = useState<CollectionRecord[]>([]);
  const [collectionId, setCollectionId] = useState(route.params?.collectionId);
  const [title, setTitle] = useState(""); const [body, setBody] = useState("");
  const [extractedText, setExtractedText] = useState("");
  const [allowAgent, setAllowAgent] = useState(false);
  const [kind, setKind] = useState<MemoryKind>("note"); const [names, setNames] = useState("");
  const [terms, setTerms] = useState(""); const [modelTerms, setModelTerms] = useState<string[]>([]);
  const [loading, setLoading] = useState(true); const [busy, setBusy] = useState(false); const [error, setError] = useState("");
  const [retry, setRetry] = useState(0); const [leaving, setLeaving] = useState(false);
  const [sectionOpen, setSectionOpen] = useState(false); const [details, setDetails] = useState(false);
  const [metadataOpen, setMetadataOpen] = useState(false); const [fileContentOpen, setFileContentOpen] = useState(false);
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
  usePreventRemove(!leaving && (busy || dirty), ({ data }) => {
    if (busy) { setError("Дождитесь завершения сохранения."); return; }
    Alert.alert("Изменения не сохранены", "Закрыть запись без сохранения?", [
      { text: "Продолжить редактирование", style: "cancel" },
      { text: "Закрыть", style: "destructive", onPress: () => setLeaving(true) },
    ]);
  });
  useEffect(() => { if (leaving) navigation.goBack(); }, [leaving, navigation]);
  useEffect(() => {
    alive.current = true; setLoading(true); setError(""); setMetadataOpen(false); setFileContentOpen(false);
    void (async () => {
      if (!profile) throw new Error("profile_missing");
      const db = await localMemoryRepository(profile);
      const sections = await ensureSections(db);
      const note = route.params?.entityId ? await db.entity(route.params.entityId) : null;
      if (route.params?.entityId && !note) throw new Error("Запись не найдена.");
      if (!alive.current) return;
      repository.current = db; setCollections(sections); setSelected(note); setExtractedText(String(note?.payload.extracted_text || "")); setAllowAgent(false);
      const initialTitle = note?.title || ""; const initialBody = String(note?.payload.body || "");
      const initialCollection = note?.collection_id || route.params?.collectionId;
      const initialKind = note?.kind || defaultKind(sections.find(c => c.id === initialCollection)?.slug);
      const initialNames = note ? (await db.aliases(note.id)).join(", ") : "";
      const indexTerms = note ? await db.indexTerms(note.id) : [];
      const initialTerms = (indexTerms.find(x => x.source === "user")?.terms || []).join(", ");
      if (!alive.current) return;
      baseline.current = { title: initialTitle, body: initialBody, collectionId: initialCollection, kind: initialKind, names: initialNames, terms: initialTerms };
      setTerms(initialTerms); setModelTerms(indexTerms.filter(x => x.source.startsWith("model:")).flatMap(x => x.terms));
      kindTouched.current = false;
      setTitle(initialTitle); setBody(initialBody); setCollectionId(initialCollection); setKind(initialKind); setNames(initialNames);
    })().catch(e => { if (alive.current) setError(memoryErrorMessage(e)); }).finally(() => { if (alive.current) setLoading(false); });
    return () => { alive.current = false; repository.current = null; };
  }, [profile, route.params?.entityId, route.params?.collectionId, retry]);
  const run = useCallback(async (work: (db: SqliteMemoryRepository) => Promise<void>) => {
    if (!repository.current || pending.current) return;
    pending.current = true; setBusy(true); setError("");
    try { await work(repository.current); }
    catch (e) { if (alive.current) setError(e instanceof MemoryConflictError ? "Запись изменилась. Откройте её заново перед сохранением." : memoryErrorMessage(e)); }
    finally { pending.current = false; if (alive.current) setBusy(false); }
  }, []);
  const save = () => run(async db => {
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
    const finalTitle = title.trim() || body.trim().split("\n")[0].slice(0, 80);
    const payload = { ...selected?.payload, type: "note", title: finalTitle, body: body.trim(), extracted_text: extractedText.trim() };
    const base = baseline.current;
    let saved: EntityRecord;
    if (selected) {
      const textChanged = allowAgent || extractedText !== String(selected.payload.extracted_text || "") || title !== base.title || body !== base.body || collectionId !== base.collectionId;
      saved = textChanged ? await db.reviseEntity(selected.id, selected.record_version, payload, allowAgent ? "Разрешён доступ агенту" : "Редактирование записи", collection, allowAgent) : selected;
      if (kind !== saved.kind) saved = await db.setEntityKind(saved.id, saved.record_version, kind);
    } else saved = await db.createEntity({ collection_id: collection, domain: "notes", title: finalTitle, payload, kind,
      sensitivity: "inherit", source_kind: "user", source_ref: "device" });
    if (splitNames(names).join(",") !== splitNames(base.names).join(",")) await db.setAliases(saved.id, splitNames(names));
    if (terms.trim() !== base.terms.trim()) await db.setIndexTerms(saved.id, splitNames(terms), "user");
    if (profile) { scheduleIndexTerms(profile); scheduleVectors(profile); }
    if (alive.current) setLeaving(true);
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
  const button = { minHeight: nebulaTouch.minimum, borderRadius: nebulaRadii.field, justifyContent: "center" as const, padding: nebulaSpacing.md };
  return <KeyboardAvoidingView style={{ flex: 1, backgroundColor: t.bg }} behavior={Platform.OS === "ios" ? "padding" : "height"} keyboardVerticalOffset={Platform.OS === "ios" ? headerHeight : 0}>
    <ScrollView testID="note-editor-scroll" keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag" contentContainerStyle={{ padding: nebulaSpacing.md, paddingBottom: nebulaSpacing.xl, gap: nebulaSpacing.sm }}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: nebulaSpacing.sm }}>
        <Text accessibilityRole="header" style={{ flex: 1, color: t.text, ...nebulaTypography.heading, fontWeight: "800" }}>{selected ? "Запись" : "Новая запись"}</Text>
        {!loading && dirty ? <Text accessibilityLabel="Несохранённые изменения" style={{ color: t.muted, ...nebulaTypography.label }}>Не сохранено</Text> : null}
      </View>
      {loading ? <ActivityIndicator accessibilityLabel="Загрузка записи" /> : null}
      {!loading && repository.current ? <>
        <Pressable accessibilityRole="button" accessibilityLabel="Выбрать раздел записи" onPress={() => setSectionOpen(true)}
          style={{ ...button, backgroundColor: t.soft, flexDirection: "row", alignItems: "center", gap: nebulaSpacing.xs }}>
          <Feather name="folder" size={18} color={t.secondary} />
          <Text numberOfLines={2} style={{ flex: 1, color: t.secondary, ...nebulaTypography.body }}>Раздел: {collections.find(c => c.id === collectionId)?.name || "Заметки"}</Text>
          <Feather name="chevron-down" size={20} color={t.secondary} />
        </Pressable>
        <TextInput testID="note-title-input" accessibilityLabel="Заголовок заметки" value={title} onChangeText={setTitle} editable={!busy} maxLength={160} placeholder="Заголовок" placeholderTextColor={t.muted} style={field} />
        <TextInput testID="note-body-input" accessibilityLabel="Текст заметки" multiline value={body} onChangeText={setBody} editable={!busy} placeholder="Что нужно запомнить?" placeholderTextColor={t.muted} style={{ ...field, minHeight: 200, textAlignVertical: "top", lineHeight: 23 }} />
        <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}><VoiceInput value={body} onChange={setBody} disabled={busy} onError={setError} /><Text style={{ color: t.muted }}>Надиктовать запись</Text></View>

        <NoteEditorSection testID="note-metadata-toggle" title="Параметры записи" summary={"Тип: " + KIND_NAMES[kind] + " · другие названия и слова поиска"}
          expanded={metadataOpen} onToggle={() => { Keyboard.dismiss(); setMetadataOpen(open => !open); }}>
        <Text style={{ color: t.muted, fontSize: 12 }}>Тип записи</Text>
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 6 }}>
          {MEMORY_KINDS.map(k => { const chosen = k === kind; return <Pressable key={k} accessibilityRole="button" accessibilityLabel={"Тип записи: " + KIND_NAMES[k]}
            accessibilityState={{ selected: chosen }} aria-selected={chosen} disabled={busy} onPress={() => { kindTouched.current = true; setKind(k); }}
            style={{ minHeight: nebulaTouch.minimum, paddingHorizontal: nebulaSpacing.sm, justifyContent: "center", borderRadius: nebulaRadii.chip, borderWidth: 1, borderColor: chosen ? t.accent : t.line, backgroundColor: chosen ? t.soft : t.panel }}>
            <Text style={{ color: chosen ? t.secondary : t.text, fontSize: 13 }}>{KIND_NAMES[k]}</Text></Pressable>; })}
        </View>
        <TextInput accessibilityLabel="Другие имена и прозвища" value={names} onChangeText={setNames} editable={!busy} maxLength={600}
          placeholder={kind === "person" ? "Другие имена через запятую: Маша, Мария Петровна" : "Другие названия через запятую (по желанию)"} placeholderTextColor={t.muted} style={field} />
        <Text style={{ color: t.muted, fontSize: 12 }}>По этим именам запись тоже находится в поиске.</Text>
        <TextInput accessibilityLabel="Слова для поиска" value={terms} onChangeText={setTerms} editable={!busy} maxLength={600}
          placeholder="Слова для поиска через запятую: автомобиль, шкода" placeholderTextColor={t.muted} style={field} />
        {modelTerms.length ? <Text accessibilityLabel="Слова, подобранные моделью" style={{ color: t.muted, fontSize: 12, lineHeight: 18 }}>Подобрала модель: {modelTerms.join(", ")}. Обновятся после правки текста.</Text> : null}
        </NoteEditorSection>
        {selected && (selected.payload.source_file || selected.payload.extracted_text) ? <NoteEditorSection
          testID="note-extracted-toggle" title="Текст из файла"
          summary="Распознанное содержимое участвует в поиске по памяти"
          expanded={fileContentOpen} onToggle={() => { Keyboard.dismiss(); setFileContentOpen(open => !open); }}>
          <Text style={{ color: t.muted, ...nebulaTypography.label }}>Проверьте распознанный текст. Он индексируется вместе с записью.</Text>
          <TextInput accessibilityLabel="Распознанное содержимое файла" multiline editable={!busy} value={extractedText} onChangeText={setExtractedText} maxLength={60_000} style={field} />
          <Pressable disabled={busy} accessibilityRole="button" style={button} onPress={() => Alert.alert("Распознать оригинал?", maySendOriginalToProvider(selected.sensitivity, collections.find(c => c.id === selected.collection_id)?.sensitivity)
            ? "Будут использованы подключения из раздела «Обработка медиа». Фото и кадры видео отправляются сервису; аудио обрабатывается локально установленным Whisper либо внешним сервисом. Проверьте результат до сохранения."
            : "Это закрытая запись. Допускается только локальное чтение текстового файла или распознавание аудио установленным Whisper. Фото, видео и аудио без локального Whisper нельзя передавать внешнему провайдеру. Оригинал останется зашифрованным.", [
            { text: "Отмена", style: "cancel" },
            { text: "Распознать", onPress: () => void run(async () => {
              if (!profile) return;
              const attachment = await attachmentForEntity(profile, selected.id);
              if (!attachment) throw new Error("Оригинал не найден.");
              const aborter = new AbortController(); extraction.current = aborter;
              let uri = "";
              try {
                uri = await materializeAttachment(profile, attachment, aborter.signal);
                const settings = await mediaConnections(profile);
                const allowRemote = maySendOriginalToProvider(selected.sensitivity, collections.find(c => c.id === selected.collection_id)?.sensitivity);
                const text = await extractMedia({ uri, name: attachment.name, mimeType: attachment.mime }, settings.vision, allowRemote, aborter.signal, undefined, settings.speech);
                if (alive.current && !aborter.signal.aborted) setExtractedText(text);
              } finally { extraction.current = null; if (uri) { const file = new File(uri); if (file.exists) file.delete(); } }
            }) },
          ])}><Text style={{ color: t.secondary }}>Распознать сохранённый файл</Text></Pressable>
        </NoteEditorSection> : null}
        {selected && (selected.sensitivity === "sensitive" || collections.find(c => c.id === selected.collection_id)?.sensitivity !== "standard") ? <>
          <Text style={{ color: t.muted }}>Запись закрыта для агента. Локальная векторизация доступна, но текст не передаётся модели.</Text>
          <Pressable disabled={busy} accessibilityRole="button" style={button} onPress={() => Alert.alert("Разрешить доступ агенту?", "После сохранения запись перейдёт в обычные «Заметки». Текст и распознанное содержимое смогут передаваться модели при поиске. Оригинал автоматически не отправляется.", [{ text: "Отмена", style: "cancel" }, { text: "Разрешить", onPress: () => setAllowAgent(true) }])}><Text style={{ color: t.secondary }}>{allowAgent ? "Доступ будет разрешён после сохранения" : "Разрешить агенту находить запись"}</Text></Pressable>
        </> : null}
        {typeof selected?.payload.source_url === "string" ? <Pressable accessibilityRole="link" style={button} onPress={() => { const url = String(selected.payload.source_url); if (/^https:\/\//.test(url)) void Linking.openURL(url).catch(() => setError("Не удалось открыть ссылку.")); }}><Text style={{ color: t.secondary }}>Источник: {selected.payload.source_url}</Text></Pressable> : null}
        {Array.isArray(selected?.payload.merged_sources) ? <View><Text style={{ color: t.muted }}>Исходные записи, их даты и связи сохранены:</Text>{(selected.payload.merged_sources as { id: string; title: string }[]).filter(n => n.id !== selected.id).map(n => <Pressable key={n.id} style={button} onPress={() => navigation.push("MemoryNote", { entityId: n.id })}><Text style={{ color: t.secondary }}>{n.title || "Исходная запись"}</Text></Pressable>)}</View> : null}
        {selected && profile ? <AttachmentView profile={profile} entityId={selected.id} /> : null}
        {selected ? <>
          {selected.record_status === "trashed" ? <Text style={{ color: t.muted }}>Запись в корзине. Восстановите её на странице памяти, чтобы агент снова мог её находить.</Text> : null}
          <Pressable accessibilityRole="button" accessibilityLabel="История, события и связи" accessibilityState={{ expanded: details }} onPress={() => details ? setDetails(false) : void loadDetails()} style={{ ...button, backgroundColor: t.soft }}><Text style={{ color: t.text }}>История, события и связи {details ? "⌃" : "⌄"}</Text></Pressable>
          {details ? <View style={{ gap: 12, padding: 16, borderWidth: 1, borderColor: t.line, borderRadius: 20 }}>
            <Text style={{ color: t.text, fontWeight: "700" }}>История изменений · версия {selected.record_version}</Text>
            {history.map(r => <Text key={r.id} style={{ color: t.muted }}>{new Date(r.created_at).toLocaleDateString()} · {r.reason}</Text>)}
            <Text style={{ color: t.text, fontWeight: "700" }}>События</Text>
            {events.map(e => <Text key={e.id} style={{ color: t.muted }}>{new Date(e.occurred_at).toLocaleDateString()} · {String(e.payload.text || e.kind)}</Text>)}
            <TextInput accessibilityLabel="Новое событие" value={eventText} onChangeText={setEventText} placeholder="Что произошло?" placeholderTextColor={t.muted} style={field} />
            <Pressable accessibilityRole="button" disabled={busy || !eventText.trim()} style={button} onPress={() => void run(async db => {
              await db.createObservation({ entity_id: selected.id, kind: "note_event", occurred_at: new Date().toISOString(), payload: { text: eventText.trim() }, sensitivity: "inherit", source_kind: "user", source_ref: "device" });
              if (alive.current) { setEvents(await db.observations(selected.id)); setEventText(""); }
            })}><Text style={{ color: t.secondary }}>Добавить событие</Text></Pressable>
            <Text style={{ color: t.text, fontWeight: "700" }}>Связанные записи ({relations.length})</Text>
            {relations.map(r => { const other = related.find(e => e.id === (r.source_entity_id === selected.id ? r.target_entity_id : r.source_entity_id));
              return <Text key={r.id} style={{ color: t.muted }}>{(other?.title || "Другая запись") + (other?.kind ? " · " + KIND_NAMES[other.kind] : "") + (r.kind === "about" ? (r.source_entity_id === selected.id ? " — о ком запись" : " — запись об этом человеке") : "")}</Text>; })}
            <Pressable accessibilityRole="button" accessibilityLabel="Связать с другой записью" style={button} onPress={() => setLinkOpen(true)}><Text style={{ color: t.secondary }}>+ Связать с другой записью</Text></Pressable>
          </View> : null}
          <Pressable accessibilityRole="button" accessibilityLabel={selected.record_status === "archived" ? "Вернуть запись из архива" : "Архивировать запись"} disabled={busy || dirty || !["active", "archived"].includes(selected.record_status)} style={button} onPress={() => void run(async db => {
            await db.setEntityStatus(selected.id, selected.record_version, selected.record_status === "archived" ? "active" : "archived");
            if (alive.current) setLeaving(true);
          })}><Text style={{ color: t.muted }}>{selected.record_status === "archived" ? "Вернуть из архива" : "Перенести в архив"}</Text></Pressable>
        </> : null}
      </> : null}
      {error ? <Text accessibilityRole="alert" style={{ color: t.err }}>{error}</Text> : null}
      {!loading && !repository.current ? <Pressable accessibilityRole="button" style={button} onPress={() => setRetry(n => n + 1)}><Text style={{ color: t.secondary }}>Повторить загрузку</Text></Pressable> : null}
    </ScrollView>
    {!loading && repository.current ? <View style={{ paddingHorizontal: nebulaSpacing.md, paddingTop: nebulaSpacing.xs, paddingBottom: keyboardOpen ? nebulaSpacing.xs : insets.bottom + nebulaSpacing.xs, borderTopWidth: 1, borderTopColor: t.line, backgroundColor: t.bg }}>
      <Pressable testID="note-save-button" accessibilityRole="button" accessibilityLabel="Сохранить запись" disabled={busy || (!title.trim() && !body.trim())}
        onPress={() => { Keyboard.dismiss(); void save(); }}
        style={{ ...button, backgroundColor: t.accent, alignItems: "center" }}>
        <Text style={{ color: "#fff", fontWeight: "700" }}>{busy ? "Сохранение…" : "Сохранить запись"}</Text>
      </Pressable>
    </View> : null}
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
  </KeyboardAvoidingView>;
}
