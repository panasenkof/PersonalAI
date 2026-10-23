import Feather from "@expo/vector-icons/Feather";
import { useFocusEffect, useNavigation } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import * as Crypto from "expo-crypto";
import React, { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, Alert, FlatList, Pressable, ScrollView, Text, TextInput, View } from "react-native";
import { useProfile } from "../profile/ProfileContext";
import { BottomSheet } from "../components/BottomSheet";
import { localMemoryRepository } from "../local-memory/repository";
import type { SqliteMemoryRepository } from "../local-memory/repository";
import type { CollectionRecord, EntityRecord } from "../local-memory/types";
import { memoryErrorMessage } from "../local-memory/errors";
import { ensureSections, orderCollections } from "../local-memory/sections";
import type { RootStackParams } from "../navigation";
import { useTheme } from "../theme";
import { nebulaSpacing, nebulaRadii, nebulaTouch } from "../design/nebula/tokens";
import { MemoryNoteCard } from "../design/nebula/MemoryNoteCard";

import { mergeText, type NoteAction } from "../local-memory/note-actions";
import { scheduleVectors } from "../media/vector-runner";

export function LocalMemoryScreen() {
  const t = useTheme(); const navigation = useNavigation<NativeStackNavigationProp<RootStackParams>>();
  const profile = useProfile();
  const [collections, setCollections] = useState<CollectionRecord[]>([]);
  const [collectionId, setCollectionId] = useState<string | undefined>();
  const [status, setStatus] = useState<"active" | "archived" | "trashed">("active");
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [moveOpen, setMoveOpen] = useState(false);
  const [mergeOpen, setMergeOpen] = useState(false);
  const [undo, setUndo] = useState("");
  const [search, setSearch] = useState(""); const [term, setTerm] = useState("");
  const [notes, setNotes] = useState<EntityRecord[]>([]); const [more, setMore] = useState(false);
  const selectedNotes = notes.filter(n => selectedIds.includes(n.id));
  const [loading, setLoading] = useState(true); const [busy, setBusy] = useState(false);
  const [error, setError] = useState(""); const [retry, setRetry] = useState(0);
  const [sectionOpen, setSectionOpen] = useState(false); const [sectionName, setSectionName] = useState("");
  const repository = useRef<SqliteMemoryRepository | null>(null); const generation = useRef(0);
  useEffect(() => { const timer = setTimeout(() => setTerm(search.trim()), 250); return () => clearTimeout(timer); }, [search]);
  useEffect(() => { setCollectionId(undefined); setSearch(""); setStatus("active"); setCollections([]); setNotes([]); }, [profile]);
  useFocusEffect(useCallback(() => {
    const request = ++generation.current; setLoading(true); setError("");
    if (profile) void localMemoryRepository(profile).then(async db => {
      const [sections, page] = await Promise.all([ensureSections(db), db.searchNotes(term, 50, 0, { collectionId, status })]);
      if (request !== generation.current) return;
      repository.current = db; void db.lastNoteOperation().then(value => { if (request === generation.current) setUndo(value); }).catch(() => {}); setCollections(sections); setNotes(page); setMore(page.length === 50);
    }).catch(e => { if (request === generation.current) { repository.current = null; setError(memoryErrorMessage(e)); } })
      .finally(() => { if (request === generation.current) setLoading(false); });
    return () => { generation.current++; repository.current = null; };
  }, [profile, term, collectionId, status, retry]));
  async function act(action: NoteAction, target?: string) {
    if (!repository.current || busy) return;
    setBusy(true); setError("");
    try {
      const token = await repository.current.changeNotes(action, selectedNotes, target);
      setUndo(token); setSelectedIds([]); setMoveOpen(false); setMergeOpen(false); setRetry(n => n + 1);
      if (profile) scheduleVectors(profile);
    } catch (e) { setError(memoryErrorMessage(e)); } finally { setBusy(false); }
  }
  useEffect(() => { setSelectedIds([]); }, [collectionId, term, status]);
  async function loadMore() {
    if (!repository.current || busy) return;
    const request = generation.current; setBusy(true);
    try {
      const page = await repository.current.searchNotes(term, 50, notes.length, { collectionId, status });
      if (request === generation.current) { setNotes(prev => [...prev, ...page]); setMore(page.length === 50); }
    } catch (e) { if (request === generation.current) setError(memoryErrorMessage(e)); }
    finally { setBusy(false); }
  }
  async function addSection() {
    if (!repository.current || busy || !sectionName.trim()) return;
    const request = generation.current; setBusy(true); setError("");
    try {
      const created = await repository.current.createCollection({ name: sectionName.trim(), slug: "section-" + Crypto.randomUUID(), sensitivity: "standard" });
      if (request === generation.current) { setCollections(prev => orderCollections([...prev, created])); setCollectionId(created.id); setSectionName(""); setSectionOpen(false); }
    } catch (e) { if (request === generation.current) setError(memoryErrorMessage(e)); }
    finally { setBusy(false); }
  }
  const button = { minHeight: 48, justifyContent: "center" as const, alignItems: "center" as const, borderRadius: 16, paddingHorizontal: 16 };
  return <View style={{ flex: 1, backgroundColor: t.bg }}>
    <FlatList
      testID="memory-note-list"
      ListHeaderComponent={<View style={{ paddingTop: nebulaSpacing.sm, paddingBottom: nebulaSpacing.sm, gap: nebulaSpacing.sm }}>
        <View style={{ flexDirection: "row", justifyContent: "flex-end", alignItems: "center", gap: nebulaSpacing.xs }}>
          <Pressable accessibilityRole="button" accessibilityLabel="Добавить сведения из файла"
            onPress={() => navigation.navigate("MemoryImport")}
            style={{ minWidth: nebulaTouch.minimum, minHeight: nebulaTouch.minimum, alignItems: "center", justifyContent: "center", borderRadius: nebulaRadii.field, borderWidth: 1, borderColor: t.line, backgroundColor: t.panel }}>
            <Feather name="paperclip" size={20} color={t.secondary} />
          </Pressable>
          <Pressable accessibilityRole="button" accessibilityLabel="Новая заметка"
            onPress={() => navigation.navigate("MemoryNote", { collectionId })}
            style={{ ...button, flexDirection: "row", gap: 6, minHeight: nebulaTouch.minimum, backgroundColor: t.accent }}>
            <Feather name="plus" size={18} color="#fff" />
            <Text style={{ color: "#fff", fontWeight: "700", fontSize: 15 }}>Запись</Text>
          </Pressable>
        </View>
        <View style={{ flexDirection: "row", alignItems: "center", borderWidth: 1, borderColor: t.line, borderRadius: nebulaRadii.field, backgroundColor: t.panel }}>
          <Feather name="search" size={19} color={t.muted} style={{ marginLeft: nebulaSpacing.sm }} />
          <TextInput testID="memory-search" accessibilityLabel="Поиск по заметкам"
            value={search} onChangeText={setSearch} placeholder="Поиск по памяти"
            placeholderTextColor={t.muted} returnKeyType="search"
            style={{ flex: 1, minWidth: 0, minHeight: nebulaTouch.minimum, fontSize: 16, color: t.text, paddingHorizontal: nebulaSpacing.sm }} />
          {search ? <Pressable accessibilityRole="button" accessibilityLabel="Очистить поиск по памяти"
            onPress={() => setSearch("")} style={{ minWidth: nebulaTouch.minimum, minHeight: nebulaTouch.minimum, justifyContent: "center", alignItems: "center" }}>
            <Feather name="x" size={20} color={t.muted} />
          </Pressable> : null}
        </View>
        <ScrollView horizontal showsHorizontalScrollIndicator={false} keyboardShouldPersistTaps="handled"
          contentContainerStyle={{ gap: nebulaSpacing.xs, alignItems: "center" }}>
          {[{ id: undefined, name: "Все записи" }, ...collections].map(c => {
            const chosen = c.id === collectionId;
            return <Pressable key={c.id || "all"} accessibilityRole="button"
              accessibilityLabel={"Раздел " + c.name} accessibilityState={{ selected: chosen }}
              onPress={() => setCollectionId(c.id)}
              style={{ minHeight: nebulaTouch.minimum, paddingHorizontal: nebulaSpacing.md, alignItems: "center", justifyContent: "center",
                borderRadius: nebulaRadii.pill, borderWidth: 1, borderColor: chosen ? t.accent : t.line, backgroundColor: chosen ? t.soft : t.panel }}>
              <Text numberOfLines={1} style={{ color: chosen ? t.secondary : t.text, fontSize: 14, fontWeight: chosen ? "700" : "500" }}>{c.name}</Text>
            </Pressable>;
          })}
          <Pressable accessibilityRole="button" accessibilityLabel="Новый раздел памяти"
            onPress={() => setSectionOpen(true)}
            style={{ minHeight: nebulaTouch.minimum, flexDirection: "row", alignItems: "center", paddingHorizontal: nebulaSpacing.md,
              borderRadius: nebulaRadii.pill, borderWidth: 1, borderColor: t.line, gap: 6 }}>
            <Feather name="folder-plus" size={18} color={t.secondary} /><Text style={{ color: t.secondary }}>Раздел</Text>
          </Pressable>
        </ScrollView>
        <View style={{ flexDirection: "row", alignItems: "center", gap: nebulaSpacing.xs }}>
          <Pressable accessibilityRole="button" accessibilityLabel="Открыть текущие записи"
            accessibilityState={{ selected: status === "active" }} onPress={() => setStatus("active")}
            style={{ ...button, paddingHorizontal: nebulaSpacing.sm, minHeight: nebulaTouch.minimum, backgroundColor: status === "active" ? t.soft : "transparent" }}>
            <Text style={{ color: status === "active" ? t.secondary : t.muted, fontWeight: "600", fontSize: 13 }}>Записи</Text>
          </Pressable>
          <Pressable accessibilityRole="button" accessibilityLabel="Открыть архив"
            accessibilityState={{ selected: status === "archived" }} onPress={() => setStatus("archived")}
            style={{ ...button, paddingHorizontal: nebulaSpacing.sm, minHeight: nebulaTouch.minimum, backgroundColor: status === "archived" ? t.soft : "transparent" }}>
            <Text style={{ color: status === "archived" ? t.secondary : t.muted, fontWeight: "600", fontSize: 13 }}>Архив</Text>
          </Pressable>
          <Pressable accessibilityRole="button" accessibilityLabel="Открыть корзину"
            accessibilityState={{ selected: status === "trashed" }} onPress={() => setStatus("trashed")}
            style={{ ...button, paddingHorizontal: nebulaSpacing.sm, minHeight: nebulaTouch.minimum, backgroundColor: status === "trashed" ? t.soft : "transparent" }}>
            <Text style={{ color: status === "trashed" ? t.secondary : t.muted, fontWeight: "600", fontSize: 13 }}>Корзина</Text>
          </Pressable>
          <View style={{ flex: 1 }} />
          <Text accessibilityLiveRegion="polite" style={{ color: t.muted, fontSize: 12 }}>
            {loading ? "Загрузка…" : `${notes.length}${more ? "+" : ""}`}
          </Text>
        </View>
        <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "flex-end", gap: nebulaSpacing.md }}>
          <Pressable accessibilityRole="button" accessibilityLabel="Резервные копии"
            onPress={() => navigation.navigate("MemoryBackup")}
            style={{ minHeight: nebulaTouch.minimum, flexDirection: "row", alignItems: "center", gap: 6 }}>
            <Feather name="download-cloud" size={16} color={t.secondary} />
            <Text style={{ color: t.secondary, fontSize: 13 }}>Копии</Text>
          </Pressable>
          <Pressable accessibilityRole="button" accessibilityLabel={selectedIds.length ? "Снять выбор записей" : "Выбрать показанные записи"}
            onPress={() => setSelectedIds(selectedIds.length ? [] : notes.slice(0, 100).map(n => n.id))}
            style={{ minHeight: nebulaTouch.minimum, flexDirection: "row", alignItems: "center", gap: 6 }}>
            <Feather name={selectedIds.length ? "x-circle" : "check-square"} size={16} color={t.secondary} />
            <Text style={{ color: t.secondary, fontSize: 13 }}>{selectedIds.length ? `Выбрано: ${selectedIds.length}` : "Выбрать"}</Text>
          </Pressable>
        </View>
        {status === "trashed" ? <Text style={{ color: t.muted, fontSize: 13, lineHeight: 19 }}>
          Удалённые записи исключены из поиска агента. Их можно восстановить или удалить окончательно.
        </Text> : null}
      {selectedIds.length ? <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 12 }}>
        {status === "trashed" ? <>
          <Pressable disabled={busy} style={button} onPress={() => void act("restore")}><Text style={{ color: t.secondary }}>Восстановить</Text></Pressable>
          <Pressable disabled={busy} style={button} onPress={() => Alert.alert("Удалить навсегда?", "Исчезнут выбранные записи, их оригиналы и история. Отменить это действие нельзя.\n" + selectedNotes.map(n => n.title).join("\n"), [{ text: "Отмена", style: "cancel" }, { text: "Удалить навсегда", style: "destructive", onPress: () => { if (!repository.current) return; setBusy(true); void repository.current.purgeNotes(selectedNotes).then(() => { setSelectedIds([]); setUndo(""); setRetry(n => n + 1); }).catch(e => setError(memoryErrorMessage(e))).finally(() => setBusy(false)); } }])}><Text style={{ color: t.err }}>Удалить навсегда</Text></Pressable>
        </> : <>
          <Pressable disabled={busy} style={button} onPress={() => setMoveOpen(true)}><Text style={{ color: t.secondary }}>Перенести</Text></Pressable>
          <Pressable disabled={busy || selectedIds.length < 2 || status !== "active"} style={button} onPress={() => setMergeOpen(true)}><Text style={{ color: t.secondary }}>Объединить</Text></Pressable>
          <Pressable disabled={busy} style={button} onPress={() => Alert.alert("В корзину?", selectedNotes.map(n => n.title || "Без названия").join("\n"), [{ text: "Отмена", style: "cancel" }, { text: "В корзину", onPress: () => void act("trash") }])}><Text style={{ color: t.err }}>Удалить</Text></Pressable>
        </>}
      </View> : null}
      {undo ? <Pressable disabled={busy} style={button} onPress={() => { if (!repository.current) return; setBusy(true); void repository.current.undoNotes(undo).then(() => { setUndo(""); setRetry(n => n + 1); if (profile) scheduleVectors(profile); }).catch(e => setError(memoryErrorMessage(e))).finally(() => setBusy(false)); }}><Text style={{ color: t.secondary }}>Отменить последнюю операцию</Text></Pressable> : null}
    {error ? <View style={{ paddingHorizontal: 18, gap: 8 }}><Text accessibilityRole="alert" style={{ color: t.err }}>{error}</Text><Pressable accessibilityRole="button" onPress={() => setRetry(n => n + 1)} style={button}><Text style={{ color: t.secondary }}>Повторить загрузку</Text></Pressable></View> : null}
    {loading ? <ActivityIndicator accessibilityLabel="Загрузка записей" /> : null}
</View>} data={loading ? [] : notes} keyExtractor={item => item.id} keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag"
      contentContainerStyle={{ paddingHorizontal: nebulaSpacing.md, paddingBottom: nebulaSpacing.xl, gap: nebulaSpacing.sm, flexGrow: 1 }}
      ListEmptyComponent={!loading && !error ? <View style={{ flex: 1, alignItems: "center", justifyContent: "center", padding: 24, gap: 12 }}><Feather name={term ? "search" : "book-open"} size={40} color={t.secondary} />
        <Text style={{ color: t.text, fontSize: 20, fontWeight: "700", textAlign: "center" }}>{term ? "Ничего не найдено" : status === "archived" ? "Архив пуст" : status === "trashed" ? "Корзина пуста" : "Начните с важного"}</Text>
        <Text style={{ color: t.muted, textAlign: "center", lineHeight: 21 }}>{term ? "Попробуйте другое слово или раздел «Все записи»." : status === "trashed" ? "Здесь будут удалённые заметки, пока вы их не восстановите." : "Создайте запись или добавьте сведения из файла."}</Text></View> : null}
      renderItem={({ item }) => <MemoryNoteCard note={item}
        sectionName={collections.find(c => c.id === item.collection_id)?.name || "Запись"}
        selected={selectedIds.includes(item.id)}
        onToggleSelection={() => setSelectedIds(ids => ids.includes(item.id) ? ids.filter(id => id !== item.id) : [...ids, item.id])}
        onOpen={() => selectedIds.length
          ? setSelectedIds(ids => ids.includes(item.id) ? ids.filter(id => id !== item.id) : [...ids, item.id])
          : navigation.navigate("MemoryNote", { entityId: item.id })}
      />}
      ListFooterComponent={more && !loading ? <Pressable accessibilityRole="button" accessibilityLabel="Показать ещё заметки" disabled={busy} onPress={() => void loadMore()} style={button}><Text style={{ color: t.secondary }}>{busy ? "Загружаю…" : "Показать ещё"}</Text></Pressable> : null} />
    <BottomSheet visible={moveOpen} title="Перенести выбранные записи" onClose={() => setMoveOpen(false)}>
      <Text style={{ color: t.muted }}>{selectedNotes.map(n => n.title).join(", ")}</Text>
      {collections.map(c => <Pressable key={c.id} disabled={busy} style={button} onPress={() => void act("move", c.id)}><Text style={{ color: t.secondary }}>{c.name}</Text></Pressable>)}
    </BottomSheet>
    <BottomSheet visible={mergeOpen} title="Предпросмотр объединения" onClose={() => setMergeOpen(false)}>
      <Text style={{ color: t.muted }}>Название первой выбранной записи сохраняется. Тексты остаются отдельными блоками; вложения и источники сохраняются. Противоречия не исправляются автоматически.</Text>
      <ScrollView style={{ maxHeight: 300 }}><Text style={{ color: t.text }}>{mergeText(selectedNotes)}</Text></ScrollView>
      <Pressable disabled={busy} style={button} onPress={() => void act("merge")}><Text style={{ color: t.secondary }}>Подтвердить объединение</Text></Pressable>
    </BottomSheet>
    <BottomSheet visible={sectionOpen} title="Новый раздел" onClose={() => setSectionOpen(false)}>
      <Text style={{ color: t.muted }}>Например: «Рецепты», «Идеи» или «Планы».</Text>
      <TextInput accessibilityLabel="Название раздела памяти" value={sectionName} onChangeText={setSectionName} maxLength={80} placeholder="Название" placeholderTextColor={t.muted} style={{ minHeight: 50, padding: 12, borderWidth: 1, borderColor: t.line, borderRadius: 16, color: t.text }} />
      <Pressable accessibilityRole="button" accessibilityLabel="Создать раздел" disabled={busy || !sectionName.trim()} onPress={() => void addSection()} style={{ ...button, backgroundColor: t.accent }}><Text style={{ color: "#fff", fontWeight: "700" }}>{busy ? "Создаю…" : "Создать раздел"}</Text></Pressable>
      {error ? <Text accessibilityRole="alert" style={{ color: t.err }}>{error}</Text> : null}
    </BottomSheet>
  </View>;
}
