import { useSafeAreaInsets } from "react-native-safe-area-context";
import Feather from "@expo/vector-icons/Feather";
import { useFocusEffect, useNavigation } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import * as Crypto from "expo-crypto";
import React, { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, Alert, FlatList, Pressable, ScrollView, Text, TextInput, View, useWindowDimensions } from "react-native";
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
import { MemoryCover } from "../media/MemoryCover";
import { memoryDisplayTitle, memoryNoteHasPhoto } from "../design/nebula/memoryNotePresentation";
import { MemoryNoteCard } from "../design/nebula/MemoryNoteCard";

import { mergeText, type NoteAction } from "../local-memory/note-actions";
import { scheduleVectors } from "../media/vector-runner";

export function LocalMemoryScreen() {
  const t = useTheme(); const navigation = useNavigation<NativeStackNavigationProp<RootStackParams>>();
  const profile = useProfile(); const insets = useSafeAreaInsets();
  const { width, fontScale } = useWindowDimensions();
  const [grid, setGrid] = useState(true);
  const columns = grid && width >= 350 && fontScale < 1.4 ? 2 : 1;
  const [addOpen, setAddOpen] = useState(false);
  const [selecting, setSelecting] = useState(false);
  const [actionsOpen, setActionsOpen] = useState(false);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [menuOpen, setMenuOpen] = useState(false);
  const [collectionMenu, setCollectionMenu] = useState(false);
  const [collectionCards, setCollectionCards] = useState<CollectionRecord[]>([]);
  const [covers, setCovers] = useState<Record<string, EntityRecord>>({});
  const [visibleIds, setVisibleIds] = useState<Set<string>>(new Set());
  const onViewableItemsChanged = useRef(({ viewableItems }: { viewableItems: { item: EntityRecord }[] }) => setVisibleIds(new Set(viewableItems.map(x => x.item.id)))).current;
  const viewabilityConfig = useRef({ itemVisiblePercentThreshold: 10 }).current;
  const [collections, setCollections] = useState<CollectionRecord[]>([]);
  const [collectionId, setCollectionId] = useState<string | undefined>();
  const [status, setStatus] = useState<"active" | "archived" | "trashed">("active");
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [moveOpen, setMoveOpen] = useState(false);
  const [mergeOpen, setMergeOpen] = useState(false);
  const [undo, setUndo] = useState("");
  const [search, setSearch] = useState(""); const [term, setTerm] = useState("");
  const [notes, setNotes] = useState<EntityRecord[]>([]); const [more, setMore] = useState(false);
  const selectedNotes = selectedIds.map(id => notes.find(n => n.id === id)).filter((note): note is EntityRecord => Boolean(note));
  const [loading, setLoading] = useState(true); const [busy, setBusy] = useState(false);
  const [error, setError] = useState(""); const [retry, setRetry] = useState(0);
  const [sectionOpen, setSectionOpen] = useState(false); const [sectionName, setSectionName] = useState("");
  const repository = useRef<SqliteMemoryRepository | null>(null); const generation = useRef(0);
  useEffect(() => { const timer = setTimeout(() => setTerm(search.trim()), 250); return () => clearTimeout(timer); }, [search]);
  useEffect(() => { setCollectionId(undefined); setSearch(""); setStatus("active"); setCollections([]); setNotes([]); setCollectionCards([]); setCovers({}); setSelectedIds([]); setSelecting(false); setCounts({}); setVisibleIds(new Set()); }, [profile]);
  useFocusEffect(useCallback(() => {
    const request = ++generation.current; setLoading(true); setError("");
    if (profile) void localMemoryRepository(profile).then(async db => {
      const [sections, page, totals] = await Promise.all([ensureSections(db), db.searchNotes(term, 50, 0, { collectionId, status }), db.collectionNoteCounts()]);
      if (request !== generation.current) return;
      setCounts(totals); repository.current = db; void db.lastNoteOperation().then(value => { if (request === generation.current) setUndo(value); }).catch(() => {}); setCollections(sections); setNotes(page); setMore(page.length === 50);
      const recentIds = [...new Set(page.map(n => n.collection_id))];
      const shownSections = [...sections].sort((a, b) => {
        const rank = (id: string) => recentIds.includes(id) ? recentIds.indexOf(id) : recentIds.length;
        return rank(a.id) - rank(b.id);
      }).slice(0, 6);
      if (!term && !collectionId && status === "active") setCollectionCards(shownSections);
      const entries = await Promise.all(shownSections.map(async section => {
        const recent = await db.searchNotes("", 12, 0, { collectionId: section.id, status: "active" });
        return [section.id, recent.find(memoryNoteHasPhoto)] as const;
      }));
      if (request === generation.current) setCovers(Object.fromEntries(entries.filter((entry): entry is readonly [string, EntityRecord] => Boolean(entry[1]))));
    }).catch(e => { if (request === generation.current) { repository.current = null; setError(memoryErrorMessage(e)); } })
      .finally(() => { if (request === generation.current) setLoading(false); });
    return () => { generation.current++; repository.current = null; };
  }, [profile, term, collectionId, status, retry]));
  async function act(action: NoteAction, target?: string) {
    if (!repository.current || busy) return;
    setBusy(true); setError("");
    try {
      const token = await repository.current.changeNotes(action, selectedNotes, target);
      setUndo(token); setSelectedIds([]); setSelecting(false); setActionsOpen(false); setMoveOpen(false); setMergeOpen(false); setRetry(n => n + 1);
      if (profile) scheduleVectors(profile);
    } catch (e) { setError(memoryErrorMessage(e)); } finally { setBusy(false); }
  }
  useEffect(() => { setSelectedIds([]); setSelecting(false); setActionsOpen(false); }, [profile, collectionId, term, status]);
  function openAll() { setStatus("active"); setCollectionId(undefined); setSearch(""); setTerm(""); setSelectedIds([]); setSelecting(false); }
  function openStatus(value: typeof status) { openAll(); setStatus(value); setMenuOpen(false); }
  function toggleSelection(id: string) {
    if (busy) return;
    setSelecting(true);
    if (!selectedIds.includes(id) && selectedIds.length >= 100) { setError("За один раз можно выбрать до 100 записей."); return; }
    setSelectedIds(ids => ids.includes(id) ? ids.filter(value => value !== id) : [...ids, id]);
  }
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
  const actionButton = { ...button, alignItems: "flex-start" as const, borderBottomWidth: 1, borderBottomColor: t.line };
  return <View style={{ flex: 1, backgroundColor: t.bg, paddingTop: insets.top }}>
    {selecting ? <View testID="memory-selection-toolbar" style={{ paddingHorizontal: 16, backgroundColor: t.panel, borderBottomWidth: 1, borderBottomColor: t.line, flexDirection: "row", alignItems: "center", gap: 4 }}>
      <Pressable disabled={busy} accessibilityRole="button" accessibilityLabel="Снять выбор записей" onPress={() => { setSelectedIds([]); setSelecting(false); setActionsOpen(false); }} style={{ ...button, paddingHorizontal: 12 }}><Feather name="x" size={22} color={t.text} /></Pressable>
      <Text accessibilityLiveRegion="polite" style={{ flex: 1, color: t.text }}>Выбрано: {selectedIds.length}</Text>
      <Pressable accessibilityRole="button" accessibilityLabel="Действия с выбранными записями" accessibilityState={{ disabled: busy || !selectedIds.length }} disabled={busy || !selectedIds.length} onPress={() => setActionsOpen(true)} style={{ ...button, opacity: selectedIds.length ? 1 : .45 }}><Text style={{ color: t.secondary }}>Действия</Text></Pressable>
    </View> : null}
    <FlatList
      testID="memory-note-list" key={columns} numColumns={columns}
      onViewableItemsChanged={onViewableItemsChanged} viewabilityConfig={viewabilityConfig}
      initialNumToRender={8} windowSize={5} columnWrapperStyle={columns > 1 ? { gap: nebulaSpacing.sm, alignItems: "flex-start" } : undefined}
      ListHeaderComponent={<View style={{ paddingTop: nebulaSpacing.sm, paddingBottom: nebulaSpacing.sm, gap: nebulaSpacing.sm }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: nebulaSpacing.xs }}>
          <Text accessibilityRole="header" style={{ flex: 1, color: t.text, fontSize: 28, fontWeight: "800" }}>Память</Text>
          <Pressable accessibilityRole="button" accessibilityLabel="Добавить в память" onPress={() => setAddOpen(true)}
            style={{ ...button, paddingHorizontal: 12, backgroundColor: t.accent }}><Feather name="plus" size={24} color={t.userText} /></Pressable>
          <Pressable accessibilityRole="button" accessibilityLabel="Меню памяти" onPress={() => setMenuOpen(true)} style={{ ...button, paddingHorizontal: 12 }}><Feather name="more-vertical" size={24} color={t.text} /></Pressable>
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
        {!term && status === "active" && !collectionId ? <>
          <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
            <Text style={{ color: t.text, fontSize: 18, fontWeight: "700" }}>Коллекции</Text>
            <Pressable accessibilityRole="button" accessibilityLabel="Все коллекции" onPress={() => setCollectionMenu(true)} style={button}><Text style={{ color: t.secondary }}>Все</Text></Pressable>
          </View>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: nebulaSpacing.sm }}>
            {collectionCards.map(c => <Pressable key={c.id} accessibilityRole="button" accessibilityLabel={"Раздел " + c.name}
              onPress={() => setCollectionId(c.id)} style={{ width: Math.min(width - 48, 180 * Math.min(fontScale, 1.5)), borderRadius: nebulaRadii.field, overflow: "hidden", backgroundColor: t.panel, borderWidth: 1, borderColor: t.line }}>
              {profile && covers[c.id] ? <MemoryCover profile={profile} entityId={covers[c.id].id} compact height={80} label={"Обложка коллекции " + c.name} />
                : <View style={{ height: 48, backgroundColor: t.soft, justifyContent: "center", alignItems: "center" }}><Feather name={c.slug === "people" ? "users" : c.slug === "preferences" ? "heart" : c.slug === "events" ? "calendar" : "folder"} size={24} color={t.secondary} /></View>}
              <Text numberOfLines={2} style={{ color: t.text, fontWeight: "600", fontSize: 15, padding: nebulaSpacing.sm }}>{c.name}</Text>
              <Text style={{ color: t.muted, fontSize: 13, paddingHorizontal: nebulaSpacing.sm, paddingBottom: nebulaSpacing.sm }}>Записей: {counts[c.id] ?? 0}</Text>
            </Pressable>)}
          </ScrollView>
        </> : null}
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          {collectionId || status !== "active" || term ? <Pressable accessibilityRole="button" accessibilityLabel="Ко всем записям" onPress={openAll} style={{ ...button, paddingHorizontal: 8 }}><Feather name="arrow-left" size={20} color={t.secondary} /></Pressable> : null}
          <Text style={{ flex: 1, color: t.text, fontSize: 18, fontWeight: "700" }}>{term ? "Результаты поиска" : status === "archived" ? "Архив" : status === "trashed" ? "Корзина" : collectionId ? collections.find(c => c.id === collectionId)?.name : "Недавнее"}</Text>
          <Pressable accessibilityRole="button" accessibilityLabel={grid ? "Показать списком" : "Показать плитками"} onPress={() => setGrid(v => !v)} style={{ ...button, paddingHorizontal: 12 }}>
            <Feather name={grid ? "list" : "grid"} size={20} color={t.secondary} />
          </Pressable>
        </View>
        {!selecting && notes.length ? <Pressable accessibilityRole="button" accessibilityLabel="Выбрать записи" onPress={() => setSelecting(true)} style={{ ...button, alignItems: "flex-start" }}><Text style={{ color: t.secondary }}>Выбрать записи</Text></Pressable> : null}
        {status === "trashed" ? <Text style={{ color: t.muted, fontSize: 13, lineHeight: 19 }}>
          Удалённые записи исключены из поиска агента. Их можно восстановить или удалить окончательно.
        </Text> : null}
      {undo ? <Pressable disabled={busy} style={button} onPress={() => { if (!repository.current) return; setBusy(true); void repository.current.undoNotes(undo).then(() => { setUndo(""); setRetry(n => n + 1); if (profile) scheduleVectors(profile); }).catch(e => setError(memoryErrorMessage(e))).finally(() => setBusy(false)); }}><Text style={{ color: t.secondary }}>Отменить последнюю операцию</Text></Pressable> : null}
    {error ? <View style={{ paddingHorizontal: 18, gap: 8 }}><Text accessibilityRole="alert" style={{ color: t.err }}>{error}</Text><Pressable accessibilityRole="button" onPress={() => setRetry(n => n + 1)} style={button}><Text style={{ color: t.secondary }}>Повторить загрузку</Text></Pressable></View> : null}
    {loading ? <ActivityIndicator accessibilityLabel="Загрузка записей" /> : null}
</View>} data={loading ? [] : notes} keyExtractor={item => item.id} keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag"
      contentContainerStyle={{ paddingHorizontal: nebulaSpacing.md, paddingBottom: nebulaSpacing.xl, gap: nebulaSpacing.sm, flexGrow: 1 }}
      ListEmptyComponent={!loading && !error ? <View style={{ flex: 1, alignItems: "center", justifyContent: "center", padding: 24, gap: 12 }}><Feather name={term ? "search" : "book-open"} size={40} color={t.secondary} />
        <Text style={{ color: t.text, fontSize: 20, fontWeight: "700", textAlign: "center" }}>{term ? "Ничего не найдено" : status === "archived" ? "Архив пуст" : status === "trashed" ? "Корзина пуста" : "Начните с важного"}</Text>
        <Text style={{ color: t.muted, textAlign: "center", lineHeight: 21 }}>{term ? "Попробуйте другое слово или раздел «Все записи»." : status === "trashed" ? "Здесь будут удалённые заметки, пока вы их не восстановите." : status === "archived" ? "Здесь хранятся записи, которые вы отправили в архив. Их можно вернуть в обычную память." : "Создайте запись или добавьте сведения из файла."}</Text></View> : null}
      renderItem={({ item }) => <View style={{ flex: 1, maxWidth: columns === 2 ? "50%" : "100%" }}><MemoryNoteCard note={item} grid={columns === 2}
        cover={profile && memoryNoteHasPhoto(item)
          ? <MemoryCover profile={profile} entityId={item.id} active={visibleIds.has(item.id)} label={"Обложка " + item.title} /> : undefined}
        sectionName={collections.find(c => c.id === item.collection_id)?.name || "Запись"}
        selected={selectedIds.includes(item.id)} selecting={selecting}
        onToggleSelection={() => toggleSelection(item.id)}
        onOpen={() => selecting
          ? toggleSelection(item.id)
          : navigation.navigate("MemoryNote", { entityId: item.id })}
      /></View>}
      ListFooterComponent={more && !loading ? <Pressable accessibilityRole="button" accessibilityLabel="Показать ещё заметки" disabled={busy} onPress={() => void loadMore()} style={button}><Text style={{ color: t.secondary }}>{busy ? "Загружаю…" : "Показать ещё"}</Text></Pressable> : null} />
      <BottomSheet visible={actionsOpen && selectedIds.length > 0} title={selectedIds.length === 1 ? "Действия с записью" : `Действия · ${selectedIds.length}`} onClose={() => setActionsOpen(false)}>
      {error ? <Text accessibilityRole="alert" style={{ color: t.err }}>{error}</Text> : null}
      <Text numberOfLines={2} style={{ color: t.muted }}>{selectedNotes.map(memoryDisplayTitle).join(", ")}</Text>
      {selectedNotes.length === 1 ? <Pressable accessibilityRole="button" style={actionButton} onPress={() => { setActionsOpen(false); navigation.navigate("MemoryNote", { entityId: selectedNotes[0].id }); }}><Text style={{ color: t.text }}>Открыть запись</Text></Pressable> : null}
        {status === "trashed" ? <>
          <Pressable disabled={busy} accessibilityRole="button" style={actionButton} onPress={() => void act("restore")}><Text style={{ color: t.secondary }}>Восстановить</Text></Pressable>
          <Pressable disabled={busy} accessibilityRole="button" style={actionButton} onPress={() => Alert.alert("Удалить навсегда?", "Исчезнут выбранные записи, их оригиналы и история. Отменить это действие нельзя.\n" + selectedNotes.map(memoryDisplayTitle).join("\n"), [{ text: "Отмена", style: "cancel" }, { text: "Удалить навсегда", style: "destructive", onPress: () => { if (!repository.current) return; setBusy(true); void repository.current.purgeNotes(selectedNotes).then(() => { setSelectedIds([]); setSelecting(false); setActionsOpen(false); setUndo(""); setRetry(n => n + 1); }).catch(e => setError(memoryErrorMessage(e))).finally(() => setBusy(false)); } }])}><Text style={{ color: t.err }}>Удалить навсегда</Text></Pressable>
        </> : <>
          <Pressable disabled={busy} accessibilityRole="button" style={actionButton} onPress={() => { setActionsOpen(false); setMoveOpen(true); }}><Text style={{ color: t.secondary }}>Перенести</Text></Pressable>
          {selectedIds.length >= 2 && status === "active" ? <Pressable disabled={busy} accessibilityRole="button" style={actionButton} onPress={() => { setActionsOpen(false); setMergeOpen(true); }}><Text style={{ color: t.secondary }}>Объединить записи</Text></Pressable> : null}
          <Pressable disabled={busy} accessibilityRole="button" style={actionButton} onPress={() => Alert.alert("В корзину?", selectedNotes.map(memoryDisplayTitle).join("\n"), [{ text: "Отмена", style: "cancel" }, { text: "В корзину", onPress: () => void act("trash") }])}><Text style={{ color: t.err }}>В корзину</Text></Pressable>
        </>}
      </BottomSheet>

    <BottomSheet visible={addOpen} title="Добавить в память" onClose={() => setAddOpen(false)}>
      <Pressable accessibilityRole="button" accessibilityLabel="Новая заметка" style={{ ...button, alignItems: "flex-start" }} onPress={() => { setAddOpen(false); navigation.navigate("MemoryNote", { collectionId }); }}><Text style={{ color: t.text, fontSize: 16 }}>Текст или голос</Text><Text style={{ color: t.muted }}>Напишите или надиктуйте мысль</Text></Pressable>
      {(["photo", "file", "link"] as const).map((source, i) => <Pressable key={source} accessibilityRole="button" style={{ ...button, alignItems: "flex-start" }} accessibilityLabel={["Добавить фото", "Добавить файл", "Добавить ссылку"][i]}
        onPress={() => { setAddOpen(false); navigation.navigate("MemoryImport", { source, collectionId }); }}><Text style={{ color: t.text, fontSize: 16 }}>{["Фото · камера или галерея", "Файл · документы, аудио, видео", "Ссылка · статья или файл"][i]}</Text></Pressable>)}
    </BottomSheet>
    <BottomSheet visible={menuOpen} title="Память" onClose={() => setMenuOpen(false)}>
      <Text style={{ color: t.muted }}>Библиотека</Text>
      <Pressable accessibilityRole="button" accessibilityLabel="Добавить сведения из файла" style={{ ...button, alignItems: "flex-start" }} onPress={() => { setMenuOpen(false); setAddOpen(true); }}><Text style={{ color: t.text }}>Добавить в память</Text></Pressable>
      <Pressable accessibilityRole="button" accessibilityLabel="Все коллекции" style={{ ...button, alignItems: "flex-start" }} onPress={() => { setMenuOpen(false); setCollectionMenu(true); }}><Text style={{ color: t.text }}>Коллекции</Text></Pressable>
      <Text style={{ color: t.muted }}>Показать</Text>
      {(["active", "archived", "trashed"] as const).map((value, i) => <Pressable key={value} accessibilityRole="button" accessibilityState={{ selected: status === value }}
        accessibilityLabel={["Открыть текущие записи", "Открыть архив", "Открыть корзину"][i]} style={{ ...button, alignItems: "center", flexDirection: "row", justifyContent: "space-between" }}
        onPress={() => openStatus(value)}><Text style={{ color: t.text }}>{["Все записи", "Архив", "Корзина"][i]}</Text>{status === value ? <Feather name="check" size={20} color={t.secondary} /> : null}</Pressable>)}
      <Text style={{ color: t.muted }}>Данные</Text>
      <Pressable accessibilityRole="button" accessibilityLabel="Резервные копии" style={{ ...button, alignItems: "flex-start" }} onPress={() => { setMenuOpen(false); navigation.navigate("MemoryBackup"); }}><Text style={{ color: t.text }}>Резервные копии</Text></Pressable>
    </BottomSheet>
    <BottomSheet visible={collectionMenu} title="Коллекции" onClose={() => setCollectionMenu(false)}>
      {[{ id: undefined, name: "Все записи" }, ...collections].map(c => <Pressable key={c.id || "all"} accessibilityRole="button" accessibilityLabel={"Раздел " + c.name} style={{ ...button, alignItems: "flex-start" }}
        onPress={() => { openAll(); setCollectionId(c.id); setCollectionMenu(false); }}><Text style={{ color: t.text }}>{c.name}</Text></Pressable>)}
      <Pressable accessibilityRole="button" accessibilityLabel="Новый раздел памяти" style={button} onPress={() => { setCollectionMenu(false); setSectionOpen(true); }}><Text style={{ color: t.secondary }}>Создать коллекцию</Text></Pressable>
    </BottomSheet>
    <BottomSheet visible={moveOpen} title="Перенести выбранные записи" onClose={() => setMoveOpen(false)}>
      {error ? <Text accessibilityRole="alert" style={{ color: t.err }}>{error}</Text> : null}
      <Text style={{ color: t.muted }}>{selectedNotes.map(memoryDisplayTitle).join(", ")}</Text>
      {collections.map(c => <Pressable key={c.id} disabled={busy} style={button} onPress={() => void act("move", c.id)}><Text style={{ color: t.secondary }}>{c.name}</Text></Pressable>)}
    </BottomSheet>
    <BottomSheet visible={mergeOpen} title="Предпросмотр объединения" onClose={() => setMergeOpen(false)}>
      <Text style={{ color: t.muted }}>Название первой выбранной записи сохраняется. Тексты остаются отдельными блоками; вложения и источники сохраняются. Противоречия не исправляются автоматически.</Text>
      {error ? <Text accessibilityRole="alert" style={{ color: t.err }}>{error}</Text> : null}
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
