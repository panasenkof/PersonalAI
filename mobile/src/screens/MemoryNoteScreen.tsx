import { useNavigation, usePreventRemove, useRoute } from "@react-navigation/native";
import type { RouteProp } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import { useHeaderHeight } from "@react-navigation/elements";
import React, { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, Alert, KeyboardAvoidingView, Platform, Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useProfile } from "../profile/ProfileContext";
import { BottomSheet } from "../components/BottomSheet";
import { VoiceInput } from "../components/VoiceInput";
import { localMemoryRepository } from "../local-memory/repository";
import type { SqliteMemoryRepository } from "../local-memory/repository";
import { MemoryConflictError } from "../local-memory/types";
import type { CollectionRecord, EntityRecord, ObservationRecord, RelationRecord, RevisionRecord } from "../local-memory/types";
import { memoryErrorMessage } from "../local-memory/errors";
import type { RootStackParams } from "../navigation";
import { useTheme } from "../theme";

export function MemoryNoteScreen() {
  const t = useTheme(); const insets = useSafeAreaInsets(); const headerHeight = useHeaderHeight();
  const navigation = useNavigation<NativeStackNavigationProp<RootStackParams>>();
  const route = useRoute<RouteProp<RootStackParams, "MemoryNote">>();
  const profile = useProfile();
  const repository = useRef<SqliteMemoryRepository | null>(null); const alive = useRef(true); const pending = useRef(false);
  const [selected, setSelected] = useState<EntityRecord | null>(null);
  const [collections, setCollections] = useState<CollectionRecord[]>([]);
  const [collectionId, setCollectionId] = useState(route.params?.collectionId);
  const [title, setTitle] = useState(""); const [body, setBody] = useState("");
  const [loading, setLoading] = useState(true); const [busy, setBusy] = useState(false); const [error, setError] = useState("");
  const [retry, setRetry] = useState(0); const [leaving, setLeaving] = useState(false);
  const [sectionOpen, setSectionOpen] = useState(false); const [details, setDetails] = useState(false);
  const [history, setHistory] = useState<RevisionRecord[]>([]); const [events, setEvents] = useState<ObservationRecord[]>([]);
  const [relations, setRelations] = useState<RelationRecord[]>([]); const [related, setRelated] = useState<EntityRecord[]>([]);
  const [eventText, setEventText] = useState(""); const [linkOpen, setLinkOpen] = useState(false); const [linkSearch, setLinkSearch] = useState("");
  const baseline = useRef({ title: "", body: "", collectionId: route.params?.collectionId });
  const dirty = title !== baseline.current.title || body !== baseline.current.body || collectionId !== baseline.current.collectionId;
  usePreventRemove(!leaving && (busy || dirty), ({ data }) => {
    if (busy) { setError("Дождитесь завершения сохранения."); return; }
    Alert.alert("Изменения не сохранены", "Закрыть запись без сохранения?", [
      { text: "Продолжить редактирование", style: "cancel" },
      { text: "Закрыть", style: "destructive", onPress: () => navigation.dispatch(data.action) },
    ]);
  });
  useEffect(() => { if (leaving) navigation.goBack(); }, [leaving, navigation]);
  useEffect(() => {
    alive.current = true; setLoading(true); setError("");
    void (async () => {
      if (!profile) throw new Error("profile_missing");
      const db = await localMemoryRepository(profile);
      const sections = await db.listCollections();
      const note = route.params?.entityId ? await db.entity(route.params.entityId) : null;
      if (route.params?.entityId && !note) throw new Error("Запись не найдена.");
      if (!alive.current) return;
      repository.current = db; setCollections(sections); setSelected(note);
      const initialTitle = note?.title || ""; const initialBody = String(note?.payload.body || "");
      const initialCollection = note?.collection_id || route.params?.collectionId;
      baseline.current = { title: initialTitle, body: initialBody, collectionId: initialCollection };
      setTitle(initialTitle); setBody(initialBody); setCollectionId(initialCollection);
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
    const finalTitle = title.trim() || body.trim().split("\n")[0].slice(0, 80);
    const payload = { ...selected?.payload, type: "note", title: finalTitle, body: body.trim() };
    if (selected) await db.reviseEntity(selected.id, selected.record_version, payload, "Редактирование записи", collection);
    else await db.createEntity({ collection_id: collection, domain: "notes", title: finalTitle, payload,
      sensitivity: "inherit", source_kind: "user", source_ref: "device" });
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
  const field = { borderWidth: 1, borderColor: t.line, borderRadius: 16, backgroundColor: t.panel, minHeight: 50, padding: 14, color: t.text, fontSize: 16 };
  const button = { minHeight: 50, borderRadius: 16, justifyContent: "center" as const, padding: 14 };
  return <KeyboardAvoidingView style={{ flex: 1, backgroundColor: t.bg }} behavior={Platform.OS === "ios" ? "padding" : undefined} keyboardVerticalOffset={headerHeight}>
    <ScrollView keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag" contentContainerStyle={{ padding: 18, paddingBottom: insets.bottom + 24, gap: 14 }}>
      <Text style={{ color: t.text, fontSize: 26, fontWeight: "800" }}>{selected ? "Редактирование записи" : "Новая запись"}</Text>
      {loading ? <ActivityIndicator accessibilityLabel="Загрузка записи" /> : null}
      {!loading && repository.current ? <>
        <Pressable accessibilityRole="button" accessibilityLabel="Выбрать раздел записи" onPress={() => setSectionOpen(true)} style={{ ...button, backgroundColor: t.soft }}><Text style={{ color: t.accent }}>Раздел: {collections.find(c => c.id === collectionId)?.name || "Заметки"} ▾</Text></Pressable>
        <TextInput accessibilityLabel="Заголовок заметки" value={title} onChangeText={setTitle} editable={!busy} maxLength={160} placeholder="Заголовок" placeholderTextColor={t.muted} style={field} />
        <TextInput accessibilityLabel="Текст заметки" multiline value={body} onChangeText={setBody} editable={!busy} placeholder="Что нужно запомнить?" placeholderTextColor={t.muted} style={{ ...field, minHeight: 200, textAlignVertical: "top", lineHeight: 23 }} />
        <View style={{ flexDirection: "row", alignItems: "center", gap: 10 }}><VoiceInput value={body} onChange={setBody} disabled={busy} onError={setError} /><Text style={{ color: t.muted }}>Надиктовать запись</Text></View>
        <Pressable accessibilityRole="button" accessibilityLabel="Сохранить запись" disabled={busy || (!title.trim() && !body.trim())} onPress={() => void save()} style={{ ...button, backgroundColor: t.accent, alignItems: "center" }}><Text style={{ color: "#fff", fontWeight: "700" }}>{busy ? "Сохранение…" : "Сохранить запись"}</Text></Pressable>
        {selected ? <>
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
            })}><Text style={{ color: t.accent }}>Добавить событие</Text></Pressable>
            <Text style={{ color: t.text, fontWeight: "700" }}>Связанные записи ({relations.length})</Text>
            {relations.map(r => <Text key={r.id} style={{ color: t.muted }}>{related.find(e => e.id === (r.source_entity_id === selected.id ? r.target_entity_id : r.source_entity_id))?.title || "Другая запись"}</Text>)}
            <Pressable accessibilityRole="button" accessibilityLabel="Связать с другой записью" style={button} onPress={() => setLinkOpen(true)}><Text style={{ color: t.accent }}>+ Связать с другой записью</Text></Pressable>
          </View> : null}
          <Pressable accessibilityRole="button" accessibilityLabel={selected.record_status === "archived" ? "Вернуть запись из архива" : "Архивировать запись"} disabled={busy || dirty} style={button} onPress={() => void run(async db => {
            await db.setEntityStatus(selected.id, selected.record_version, selected.record_status === "archived" ? "active" : "archived");
            if (alive.current) setLeaving(true);
          })}><Text style={{ color: t.muted }}>{selected.record_status === "archived" ? "Вернуть из архива" : "Перенести в архив"}</Text></Pressable>
        </> : null}
      </> : null}
      {error ? <Text accessibilityRole="alert" style={{ color: t.err }}>{error}</Text> : null}
      {!loading && !repository.current ? <Pressable accessibilityRole="button" style={button} onPress={() => setRetry(n => n + 1)}><Text style={{ color: t.accent }}>Повторить загрузку</Text></Pressable> : null}
    </ScrollView>
    <BottomSheet visible={sectionOpen} title="Раздел записи" onClose={() => setSectionOpen(false)}>
      {collections.length ? collections.map(c => <Pressable key={c.id} accessibilityRole="button" accessibilityLabel={"Поместить в раздел " + c.name} accessibilityState={{ selected: c.id === collectionId }} style={button} onPress={() => { setCollectionId(c.id); setSectionOpen(false); }}><Text style={{ color: c.id === collectionId ? t.accent : t.text }}>{c.name}</Text></Pressable>) : <Text style={{ color: t.muted }}>Первая запись будет в разделе «Заметки». Другие разделы можно создать на странице памяти.</Text>}
    </BottomSheet>
    <BottomSheet visible={linkOpen} title="Связать записи" onClose={() => { setLinkOpen(false); void loadDetails(); }}>
      <TextInput accessibilityLabel="Найти связанную запись" value={linkSearch} onChangeText={setLinkSearch} placeholder="Поиск" placeholderTextColor={t.muted} style={field} />
      {related.filter(e => e.id !== selected?.id && !relations.some(r => r.source_entity_id === e.id || r.target_entity_id === e.id)).map(e => <Pressable key={e.id} accessibilityRole="button" style={button} onPress={() => void run(async db => {
        if (!selected) return; await db.linkEntities(selected.id, e.id, "related_to");
        if (alive.current) { setRelations(await db.relationsForEntity(selected.id)); setLinkOpen(false); }
      })}><Text style={{ color: t.accent }}>{e.title || "Без названия"}</Text></Pressable>)}
      {error ? <Text accessibilityRole="alert" style={{ color: t.err }}>{error}</Text> : null}
    </BottomSheet>
  </KeyboardAvoidingView>;
}
