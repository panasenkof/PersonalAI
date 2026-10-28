import { useSafeAreaInsets } from "react-native-safe-area-context";
import Feather from "@expo/vector-icons/Feather";
import { useFocusEffect, useNavigation } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import * as Crypto from "expo-crypto";
import React, { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, BackHandler, FlatList, Pressable, ScrollView, Text, TextInput, View, useWindowDimensions } from "react-native";
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

import { mergeText, noteUndoLabel, type NoteAction } from "../local-memory/note-actions";
import { scheduleVectors } from "../media/vector-runner";
import type { MemoryReviewBatchPreview, MemoryReviewAction } from "../local-memory/hygiene";

export function LocalMemoryScreen() {
  const t = useTheme(); const navigation = useNavigation<NativeStackNavigationProp<RootStackParams>>();
  const profile = useProfile(); const insets = useSafeAreaInsets();
  const { width, fontScale } = useWindowDimensions();
  const [grid, setGrid] = useState(true);
  const columns = grid && width >= 350 && fontScale < 1.4 ? 2 : 1;
  const [addOpen, setAddOpen] = useState(false);
  const [selecting, setSelecting] = useState(false);
  const [actionsOpen, setActionsOpen] = useState(false);
  const [confirmation, setConfirmation] = useState<"trash" | "purge" | null>(null);
  const [contextNote, setContextNote] = useState<EntityRecord | null>(null);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [menuOpen, setMenuOpen] = useState(false);
  const [collectionMenu, setCollectionMenu] = useState(false);
  const [collectionCards, setCollectionCards] = useState<CollectionRecord[]>([]);
  const [visibleIds, setVisibleIds] = useState<Set<string>>(new Set());
  const onViewableItemsChanged = useRef(({ viewableItems }: { viewableItems: { item: EntityRecord }[] }) => setVisibleIds(new Set(viewableItems.map(x => x.item.id)))).current;
  const viewabilityConfig = useRef({ itemVisiblePercentThreshold: 10 }).current;
  const [collections, setCollections] = useState<CollectionRecord[]>([]);
  const [collectionId, setCollectionId] = useState<string | undefined>();
  const [status, setStatus] = useState<"active" | "archived" | "trashed">("active");
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [moveOpen, setMoveOpen] = useState(false);
  const [mergeOpen, setMergeOpen] = useState(false);
  const [hygieneReviewOpen, setHygieneReviewOpen] = useState(false);
  const [hygieneExcluded, setHygieneExcluded] = useState<string[]>([]);
  const [hygienePreview, setHygienePreview] = useState<MemoryReviewBatchPreview | null>(null);
  const [hygieneAction, setHygieneAction] = useState<MemoryReviewAction>("archive");
  const [hygieneConfirm, setHygieneConfirm] = useState(false);
  const hygieneGeneration = useRef(0);
  const [undo, setUndo] = useState("");
  const [search, setSearch] = useState(""); const [term, setTerm] = useState("");
  const [notes, setNotes] = useState<EntityRecord[]>([]); const [more, setMore] = useState(false);
  const selectedNotes = contextNote ? [contextNote] : selectedIds.map(id => notes.find(n => n.id === id)).filter((note): note is EntityRecord => Boolean(note));
  const [loading, setLoading] = useState(true); const [busy, setBusy] = useState(false);
  const [error, setError] = useState(""); const [retry, setRetry] = useState(0);
  const [sectionOpen, setSectionOpen] = useState(false); const [sectionName, setSectionName] = useState("");
  const repository = useRef<SqliteMemoryRepository | null>(null); const generation = useRef(0);
  useEffect(() => { const timer = setTimeout(() => setTerm(search.trim()), 250); return () => clearTimeout(timer); }, [search]);
  useEffect(() => { setCollectionId(undefined); setSearch(""); setStatus("active"); setCollections([]); setNotes([]); setCollectionCards([]); setSelectedIds([]); setSelecting(false); setCounts({}); setVisibleIds(new Set()); }, [profile]);
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

    }).catch(e => { if (request === generation.current) { repository.current = null; setError(memoryErrorMessage(e)); } })
      .finally(() => { if (request === generation.current) setLoading(false); });
    return () => { generation.current++; repository.current = null; };
  }, [profile, term, collectionId, status, retry]));
  /** Read-only review of current selected versions. There is no new action
   * writer; normal note actions still require their own confirmation.
   */
  async function inspectHygiene(excluded: string[], action:MemoryReviewAction=hygieneAction) {
    if (!repository.current || busy) return;
    const token = ++hygieneGeneration.current, request = generation.current;
    setBusy(true); setError(""); setHygienePreview(null); setHygieneConfirm(false);
    try {
      const data = await repository.current.hygiene().previewWithExclusions(
        selectedNotes.map(note=>({id:note.id,recordVersion:note.record_version})),excluded,action);
      if(token===hygieneGeneration.current && request===generation.current)
        setHygienePreview(data);
    } catch(e) {
      if(token===hygieneGeneration.current && request===generation.current)
        setError(memoryErrorMessage(e));
    } finally {
      if(token===hygieneGeneration.current && request===generation.current) setBusy(false);
    }
  }
  function closeHygiene(){
    hygieneGeneration.current++;
    setHygieneReviewOpen(false);setHygieneExcluded([]);setHygienePreview(null);setHygieneConfirm(false);setBusy(false);
  }
  /** Reuse changeNotes+undoNotes. No additional cleanup writer, no purge. */
  async function applyHygiene(){
    if(!repository.current||busy||!hygieneConfirm||!hygienePreview||
       hygienePreview.action!==hygieneAction||!hygienePreview.eligibleIds.length)return;
    const preview=hygienePreview, request=generation.current, token=++hygieneGeneration.current;
    const included=preview.included.filter(x=>x.eligible);
    // The selection must still match the preview. The DB transaction checks
    // every record version, status, policy CAS and privacy before any write.
    if(preview.selectedCount!==selectedNotes.length ||
       included.some(x=>!selectedNotes.some(n=>n.id===x.id&&n.record_version===x.expectedRecordVersion))){
      setError("Список изменился. Повторите проверку.");setHygieneConfirm(false);return;
    }
    setBusy(true);setError("");
    try{
      const operation=await repository.current.changeNotes(hygieneAction,
        included.map(x=>({id:x.id,record_version:x.expectedRecordVersion})),undefined,
        {expectedPreferences:included.map(x=>({id:x.id,preferenceVersion:x.expectedPreferenceVersion}))});
      if(token===hygieneGeneration.current&&request===generation.current){
        setUndo(operation);setHygieneReviewOpen(false);setHygieneExcluded([]);
        setHygienePreview(null);setHygieneConfirm(false);
        setSelectedIds([]);setSelecting(false);setRetry(n=>n+1);
        if(profile)scheduleVectors(profile);
      }
    }catch(e){
      if(token===hygieneGeneration.current&&request===generation.current){
        setError(memoryErrorMessage(e));setHygieneConfirm(false);setHygienePreview(null);
      }
    }finally{if(token===hygieneGeneration.current)setBusy(false);}
  }
  async function act(action: NoteAction, target?: string) {
    if (!repository.current || busy) return;
    setBusy(true); setError("");
    try {
      const token = await repository.current.changeNotes(action, selectedNotes, target);
      setUndo(token); setSelectedIds([]); setSelecting(false); setActionsOpen(false); setConfirmation(null); setContextNote(null); setMoveOpen(false); setMergeOpen(false); setRetry(n => n + 1);
      if (profile) scheduleVectors(profile);
    } catch (e) { setError(memoryErrorMessage(e)); } finally { setBusy(false); }
  }
  useEffect(() => { setSelectedIds([]); setSelecting(false); setActionsOpen(false); setConfirmation(null); setNotes([]); setContextNote(null); setMoveOpen(false); setMergeOpen(false); hygieneGeneration.current++; setHygieneReviewOpen(false); setHygieneExcluded([]); setHygienePreview(null); setHygieneConfirm(false); setHygieneAction("archive"); }, [profile, collectionId, term, status]);
  function openAll() { setStatus("active"); setCollectionId(undefined); setSearch(""); setTerm(""); setSelectedIds([]); setSelecting(false); }
  function openStatus(value: typeof status) { openAll(); setStatus(value); setMenuOpen(false); }
  const cancelSelection = useCallback(() => {
    setSelectedIds([]); setSelecting(false); setActionsOpen(false); setConfirmation(null); setContextNote(null);
  }, []);
  useFocusEffect(useCallback(() => {
    const sub = BackHandler.addEventListener("hardwareBackPress", () => {
      if (actionsOpen || moveOpen || mergeOpen || hygieneReviewOpen) return false;
      if (!selecting) return false;
      if (!busy) cancelSelection();
      return true;
    });
    return () => sub.remove();
  }, [selecting, busy, actionsOpen, moveOpen, mergeOpen, hygieneReviewOpen, cancelSelection]));
  function toggleSelection(id: string) {
    if (busy || loading) return;
    if (!selectedIds.includes(id) && selectedIds.length >= 100) { setError("За один раз можно выбрать до 100 записей."); return; }
    const next = selectedIds.includes(id) ? selectedIds.filter(value => value !== id) : [...selectedIds, id];
    setContextNote(null); setSelectedIds(next); setSelecting(next.length > 0);
  }
  async function purgeSelected() {
    if (!repository.current || busy) return;
    setBusy(true); setError("");
    try {
      await repository.current.purgeNotes(selectedNotes);
      cancelSelection(); setConfirmation(null); setUndo(""); setRetry(n => n + 1);
    } catch (e) { setError(memoryErrorMessage(e)); } finally { setBusy(false); }
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
    {selecting ? <View testID="memory-selection-toolbar" style={{ paddingHorizontal: 16, backgroundColor: t.panel, borderBottomWidth: 1, borderBottomColor: t.line, flexDirection: "row", alignItems: "center", flexWrap: "wrap", minHeight: 56, gap: 4 }}>
      <Pressable disabled={busy} accessibilityRole="button" accessibilityLabel="Отменить выбор записей" onPress={cancelSelection} style={{ ...button, paddingHorizontal: 12 }}><Text style={{ color: t.secondary }}>Отмена</Text></Pressable>
      <Text accessibilityLiveRegion="polite" style={{ flex: 1, color: t.text }}>Выбрано: {selectedIds.length}</Text>
      <Pressable accessibilityRole="button" accessibilityLabel="Действия с выбранными записями" accessibilityState={{ disabled: busy || !selectedIds.length }} disabled={busy || !selectedIds.length} onPress={() => setActionsOpen(true)} style={{ ...button, opacity: selectedIds.length ? 1 : .45 }}><Text style={{ color: t.secondary }}>Действия</Text></Pressable>
    </View> : <View testID="memory-normal-toolbar" style={{ paddingHorizontal: 16, minHeight: 56, flexDirection: "row", alignItems: "center", gap: nebulaSpacing.xs }}>
          <Text accessibilityRole="header" style={{ flex: 1, color: t.text, fontSize: 28, fontWeight: "800" }}>Память</Text>
          <Pressable accessibilityRole="button" accessibilityLabel="Добавить в память" onPress={() => setAddOpen(true)}
            style={{ ...button, paddingHorizontal: 12, backgroundColor: t.accent }}><Feather name="plus" size={24} color={t.userText} /></Pressable>
          <Pressable accessibilityRole="button" accessibilityLabel="Меню памяти" onPress={() => setMenuOpen(true)} style={{ ...button, paddingHorizontal: 12 }}><Feather name="more-vertical" size={24} color={t.text} /></Pressable>
        </View>}
    <FlatList
      testID="memory-note-list" key={columns} numColumns={columns}
      onViewableItemsChanged={onViewableItemsChanged} viewabilityConfig={viewabilityConfig}
      initialNumToRender={8} windowSize={5} columnWrapperStyle={columns > 1 ? { gap: nebulaSpacing.sm, alignItems: "flex-start" } : undefined}
      ListHeaderComponent={<View style={{ paddingTop: nebulaSpacing.sm, paddingBottom: nebulaSpacing.sm, gap: nebulaSpacing.sm }}>
        <View style={{ flexDirection: "row", alignItems: "center", borderWidth: 1, borderColor: t.line, borderRadius: nebulaRadii.field, backgroundColor: t.panel }}>
          <Feather name="search" size={19} color={t.muted} style={{ marginLeft: nebulaSpacing.sm }} />
          <TextInput testID="memory-search" accessibilityLabel="Поиск по заметкам"
            value={search} editable={!selecting && !loading} onChangeText={setSearch} placeholder="Поиск по памяти"
            placeholderTextColor={t.muted} returnKeyType="search"
            style={{ flex: 1, minWidth: 0, minHeight: nebulaTouch.minimum, fontSize: 16, color: t.text, paddingHorizontal: nebulaSpacing.sm }} />
          {search ? <Pressable accessibilityRole="button" disabled={selecting} accessibilityLabel="Очистить поиск по памяти"
            onPress={() => setSearch("")} style={{ minWidth: nebulaTouch.minimum, minHeight: nebulaTouch.minimum, justifyContent: "center", alignItems: "center" }}>
            <Feather name="x" size={20} color={t.muted} />
          </Pressable> : null}
        </View>
        {!term && status === "active" && !collectionId ? <>
          <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
            <Text style={{ color: t.text, fontSize: 18, fontWeight: "700" }}>Коллекции</Text>
            <Pressable accessibilityRole="button" accessibilityLabel="Все коллекции" disabled={selecting} accessibilityState={{ disabled: selecting }} onPress={() => setCollectionMenu(true)} style={button}><Text style={{ color: t.secondary }}>Все</Text></Pressable>
          </View>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: nebulaSpacing.sm }}>
            {collectionCards.map(c => <Pressable key={c.id} accessibilityRole="button" accessibilityLabel={"Раздел " + c.name}
              disabled={selecting} accessibilityState={{ disabled: selecting }} onPress={() => setCollectionId(c.id)} style={{ width: Math.min(width - 48, 180 * Math.min(fontScale, 1.5)), borderRadius: nebulaRadii.field, overflow: "hidden", backgroundColor: t.panel, borderWidth: 1, borderColor: t.line }}>
              <View style={{ height: 80, backgroundColor: t.soft, justifyContent: "center", alignItems: "center" }}><Feather name={c.slug === "people" ? "users" : c.slug === "preferences" ? "heart" : c.slug === "events" ? "calendar" : "folder"} size={24} color={t.secondary} /></View>
              <Text numberOfLines={2} style={{ color: t.text, fontWeight: "600", fontSize: 15, padding: nebulaSpacing.sm }}>{c.name}</Text>
              <Text style={{ color: t.muted, fontSize: 13, paddingHorizontal: nebulaSpacing.sm, paddingBottom: nebulaSpacing.sm }}>Записей: {counts[c.id] ?? 0}</Text>
            </Pressable>)}
          </ScrollView>
        </> : null}
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
          {collectionId || status !== "active" || term ? <Pressable accessibilityRole="button" disabled={selecting} accessibilityLabel="Ко всем записям" onPress={openAll} style={{ ...button, paddingHorizontal: 8 }}><Feather name="arrow-left" size={20} color={t.secondary} /></Pressable> : null}
          <Text style={{ flex: 1, color: t.text, fontSize: 18, fontWeight: "700" }}>{term ? "Результаты поиска" : status === "archived" ? "Архив" : status === "trashed" ? "Корзина" : collectionId ? collections.find(c => c.id === collectionId)?.name : "Недавнее"}</Text>
          <Pressable accessibilityRole="button" accessibilityLabel={grid ? "Показать списком" : "Показать плитками"} disabled={selecting} onPress={() => setGrid(v => !v)} style={{ ...button, paddingHorizontal: 12 }}>
            <Feather name={grid ? "list" : "grid"} size={20} color={t.secondary} />
          </Pressable>
        </View>
        {collectionId && status === "active" && !term && !selecting &&
            collections.some(c => c.id === collectionId && c.sensitivity === "standard") ?
          <Pressable accessibilityRole="button" accessibilityLabel="Открыть предложения по изменению памяти"
            style={{ ...button, alignItems: "flex-start", borderWidth: 1, borderColor: t.line, backgroundColor: t.panel }}
            onPress={() => navigation.navigate("MemoryTemporalReview", { collectionId })}>
            <Text style={{ color: t.secondary, fontWeight: "700" }}>На проверке · возможные изменения</Text>
            <Text style={{ color: t.muted, fontSize: 13 }}>Сравнить источники и решить, что делать с прежними фактами</Text>
          </Pressable> : null}
        {notes.length ? <Pressable disabled={selecting || loading} accessibilityElementsHidden={selecting} importantForAccessibility={selecting ? "no-hide-descendants" : "auto"} accessibilityRole="button" accessibilityLabel="Выбрать записи" onPress={() => { setContextNote(null); setSelecting(true); }} style={{ ...button, opacity: selecting ? 0 : 1, alignItems: "flex-start" }}><Text style={{ color: t.secondary }}>Выбрать записи</Text></Pressable> : null}
        {status === "trashed" ? <Text style={{ color: t.muted, fontSize: 13, lineHeight: 19 }}>
          Удалённые записи исключены из поиска агента. Их можно восстановить или удалить окончательно.
        </Text> : null}
      {undo ? <Pressable disabled={busy || selecting} style={button} onPress={() => { if (!repository.current) return; setBusy(true); void repository.current.undoNotes(undo).then(() => { setUndo(""); setRetry(n => n + 1); if (profile) scheduleVectors(profile); }).catch(e => setError(memoryErrorMessage(e))).finally(() => setBusy(false)); }}><Text style={{ color: t.secondary }}>{noteUndoLabel(undo)}</Text></Pressable> : null}
    {error ? <View style={{ paddingHorizontal: 18, gap: 8 }}><Text accessibilityRole="alert" style={{ color: t.err }}>{error}</Text><Pressable accessibilityRole="button" onPress={() => setRetry(n => n + 1)} style={button}><Text style={{ color: t.secondary }}>Повторить загрузку</Text></Pressable></View> : null}
    {loading ? <ActivityIndicator accessibilityLabel="Загрузка записей" /> : null}
</View>} data={notes} keyExtractor={item => item.id} keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag"
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
        onActions={() => { if (!busy && !loading) { setConfirmation(null); setContextNote(item); setActionsOpen(true); } }}
        onOpen={() => selecting
          ? toggleSelection(item.id)
          : navigation.navigate("MemoryNote", { entityId: item.id })}
      /></View>}
      ListFooterComponent={more && !loading ? <Pressable accessibilityRole="button" accessibilityLabel="Показать ещё заметки" disabled={busy} onPress={() => void loadMore()} style={button}><Text style={{ color: t.secondary }}>{busy ? "Загружаю…" : "Показать ещё"}</Text></Pressable> : null} />
      <BottomSheet visible={actionsOpen && selectedNotes.length > 0} title={confirmation ? (confirmation === "trash" ? "В корзину?" : "Удалить навсегда?") : selectedNotes.length === 1 ? "Действия с записью" : `Действия · ${selectedNotes.length}`} onClose={() => { if (busy) return; if (confirmation) setConfirmation(null); else { setActionsOpen(false); setContextNote(null); } }}>
      {error ? <Text accessibilityRole="alert" style={{ color: t.err }}>{error}</Text> : null}
      <Text numberOfLines={2} style={{ color: t.muted }}>{selectedNotes.map(memoryDisplayTitle).join(", ")}</Text>
      {confirmation ? <>
        <Text style={{ color: t.text }}>{confirmation === "trash" ? `Записей: ${selectedNotes.length}. Их можно будет восстановить из корзины.` : `Записей: ${selectedNotes.length}. Записи, оригиналы и история будут удалены без возможности восстановления.`}</Text>
        <Pressable disabled={busy} accessibilityRole="button" style={actionButton} onPress={() => setConfirmation(null)}><Text style={{ color: t.secondary }}>Отмена</Text></Pressable>
        <Pressable disabled={busy} accessibilityRole="button" accessibilityLabel={confirmation === "trash" ? "Подтвердить перемещение в корзину" : "Подтвердить удаление навсегда"} style={actionButton} onPress={() => confirmation === "trash" ? void act("trash") : void purgeSelected()}><Text style={{ color: t.err }}>{busy ? "Выполняю…" : confirmation === "trash" ? "В корзину" : "Удалить навсегда"}</Text></Pressable>
      </> : <>
      {selectedNotes.length === 1 ? <Pressable accessibilityRole="button" style={actionButton} onPress={() => { setActionsOpen(false); setConfirmation(null); setContextNote(null); navigation.navigate("MemoryNote", { entityId: selectedNotes[0].id }); }}><Text style={{ color: t.text }}>{status === "trashed" ? "Открыть запись" : "Редактировать"}</Text></Pressable> : null}
        {status === "trashed" ? <>
          <Pressable disabled={busy} accessibilityRole="button" style={actionButton} onPress={() => void act("restore")}><Text style={{ color: t.secondary }}>Восстановить</Text></Pressable>
          <Pressable disabled={busy} accessibilityRole="button" style={actionButton} onPress={() => setConfirmation("purge")}><Text style={{ color: t.err }}>Удалить навсегда</Text></Pressable>
        </> : <>
          <Pressable disabled={busy} accessibilityRole="button" style={actionButton} onPress={() => void act(status === "archived" ? "unarchive" : "archive")}><Text style={{ color: t.secondary }}>{status === "archived" ? "Вернуть из архива" : "В архив"}</Text></Pressable>
          <Pressable disabled={busy} accessibilityRole="button" style={actionButton} onPress={() => { setActionsOpen(false); setMoveOpen(true); }}><Text style={{ color: t.secondary }}>Перенести</Text></Pressable>
          {selectedNotes.length >= 2 && status === "active" ? <Pressable disabled={busy} accessibilityRole="button" style={actionButton} onPress={() => { setActionsOpen(false); setMergeOpen(true); }}><Text style={{ color: t.secondary }}>Объединить записи</Text></Pressable> : null}
          {selectedNotes.length >= 2 && status === "active" ? <Pressable
            disabled={busy} accessibilityRole="button" accessibilityLabel="Проверить последствия групповой ревизии"
            style={actionButton} onPress={() => {
              setActionsOpen(false);setHygieneExcluded([]);setHygienePreview(null);setHygieneAction("archive");setHygieneConfirm(false);
              setHygieneReviewOpen(true);void inspectHygiene([]);
            }}>
            <Text style={{ color:t.secondary }}>Проверить группу и исключения</Text>
          </Pressable> : null}
          <Pressable disabled={busy} accessibilityRole="button" style={actionButton} onPress={() => setConfirmation("trash")}><Text style={{ color: t.err }}>В корзину</Text></Pressable>
        </>}
      {contextNote ? <Pressable disabled={busy} accessibilityRole="button" style={actionButton} onPress={() => { setSelectedIds([contextNote.id]); setSelecting(true); setContextNote(null); setActionsOpen(false); }}><Text style={{ color: t.secondary }}>Выбрать несколько</Text></Pressable> : null}
      </>}
      </BottomSheet>

    <BottomSheet visible={hygieneReviewOpen && selectedNotes.length>=2}
      title="Предпросмотр групповой ревизии" onClose={closeHygiene}>
      <Text style={{color:t.text}}>
        Сначала проверьте последствия, затем подтвердите действие. Можно исключить любую запись.
        Закреплённые, отложенные и закрытые материалы не меняются.
      </Text>
      <View style={{flexDirection:"row",flexWrap:"wrap",gap:8}}>
        {(["archive","trash"] as const).map(value=><Pressable key={value}
          accessibilityRole="button" accessibilityLabel={value==="archive"?"Ревизия: в архив":"Ревизия: в корзину"}
          accessibilityState={{selected:hygieneAction===value,disabled:busy}} disabled={busy}
          style={{...actionButton,flexGrow:1,backgroundColor:hygieneAction===value?t.soft:t.panel}}
          onPress={()=>{setHygieneAction(value);setHygieneConfirm(false);void inspectHygiene(hygieneExcluded,value);}}>
          <Text style={{color:t.text}}>{value==="archive"?"В архив":"В корзину"}</Text>
        </Pressable>)}
      </View>
      {busy?<ActivityIndicator accessibilityLabel="Проверяю последствия для памяти" color={t.secondary}/>:null}
      <Text accessibilityLiveRegion="polite" style={{color:t.muted}}>
        {hygienePreview?
          "Выбрано: "+hygienePreview.selectedCount+
          " · Исключено: "+hygienePreview.excludedIds.length+
          " · Можно "+(hygieneAction==="archive"?"архивировать":"переместить в корзину")+": "+hygienePreview.eligibleIds.length+
          " · Требуют проверки: "+hygienePreview.blockedIds.length:"Проверка выбранных записей"}
      </Text>
      <Text style={{color:t.muted,fontSize:13}}>
        Размер затрагиваемых оригиналов: {hygienePreview?
          hygienePreview.originalBytesAtRisk+" байт":"—"}.
        Это не обещание освобождения места.
      </Text>
      {selectedNotes.map(note=>{
        const excluded=hygieneExcluded.includes(note.id);
        const row=hygienePreview?.included.find(item=>item.id===note.id);
        return <Pressable key={note.id} accessibilityRole="checkbox"
          accessibilityLabel={"Исключить из ревизии "+memoryDisplayTitle(note)}
          accessibilityState={{checked:excluded,disabled:busy}} disabled={busy}
          style={{...actionButton,minHeight:nebulaTouch.minimum}}
          onPress={()=>{
            const next=excluded?hygieneExcluded.filter(id=>id!==note.id):[...hygieneExcluded,note.id];
            setHygieneExcluded(next);void inspectHygiene(next);
          }}>
          <Text style={{color:t.text}}>
            {excluded?"Исключено · ":"В группе · "}{memoryDisplayTitle(note)}
          </Text>
          <Text style={{color:t.muted,fontSize:13}}>
            {excluded?"Не затрагивается":
             row?.eligible?"Допустимо для предложения":
             row?("Нельзя без проверки: "+row.reasons.join(", ")):"Проверка…"}
          </Text>
        </Pressable>;
      })}
      {error?<Text accessibilityRole="alert" style={{color:t.err}}>{error}</Text>:null}
      <Text style={{color:t.muted}}>
        Архив и корзина не удаляют оригиналы навсегда; обратимое действие можно отменить.
        Ранее экспортированные резервные копии не изменятся. Заблокированные элементы не затрагиваются.
      </Text>
      {hygienePreview && hygienePreview.eligibleIds.length > 0 && !busy ?
        (hygieneConfirm ? <>
          <Text accessibilityRole="alert" style={{color:t.text}}>
            Подтвердите {hygieneAction==="archive"?"архивирование":"перемещение в корзину"}:
            {hygienePreview.eligibleIds.length} записей. Исключённые и заблокированные останутся без изменений.
          </Text>
          <Pressable accessibilityRole="button" accessibilityLabel="Подтвердить групповое действие памяти"
            style={actionButton} onPress={()=>void applyHygiene()}>
            <Text style={{color:hygieneAction==="trash"?t.err:t.secondary}}>
              {hygieneAction==="archive"?"Подтвердить архивирование":"Подтвердить перемещение в корзину"}
            </Text>
          </Pressable>
          <Pressable accessibilityRole="button" accessibilityLabel="Отмена подтверждения группового действия"
            style={actionButton} onPress={()=>setHygieneConfirm(false)}><Text style={{color:t.secondary}}>Назад к проверке</Text></Pressable>
        </> : <Pressable accessibilityRole="button"
          accessibilityLabel={hygieneAction==="archive"?"Продолжить архивирование группы":"Продолжить перемещение группы в корзину"}
          style={actionButton} onPress={()=>setHygieneConfirm(true)}>
          <Text style={{color:hygieneAction==="trash"?t.err:t.secondary}}>
            {hygieneAction==="archive"?"Архивировать":"В корзину"} · {hygienePreview.eligibleIds.length}
          </Text>
        </Pressable>) : null}
      <Pressable accessibilityRole="button" accessibilityLabel="Закрыть предпросмотр без изменений"
        style={button} onPress={closeHygiene}>
        <Text style={{color:t.secondary}}>Закрыть без изменений</Text>
      </Pressable>
    </BottomSheet>

    <BottomSheet visible={addOpen} title="Добавить в память" onClose={() => setAddOpen(false)}>
      <Pressable accessibilityRole="button" accessibilityLabel="Новая заметка" style={{ ...button, alignItems: "flex-start" }} onPress={() => { setAddOpen(false); navigation.navigate("MemoryNote", { collectionId }); }}><Text style={{ color: t.text, fontSize: 16 }}>Текст или голос</Text><Text style={{ color: t.muted }}>Напишите или надиктуйте мысль</Text></Pressable>
      {(["photo", "file", "link"] as const).map((source, i) => <Pressable key={source} accessibilityRole="button" style={{ ...button, alignItems: "flex-start" }} accessibilityLabel={["Добавить фото", "Добавить файл", "Добавить ссылку"][i]}
        onPress={() => { setAddOpen(false); navigation.navigate("MemoryImport", { source, collectionId }); }}><Text style={{ color: t.text, fontSize: 16 }}>{["Фото · камера или галерея", "Файл · документы, аудио, видео", "Ссылка · статья или файл"][i]}</Text></Pressable>)}
    </BottomSheet>
    <BottomSheet visible={menuOpen} title="Память" onClose={() => setMenuOpen(false)}>
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
    <BottomSheet visible={moveOpen} title="Перенести выбранные записи" onClose={() => { setMoveOpen(false); setContextNote(null); }}>
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
