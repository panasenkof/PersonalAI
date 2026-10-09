import { useFocusEffect } from "@react-navigation/native";
import React, { useCallback, useState } from "react";
import {
  ActivityIndicator, KeyboardAvoidingView, Platform, Pressable,
  ScrollView, StyleSheet, Text, TextInput, View,
} from "react-native";

import { useAuth } from "../auth/AuthContext";
import { MemoryConflictError } from "../local-memory/types";
import type { EntityRecord, ObservationRecord, RelationRecord, RevisionRecord } from "../local-memory/types";
import { localMemoryRepository, SqliteMemoryRepository } from "../local-memory/repository";
import { closeLocalMemory } from "../local-memory/storage";
import { useTheme } from "../theme";

const bodyOf = (e: EntityRecord): string => typeof e.payload.body === "string" ? e.payload.body : "";
const titleOf = (e: EntityRecord): string => e.title || "Без названия";

export function LocalMemoryScreen() {
  const t = useTheme();
  const { offlineMode, closeOffline, me } = useAuth();
  const profileId = offlineMode ? "guest" : me?.id;
  const [repo, setRepo] = useState<SqliteMemoryRepository | null>(null);
  const [notes, setNotes] = useState<EntityRecord[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<EntityRecord | null>(null);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [eventText, setEventText] = useState("");
  const [history, setHistory] = useState<RevisionRecord[]>([]);
  const [events, setEvents] = useState<ObservationRecord[]>([]);
  const [relations, setRelations] = useState<RelationRecord[]>([]);
  const [message, setMessage] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async (db: SqliteMemoryRepository, term: string, entityId?: string) => {
    const page = await db.searchNotes(term, 50);
    setNotes(page);
    setHasMore(page.length === 50);
    if (entityId) {
      setHistory(await db.revisions("entity", entityId));
      setEvents(await db.observations(entityId));
      setRelations(await db.relationsForEntity(entityId));
    }
  }, []);

  useFocusEffect(useCallback(() => {
    let alive = true;
    setRepo(null);
    setNotes([]);
    setSelected(null);
    setHistory([]);
    setEvents([]);
    setRelations([]);
    setTitle("");
    setBody("");
    setLoading(true);
    if (!profileId) {
      setMessage("Для доступа к локальной памяти выберите локальный режим или войдите.");
      setLoading(false);
      return () => {};
    }
    void localMemoryRepository(profileId).then(async db => {
      if (!alive) return;
      setRepo(db);
      await refresh(db, search, selected?.id);
      if (alive) setMessage("");
    }).catch((e: Error) => {
      if (alive) setMessage(e.message === "sqlcipher_required_native_build"
        ? "Для локального шифрования требуется отдельная сборка с SQLCipher. Expo Go не поддерживается."
        : e.message === "local_memory_biometric_required"
          ? "Для защищённой локальной памяти необходимо настроить биометрию телефона."
          : "Не удалось разблокировать локальную память: " + e.message);
    }).finally(() => { if (alive) setLoading(false); });
    return () => {
      alive = false;
      void closeLocalMemory();
    };
  }, [refresh, profileId]));

  const run = async (task: () => Promise<void>) => {
    if (busy || !repo) return;
    setBusy(true); setMessage("");
    try { await task(); }
    catch (e) {
      setMessage(e instanceof MemoryConflictError
        ? "Запись была изменена. Откройте её заново, чтобы не потерять изменения."
        : String((e as Error).message));
    } finally { setBusy(false); }
  };
  const loadMore = async () => {
    if (busy || !repo || !hasMore) return;
    setBusy(true);
    try {
      const next = await repo.searchNotes(search, 50, notes.length);
      setNotes(previous => [...previous, ...next]);
      setHasMore(next.length === 50);
    } catch (e) {
      setMessage(String((e as Error).message));
    } finally { setBusy(false); }
  };
  const selectNote = async (item: EntityRecord) => {
    if (!repo) return;
    setSelected(item);
    setTitle(titleOf(item));
    setBody(bodyOf(item));
    setEventText("");
    await refresh(repo, search, item.id);
  };
  const save = () => run(async () => {
    if (!title.trim() && !body.trim()) throw new Error("Введите заголовок или текст заметки");
    let saved: EntityRecord;
    if (selected) {
      saved = await repo!.reviseEntity(
        selected.id, selected.record_version,
        { type: "note", title: title.trim(), body: body.trim() },
        "Редактирование заметки на телефоне",
      );
    } else {
      const collections = await repo!.listCollections();
      let notesCollection = collections.find(c => c.slug === "notes");
      if (!notesCollection) notesCollection = await repo!.createCollection({
        name: "Заметки", slug: "notes", sensitivity: "standard",
      });
      saved = await repo!.createEntity({
        collection_id: notesCollection.id, domain: "notes", title: title.trim(),
        payload: { type: "note", title: title.trim(), body: body.trim() },
        sensitivity: "standard", source_kind: "user", source_ref: "device",
      });
    }
    setSelected(saved);
    setTitle(titleOf(saved)); setBody(bodyOf(saved));
    await refresh(repo!, search, saved.id);
    setMessage("Сохранено локально. Сервер не использовался.");
  });
  const addEvent = () => run(async () => {
    if (!selected || !eventText.trim()) return;
    await repo!.createObservation({
      entity_id: selected.id, kind: "note_event", occurred_at: new Date().toISOString(),
      payload: { text: eventText.trim() }, sensitivity: "standard",
      source_kind: "user", source_ref: "device",
    });
    setEventText("");
    await refresh(repo!, search, selected.id);
    setMessage("Событие сохранено на телефоне.");
  });
  const link = (target: EntityRecord) => run(async () => {
    if (!selected) return;
    await repo!.linkEntities(selected.id, target.id, "related_to");
    await refresh(repo!, search, selected.id);
    setMessage("Записи связаны на телефоне.");
  });

  const input = [styles.input, { backgroundColor: t.panel, borderColor: t.line, color: t.text }];
  const action = [styles.button, { backgroundColor: t.accent }];
  return (
    <KeyboardAvoidingView style={{ flex: 1, backgroundColor: t.bg }} behavior={Platform.OS === "ios" ? "padding" : undefined}>
      <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={styles.page}>
        <Text style={[styles.title, { color: t.text }]}>🔐 Моя память на телефоне</Text>
        <Text style={{ color: t.muted }}>
          Заметки, история правок и связи хранятся только здесь. С серверной базой не синхронизируются.
        </Text>
        {offlineMode && (
          <Pressable accessibilityRole="button" accessibilityLabel="Вернуться к входу на сервер"
            style={[styles.button, { borderWidth: 1, borderColor: t.line }]}
            onPress={() => void closeOffline()}>
            <Text style={{ color: t.text, textAlign: "center" }}>Перейти к входу на сервер</Text>
          </Pressable>
        )}
        {loading && <ActivityIndicator accessibilityLabel="Открытие локальной базы" />}
        {message ? <Text accessibilityRole="alert" style={{ color: t.muted }}>{message}</Text> : null}
        {repo ? (
          <>
            <TextInput accessibilityLabel="Поиск по локальным заметкам" placeholder="Поиск без интернета"
              placeholderTextColor={t.muted} value={search} onChangeText={setSearch}
              style={input} onSubmitEditing={() => void refresh(repo, search, selected?.id)} />
            <Pressable accessibilityRole="button" style={action}
              onPress={() => void run(() => refresh(repo, search, selected?.id))}>
              <Text style={styles.white}>Найти заметки</Text>
            </Pressable>
            <Pressable accessibilityRole="button" style={[styles.button, { borderWidth: 1, borderColor: t.line }]}
              onPress={() => { setSelected(null); setTitle(""); setBody(""); setHistory([]); setRelations([]); setEvents([]); }}>
              <Text style={{ color: t.text, textAlign: "center" }}>＋ Новая заметка</Text>
            </Pressable>
            {notes.map(item => (
              <Pressable accessibilityRole="button" key={item.id}
                accessibilityLabel={"Открыть заметку " + titleOf(item)}
                style={[styles.note, { backgroundColor: t.panel, borderColor: t.line }]}
                onPress={() => void selectNote(item)}>
                <Text style={{ color: t.text, fontWeight: "600" }}>{titleOf(item)}</Text>
                <Text style={{ color: t.muted }} numberOfLines={2}>{bodyOf(item)}</Text>
              </Pressable>
            ))}
            {hasMore && (
              <Pressable accessibilityRole="button" accessibilityLabel="Показать ещё локальные заметки"
                disabled={busy} style={[styles.button, { borderWidth: 1, borderColor: t.line }]}
                onPress={() => void loadMore()}>
                <Text style={{ color: t.text, textAlign: "center" }}>Показать ещё</Text>
              </Pressable>
            )}
            <Text style={[styles.heading, { color: t.text }]}>{selected ? "Редактирование" : "Новая заметка"}</Text>
            <TextInput accessibilityLabel="Заголовок заметки" value={title} onChangeText={setTitle}
              placeholder="Заголовок" placeholderTextColor={t.muted} style={input} />
            <TextInput accessibilityLabel="Текст заметки" multiline value={body} onChangeText={setBody}
              placeholder="Текст — всё остаётся на устройстве" placeholderTextColor={t.muted}
              style={[input, { minHeight: 110, textAlignVertical: "top" }]} />
            <Pressable accessibilityRole="button" disabled={busy} style={action} onPress={save}>
              <Text style={styles.white}>Сохранить локально</Text>
            </Pressable>
            {selected && (
              <>
                <Text style={{ color: t.muted }}>Версия {selected.record_version} · Исправлений: {history.length}</Text>
                {history.map(r => <Text key={r.id} style={{ color: t.muted }}>
                  Версия {r.version}: {r.reason}
                </Text>)}
                <Text style={[styles.heading, { color: t.text }]}>События</Text>
                {events.map(e => <Text key={e.id} style={{ color: t.text }}>
                  {new Date(e.occurred_at).toLocaleDateString()}: {String(e.payload.text ?? e.kind)}
                </Text>)}
                <TextInput accessibilityLabel="Новое событие" value={eventText} onChangeText={setEventText}
                  placeholder="Что произошло?" placeholderTextColor={t.muted} style={input} />
                <Pressable accessibilityRole="button" disabled={busy || !eventText.trim()}
                  style={action} onPress={addEvent}>
                  <Text style={styles.white}>Добавить событие</Text>
                </Pressable>
                <Text style={[styles.heading, { color: t.text }]}>Связи ({relations.length})</Text>
                {relations.map(r => <Text key={r.id} style={{ color: t.muted }}>
                  {r.kind}: {notes.find(n => n.id ===
                    (r.source_entity_id === selected.id ? r.target_entity_id : r.source_entity_id))?.title ?? "Другая запись"}
                </Text>)}
                {notes.filter(n => n.id !== selected.id && !relations.some(r =>
                  (r.source_entity_id === selected.id && r.target_entity_id === n.id) ||
                  (r.target_entity_id === selected.id && r.source_entity_id === n.id))).map(n => (
                    <Pressable key={n.id} accessibilityRole="button"
                      style={[styles.button, { borderWidth: 1, borderColor: t.line }]}
                      onPress={() => void link(n)}>
                      <Text style={{ color: t.text }}>Связать с: {titleOf(n)}</Text>
                    </Pressable>
                  ))}
              </>
            )}
          </>
        ) : null}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  page: { padding: 18, paddingBottom: 60, gap: 12 },
  title: { fontSize: 22, fontWeight: "700" },
  heading: { fontSize: 18, fontWeight: "600", marginTop: 10 },
  input: { borderRadius: 10, borderWidth: 1, padding: 12, minHeight: 48, fontSize: 16 },
  button: { borderRadius: 10, minHeight: 48, justifyContent: "center", padding: 12 },
  white: { color: "#fff", textAlign: "center", fontWeight: "600" },
  note: { borderWidth: 1, borderRadius: 10, padding: 12, gap: 6 },
});
