import { useSafeAreaInsets } from "react-native-safe-area-context";
import Feather from "@expo/vector-icons/Feather";
import { useFocusEffect, useNavigation } from "@react-navigation/native";
import type { NativeStackNavigationProp } from "@react-navigation/native-stack";
import * as Crypto from "expo-crypto";
import React, { useCallback, useEffect, useRef, useState } from "react";
import { ActivityIndicator, BackHandler, FlatList, Pressable, ScrollView, Text, TextInput, View, useWindowDimensions } from "react-native";
import { memoryScrollReloadCount, memoryScrollRowIndex, memoryScrollScope, type MemoryScrollAnchor } from "../design/nebula/memoryScrollAnchor";
import { useProfile } from "../profile/ProfileContext";
import { BottomSheet } from "../components/BottomSheet";
import { localMemoryRepository } from "../local-memory/repository";
import { purgeConfirmedTrash, trashPurgeCountLabel, type TrashPurgeSnapshot } from "../local-memory/trash-clear";
import type { SqliteMemoryRepository } from "../local-memory/repository";
import type { CollectionRecord, EntityRecord } from "../local-memory/types";
import { memoryErrorMessage } from "../local-memory/errors";
import { ensureSections, orderCollections } from "../local-memory/sections";
import type { RootStackParams } from "../navigation";
import { useTheme } from "../theme";
import { nebulaSpacing, nebulaRadii, nebulaTouch } from "../design/nebula/tokens";
import { MemoryCover } from "../media/MemoryCover";
import { memoryDisplayTitle, memoryNoteHasPhoto } from "../design/nebula/memoryNotePresentation";
import { MemoryNoteCard, MEMORY_GRID_MEDIA_HEIGHT } from "../design/nebula/MemoryNoteCard";
import { NebulaAction } from "../design/nebula/components";
import { loadMemoryLibraryView, saveMemoryLibraryView } from "../design/nebula/memoryViewPreference";

import { mergeText, noteUndoLabel, type NoteAction } from "../local-memory/note-actions";
import { scheduleVectors } from "../media/vector-runner";
import type { MemoryReviewBatchPreview, MemoryReviewAction, MemoryReviewGuard, MemoryHygieneSuggestions, MemoryHygieneSuggestedGroup } from "../local-memory/hygiene";
import { localMemorySessionUnlocked, onLocalMemorySessionChange } from "../local-memory/storage";

export function LocalMemoryScreen() {
  const t = useTheme(); const navigation = useNavigation<NativeStackNavigationProp<RootStackParams>>();
  const profile = useProfile(); const insets = useSafeAreaInsets();
  const { width, fontScale } = useWindowDimensions();
  const [grid, setGrid] = useState(true);
  const viewChanged = useRef(false);
  const viewSaveQueue = useRef<Promise<void>>(Promise.resolve());
  const viewProfile = useRef(profile); viewProfile.current = profile;
  const [addOpen, setAddOpen] = useState(false);
  const [selecting, setSelecting] = useState(false);
  const [actionsOpen, setActionsOpen] = useState(false);
  const [confirmation, setConfirmation] = useState<"trash" | "purge" | null>(null);
  const [contextNote, setContextNote] = useState<EntityRecord | null>(null);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [trashCount, setTrashCount] = useState(0);
  const [trashPreview, setTrashPreview] = useState<TrashPurgeSnapshot | null>(null);
  const [trashConfirm, setTrashConfirm] = useState(false);
  const [trashProgress, setTrashProgress] = useState(0);
  const [trashMessage, setTrashMessage] = useState("");
  // A session/profile/list change invalidates the approval before any next batch.
  const trashEpoch = useRef(0);
  const trashRunning = useRef(false);
  const purgeHasCompleted = useRef(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [collectionMenu, setCollectionMenu] = useState(false);
  const [collectionCards, setCollectionCards] = useState<CollectionRecord[]>([]);
  const [visibleIds, setVisibleIds] = useState<Set<string>>(new Set());
  const viewabilityConfig = useRef({ itemVisiblePercentThreshold: 10 }).current;
  const listRef = useRef<FlatList<EntityRecord>>(null);
  // Only transient navigation state, keyed by profile/collection/status/search.
  const listAnchors = useRef(new Map<string, MemoryScrollAnchor>());
  const pendingAnchor = useRef<(MemoryScrollAnchor & { attempts: number }) | null>(null);
  const restoreTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const loadedCount = useRef(0);
  const scrollY = useRef(0);
  const [collections, setCollections] = useState<CollectionRecord[]>([]);
  const [collectionId, setCollectionId] = useState<string | undefined>();
  const [status, setStatus] = useState<"active" | "archived" | "trashed">("active");
  // Archive and trash use full-width rows without changing the user's grid preference.
  const columns = status !== "active" ? 1 : grid && width >= 350 && fontScale < 1.4 ? 2 : 1;
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [moveOpen, setMoveOpen] = useState(false);
  const [mergeOpen, setMergeOpen] = useState(false);
  const [hygieneReviewOpen, setHygieneReviewOpen] = useState(false);
  const [hygieneSuggestionsOpen, setHygieneSuggestionsOpen] = useState(false);
  const [hygieneSuggestions, setHygieneSuggestions] = useState<MemoryHygieneSuggestions | null>(null);
  const [suggestedReviewNotes, setSuggestedReviewNotes] = useState<EntityRecord[] | null>(null);
  const [hygieneExcluded, setHygieneExcluded] = useState<string[]>([]);
  const [hygienePreview, setHygienePreview] = useState<MemoryReviewBatchPreview | null>(null);
  const [hygieneAction, setHygieneAction] = useState<MemoryReviewAction>("archive");
  const [hygieneConfirm, setHygieneConfirm] = useState(false);
  const [hygienePolicyItem, setHygienePolicyItem] = useState<string | null>(null);
  const hygieneGeneration = useRef(0);
  const [undo, setUndo] = useState("");
  const [search, setSearch] = useState(""); const [term, setTerm] = useState("");
  // Async deletion checks the CURRENT UI scope, never a stale closure captured
  // when the user first tapped the confirmation button.
  const trashScope = useRef({ status, search, term, selecting, collectionId });
  trashScope.current = { status, search, term, selecting, collectionId };
  const [notes, setNotes] = useState<EntityRecord[]>([]); const [more, setMore] = useState(false);
  const selectedNotes = contextNote ? [contextNote] : selectedIds.map(id => notes.find(n => n.id === id)).filter((note): note is EntityRecord => Boolean(note));
  const reviewNotes = suggestedReviewNotes ?? selectedNotes;
  const [loading, setLoading] = useState(true); const [busy, setBusy] = useState(false);
  const [error, setError] = useState(""); const [retry, setRetry] = useState(0);
  const [sectionOpen, setSectionOpen] = useState(false); const [sectionName, setSectionName] = useState("");
  const repository = useRef<SqliteMemoryRepository | null>(null); const generation = useRef(0);
  const scope = memoryScrollScope(profile, collectionId, status, term);
  const scopeRef = useRef(scope);
  scopeRef.current = scope;
  loadedCount.current = notes.length;
  const onViewableItemsChanged = useRef(({ viewableItems }: {
    viewableItems: { item: EntityRecord; index: number | null }[];
  }) => {
    setVisibleIds(new Set(viewableItems.map(x => x.item.id)));
    if (!localMemorySessionUnlocked()) return;
    const currentScope = scopeRef.current;
    const pending = pendingAnchor.current;
    if (pending?.scope === currentScope) {
      if (viewableItems.some(x => x.item.id === pending.id)) pendingAnchor.current = null;
      return;
    }
    if (scrollY.current < 20) {
      listAnchors.current.delete(currentScope);
      return;
    }
    const first = viewableItems.find(x => x.index !== null);
    if (first?.index != null) {
      listAnchors.current.set(currentScope, {
        scope: currentScope, id: first.item.id, index: first.index, loaded: loadedCount.current,
      });
    }
  }).current;
  function restoreListAnchor() {
    const pending = pendingAnchor.current;
    if (!pending || pending.scope !== scope || loading || !notes.length || pending.attempts >= 4) return;
    // A multi-column FlatList scrolls by ROW, while viewability indexes individual notes.
    const index = memoryScrollRowIndex(notes, pending, scope, columns);
    if (index === null) { pendingAnchor.current = null; return; }
    pending.attempts += 1;
    listRef.current?.scrollToIndex({ index, viewPosition: 0, animated: false });
  }
  useEffect(() => {
    const anchor = listAnchors.current.get(scope);
    pendingAnchor.current = anchor ? { ...anchor, attempts: 0 } : null;
    scrollY.current = 0;
    return () => { if (restoreTimer.current) clearTimeout(restoreTimer.current); restoreTimer.current = null; };
  }, [scope]);
  useEffect(() => {
    if (pendingAnchor.current && !loading && notes.length) {
      const timer = setTimeout(restoreListAnchor, 0);
      return () => clearTimeout(timer);
    }
  }, [scope, columns, loading, notes]);
  useEffect(() => { const timer = setTimeout(() => setTerm(search.trim()), 250); return () => clearTimeout(timer); }, [search]);
  useEffect(() => {
    // Invalidate a reviewed destructive action immediately when the user
    // starts searching/selecting, not 250 ms later when term is debounced.
    if (search || selecting) {
      trashEpoch.current++;
      setTrashPreview(null); setTrashConfirm(false);
    }
  }, [search, selecting]);
  useEffect(() => { listAnchors.current.clear(); pendingAnchor.current = null; purgeHasCompleted.current = false; setBusy(false); setCollectionId(undefined); setSearch(""); setStatus("active"); setCollections([]); setNotes([]); setCollectionCards([]); setSelectedIds([]); setSelecting(false); setCounts({}); setVisibleIds(new Set()); }, [profile]);
  useEffect(() => {
    // A first visit still defaults to a two-column library where space permits.
    // An asynchronous preference read may not override an immediate user tap.
    let active = true;
    viewChanged.current = false;
    setGrid(true);
    if (profile) void loadMemoryLibraryView(profile).then(saved => {
      if (active && !viewChanged.current && saved) setGrid(saved === "grid");
    }).catch(() => { /* use the documented first-visit default */ });
    return () => { active = false; };
  }, [profile]);
  function switchMemoryView() {
    const next = !grid;
    const anchor = listAnchors.current.get(scope);
    pendingAnchor.current = anchor ? { ...anchor, attempts: 0 } : null;
    viewChanged.current = true;
    setGrid(next);
    if (!profile) return;
    const forProfile = profile;
    // Preserve user choice order even if two writes finish at different speeds.
    viewSaveQueue.current = viewSaveQueue.current.catch(() => undefined)
      .then(() => saveMemoryLibraryView(forProfile, next ? "grid" : "list"));
    void viewSaveQueue.current.catch(() => {
      if (viewProfile.current === forProfile) setError("Не удалось запомнить вид памяти. Попробуйте ещё раз.");
    });
  }
  useFocusEffect(useCallback(() => {
    const request = ++generation.current; setLoading(true); setError("");
    const anchor = listAnchors.current.get(scope);
    pendingAnchor.current = anchor ? { ...anchor, attempts: 0 } : null;
    if (profile) void localMemoryRepository(profile).then(async db => {
      const [sections, totals, deletedTotal] = await Promise.all([
        ensureSections(db), db.collectionNoteCounts(),
        status === "trashed" ? db.trashNoteCount() : Promise.resolve(0),
      ]);
      // Preserve the pages needed to restore the visible note by ID, never
      // use a stale pixel offset or the first 50 rows as the trash total.
      const target = memoryScrollReloadCount(anchor, scope);
      const page: EntityRecord[] = [];
      while (page.length < target) {
        if (request !== generation.current) return;
        const size = Math.min(100, target - page.length);
        const batch = await db.searchNotes(term, size, page.length, { collectionId, status });
        page.push(...batch);
        if (batch.length < size) break;
      }
      if (request !== generation.current) return;
      setTrashCount(deletedTotal);
      setCounts(totals); repository.current = db; void db.lastNoteOperation().then(value => { if (request === generation.current) setUndo(purgeHasCompleted.current ? "" : value); }).catch(() => {}); setCollections(sections); setNotes(page); setMore(page.length === target);
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
  useEffect(() => onLocalMemorySessionChange(unlocked => {
    if (!unlocked) {
      // Discard private navigation identities on lock, in addition to the
      // current global purge snapshot.
      listAnchors.current.clear(); pendingAnchor.current = null;
      if (restoreTimer.current) clearTimeout(restoreTimer.current);
      restoreTimer.current = null;
      trashEpoch.current++;
      setTrashPreview(null); setTrashConfirm(false); setTrashProgress(0);
      setTrashMessage(""); setTrashCount(0);
      hygieneGeneration.current++;
      setHygieneSuggestionsOpen(false); setHygieneSuggestions(null);
      setSuggestedReviewNotes(null); setHygieneReviewOpen(false);
      setHygienePreview(null); setHygieneConfirm(false); setHygienePolicyItem(null); setBusy(false);
    }
  }), []);
  /** Read-only review of current selected versions. There is no new action
   * writer; normal note actions still require their own confirmation.
   */
  async function inspectHygiene(excluded: string[], action:MemoryReviewAction=hygieneAction, selection:EntityRecord[]=reviewNotes) {
    if (!repository.current || busy) return;
    const token = ++hygieneGeneration.current, request = generation.current;
    setBusy(true); setError(""); setHygienePreview(null); setHygieneConfirm(false);
    try {
      const data = await repository.current.hygiene().previewWithExclusions(
        selection.map(note=>({id:note.id,recordVersion:note.record_version})),excluded,action);
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
    setSuggestedReviewNotes(null);
    setHygieneReviewOpen(false);setHygieneExcluded([]);setHygienePreview(null);setHygieneConfirm(false);setHygienePolicyItem(null);setBusy(false);
  }
  /** The one existing user-owned retention preference writer (SQLCipher CAS).
   * A new rule invalidates the entire old preview. Never re-use stale approval.
   */
  async function setGroupPolicy(note:EntityRecord,guard:MemoryReviewGuard,days:number|null=null){
    if(!repository.current||busy||!hygieneReviewOpen||note.record_status!=="active"||
       !["standard","inherit"].includes(note.sensitivity)||
       !collections.some(c=>c.id===note.collection_id&&c.sensitivity==="standard"))return;
    const token=++hygieneGeneration.current,request=generation.current;
    const targets=reviewNotes.map(n=>({id:n.id,recordVersion:n.record_version}));
    const skipped=[...hygieneExcluded],mode=hygieneAction;
    setBusy(true);setError("");setHygienePreview(null);setHygieneConfirm(false);
    try{
      const service=repository.current.hygiene();
      const current=await service.preference(note.id);
      const until=days===null?null:new Date(Date.now()+days*24*60*60*1000).toISOString();
      await service.setPreference({id:note.id,recordVersion:note.record_version},
        current.preferenceVersion,guard,until);
      const next=await service.previewWithExclusions(targets,skipped,mode);
      if(token===hygieneGeneration.current&&request===generation.current){
        setHygienePreview(next);setHygienePolicyItem(null);
      }
    }catch(e){
      if(token===hygieneGeneration.current&&request===generation.current)
        setError(memoryErrorMessage(e));
    }finally{
      if(token===hygieneGeneration.current)setBusy(false);
    }
  }
  /** Optional read-only suggestions. Discovery never selects an item for deletion. */
  async function openHygieneSuggestions() {
    if (!repository.current || busy || !localMemorySessionUnlocked()) return;
    const token = ++hygieneGeneration.current, request = generation.current;
    setHygieneSuggestionsOpen(true);setHygieneSuggestions(null);setError("");setBusy(true);
    try {
      const result = await repository.current.hygiene().discoverGroups(100);
      if (token === hygieneGeneration.current && request === generation.current &&
          localMemorySessionUnlocked()) setHygieneSuggestions(result);
    } catch (e) {
      if (token === hygieneGeneration.current && request === generation.current)
        setError(memoryErrorMessage(e));
    } finally {
      if (token === hygieneGeneration.current) setBusy(false);
    }
  }
  function closeHygieneSuggestions() {
    hygieneGeneration.current++;
    setHygieneSuggestionsOpen(false);setHygieneSuggestions(null);setBusy(false);
  }
  /** Only source-versioned, currently permitted notes can enter the canonical review.
   * The review CAS writer repeats all source, policy and ACL checks atomically.
   */
  async function inspectSuggestedGroup(group: MemoryHygieneSuggestedGroup) {
    if (!repository.current || busy || !localMemorySessionUnlocked()) return;
    const db = repository.current, token = ++hygieneGeneration.current, request = generation.current;
    setBusy(true);setError("");
    try {
      const preview = await db.hygiene().previewWithExclusions(group.targets, [], "archive");
      // A changed/private item cannot have its title read for the current review.
      if (preview.included.some(item => item.reasons.some(reason =>
          ["missing", "stale_record_version", "not_active", "private_or_unclassified"].includes(reason))))
        throw new Error("Группа изменилась. Повторите поиск предложений.");
      const fetched = await Promise.all(group.targets.map(item => db.entity(item.id)));
      const valid = fetched.every((note, index) => note &&
        note.id === group.targets[index].id &&
        note.record_version === group.targets[index].recordVersion &&
        note.record_status === "active" &&
        ["standard", "inherit"].includes(note.sensitivity) &&
        collections.some(c => c.id === note.collection_id && c.sensitivity === "standard"));
      if (!valid || !localMemorySessionUnlocked())
        throw new Error("Источники или права изменились. Повторите поиск предложений.");
      if (token !== hygieneGeneration.current || request !== generation.current) return;
      setSuggestedReviewNotes(fetched as EntityRecord[]);
      setHygieneExcluded([]);setHygieneAction("archive");setHygieneConfirm(false);setHygienePolicyItem(null);
      setHygienePreview(preview);
      setHygieneSuggestionsOpen(false);setHygieneSuggestions(null);
      setHygieneReviewOpen(true);
    } catch (e) {
      if (token === hygieneGeneration.current && request === generation.current)
        setError(memoryErrorMessage(e));
    } finally {
      if (token === hygieneGeneration.current) setBusy(false);
    }
  }
  /** Reuse changeNotes+undoNotes. No additional cleanup writer, no purge. */
  async function applyHygiene(){
    if(!repository.current||busy||!hygieneConfirm||!hygienePreview||
       hygienePreview.action!==hygieneAction||!hygienePreview.eligibleIds.length)return;
    const preview=hygienePreview, request=generation.current, token=++hygieneGeneration.current;
    const included=preview.included.filter(x=>x.eligible);
    // The selection must still match the preview. The DB transaction checks
    // every record version, status, policy CAS and privacy before any write.
    if(preview.selectedCount!==reviewNotes.length ||
       included.some(x=>!reviewNotes.some(n=>n.id===x.id&&n.record_version===x.expectedRecordVersion))){
      setError("Список изменился. Повторите проверку.");setHygieneConfirm(false);return;
    }
    setBusy(true);setError("");
    try{
      const operation=await repository.current.changeNotes(hygieneAction,
        included.map(x=>({id:x.id,record_version:x.expectedRecordVersion})),undefined,
        {expectedPreferences:included.map(x=>({id:x.id,preferenceVersion:x.expectedPreferenceVersion}))});
      if(token===hygieneGeneration.current&&request===generation.current){
        setUndo(operation);setHygieneReviewOpen(false);setSuggestedReviewNotes(null);setHygieneExcluded([]);
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
  async function act(action: NoteAction, target?: string, directNotes?: EntityRecord[]) {
    const affectedNotes = directNotes ?? selectedNotes;
    if (!repository.current || busy || affectedNotes.length === 0) return;
    setBusy(true); setError("");
    try {
      // A card-local restore must target that exact source/version, never another selection.
      const token = await repository.current.changeNotes(action, affectedNotes, target);
      purgeHasCompleted.current = false; setUndo(token); setSelectedIds([]); setSelecting(false); setActionsOpen(false); setConfirmation(null); setContextNote(null); setMoveOpen(false); setMergeOpen(false); setRetry(n => n + 1);
      if (profile) scheduleVectors(profile);
    } catch (e) { setError(memoryErrorMessage(e)); } finally { setBusy(false); }
  }
  useEffect(() => { trashEpoch.current++; setTrashPreview(null); setTrashConfirm(false); setTrashMessage(""); setTrashProgress(0); setSelectedIds([]); setSelecting(false); setActionsOpen(false); setConfirmation(null); setNotes([]); setContextNote(null); setMoveOpen(false); setMergeOpen(false); hygieneGeneration.current++; setHygieneReviewOpen(false); setHygieneSuggestionsOpen(false); setHygieneSuggestions(null); setSuggestedReviewNotes(null); setHygieneExcluded([]); setHygienePreview(null); setHygieneConfirm(false); setHygienePolicyItem(null); setHygieneAction("archive"); }, [profile, collectionId, term, status]);
  function openAll() { setStatus("active"); setCollectionId(undefined); setSearch(""); setTerm(""); setSelectedIds([]); setSelecting(false); }
  function openStatus(value: typeof status) { openAll(); setStatus(value); }
  const cancelSelection = useCallback(() => {
    setSelectedIds([]); setSelecting(false); setActionsOpen(false); setConfirmation(null); setContextNote(null);
  }, []);
  useFocusEffect(useCallback(() => {
    const sub = BackHandler.addEventListener("hardwareBackPress", () => {
      // A sheet or native keyboard handles its own Back; never change the area underneath.
      if (actionsOpen || moveOpen || mergeOpen || hygieneReviewOpen || hygieneSuggestionsOpen ||
          addOpen || menuOpen || collectionMenu || sectionOpen || trashPreview !== null) return false;
      if (selecting) {
        if (!busy) cancelSelection();
        return true;
      }
      if (search) {
        if (!busy) setSearch("");
        return true;
      }
      if (status !== "active" || collectionId) {
        if (!busy) openAll();
        return true;
      }
      return false;
    });
    return () => sub.remove();
  }, [selecting, busy, actionsOpen, moveOpen, mergeOpen, hygieneReviewOpen,
    hygieneSuggestionsOpen, addOpen, menuOpen, collectionMenu, sectionOpen, trashPreview, search, status, collectionId, cancelSelection]));
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
      purgeHasCompleted.current = true;
      cancelSelection(); setConfirmation(null); setUndo(""); setRetry(n => n + 1);
    } catch (e) { setError(memoryErrorMessage(e)); } finally { setBusy(false); }
  }
  async function inspectWholeTrash() {
    if (!repository.current || busy || trashRunning.current || loading ||
        status !== "trashed" || selecting || search || term || collectionId || !localMemorySessionUnlocked()) return;
    const epoch = ++trashEpoch.current, request = generation.current;
    const currentProfile = profile, db = repository.current;
    setBusy(true); setError(""); setTrashMessage(""); setTrashConfirm(false); setTrashPreview(null);
    try {
      const snapshot = await db.trashPurgeSnapshot();
      if (epoch !== trashEpoch.current || request !== generation.current ||
          viewProfile.current !== currentProfile || !localMemorySessionUnlocked()) return;
      setTrashCount(snapshot.totalCount);
      if (!snapshot.totalCount) {
        setTrashMessage("Корзина пуста. Удалять нечего.");
        setRetry(n => n + 1);
      } else setTrashPreview(snapshot);
    } catch (e) {
      if (epoch === trashEpoch.current && request === generation.current)
        setError("Не удалось проверить корзину: " + memoryErrorMessage(e));
    } finally {
      // Search/filter navigation can invalidate the preview while the read is
      // pending. Release the busy state for this profile even then.
      if (viewProfile.current === currentProfile && localMemorySessionUnlocked()) setBusy(false);
    }
  }
  async function emptyWholeTrash() {
    const snapshot = trashPreview, db = repository.current;
    if (!snapshot?.items.length || !db || !trashConfirm || busy || trashRunning.current ||
        status !== "trashed" || selecting || search || term || collectionId || !localMemorySessionUnlocked()) return;
    trashRunning.current = true;
    const epoch = trashEpoch.current, request = generation.current, currentProfile = profile;
    const allowed = () => {
      const scope = trashScope.current;
      return epoch === trashEpoch.current && request === generation.current &&
        viewProfile.current === currentProfile && scope.status === "trashed" &&
        !scope.search && !scope.term && !scope.selecting && !scope.collectionId &&
        localMemorySessionUnlocked();
    };
    setBusy(true); setError(""); setTrashProgress(0);
    try {
      // Every chunk contains only IDs and versions from the snapshot the user
      // reviewed. The canonical purgeNotes writer enforces CAS/status atomically.
      const outcome = await purgeConfirmedTrash(
        snapshot.items, batch => db.purgeNotes(batch, { protectReferences: true }), allowed,
        count => { if (allowed()) setTrashProgress(count); },
      );
      if (!allowed()) return;
      if (outcome.confirmed > 0) purgeHasCompleted.current = true;
      setTrashPreview(null); setTrashConfirm(false); setUndo("");
      // Authoritative fresh read only. Never automatically repeat an unknown
      // or failed commit, even when some confirmed batches already succeeded.
      try {
        const remaining = await db.trashNoteCount();
        if (!allowed()) return;
        setTrashCount(remaining);
        setTrashMessage(outcome.error
          ? `Подтверждено удаление ${outcome.confirmed} из ${outcome.total}. Операция остановлена. В корзине осталось ${remaining}. Проверьте состояние перед новым удалением.`
          : remaining === 0
            ? `Удалено ${trashPurgeCountLabel(outcome.confirmed)}. Корзина пуста.`
            : `Удалено ${trashPurgeCountLabel(outcome.confirmed)}. В корзине осталось ${trashPurgeCountLabel(remaining)}. Записи со связями требуют отдельной проверки; новые записи автоматически не удалялись.`);
      } catch {
        if (allowed()) setTrashMessage(
          `Подтверждено удаление ${outcome.confirmed} из ${outcome.total}, но остаток проверить не удалось. Проверьте состояние корзины; удаление автоматически не повторялось.`);
      }
      if (allowed()) setRetry(n => n + 1);
    } finally {
      trashRunning.current = false;
      // Switching the filter invalidates further batches, but must never
      // leave the current screen permanently busy. Profile/lock already
      // reset their state independently.
      if (viewProfile.current === currentProfile && localMemorySessionUnlocked()) setBusy(false);
    }
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
      <NebulaAction icon="x" label="Отмена" accessibilityLabel="Отменить выбор записей" onPress={cancelSelection} disabled={busy} />
      <Text accessibilityLiveRegion="polite" style={{ flex: 1, color: t.text }}>Выбрано: {selectedIds.length}</Text>
      <NebulaAction icon="more-horizontal" label="Действия" accessibilityLabel="Действия с выбранными записями" variant="primary" onPress={() => setActionsOpen(true)} disabled={busy || !selectedIds.length} />
    </View> : <View testID="memory-normal-toolbar" style={{ paddingHorizontal: 16, minHeight: 56, flexDirection: "row", alignItems: "center", gap: nebulaSpacing.xs }}>
          {status !== "active" || collectionId ? <Pressable accessibilityRole="button" accessibilityLabel="Ко всем записям" disabled={busy} onPress={openAll}
            style={{ ...button, paddingHorizontal: nebulaSpacing.sm, minWidth: nebulaTouch.minimum }}>
            <Feather name="arrow-left" size={22} color={t.secondary} />
          </Pressable> : null}
          <Text accessibilityRole="header" numberOfLines={2} style={{ flex: 1, color: t.text, fontSize: 26, fontWeight: "800" }}>
            {status === "archived" ? "Архив" : status === "trashed" ? "Корзина" :
              collectionId ? collections.find(c => c.id === collectionId)?.name || "Раздел" : "Память"}
          </Text>
          {status === "active" ? <Pressable accessibilityRole="button" accessibilityLabel="Добавить в память" disabled={busy} onPress={() => setAddOpen(true)}
            style={{ ...button, paddingHorizontal: 12, backgroundColor: t.accent }}><Feather name="plus" size={24} color={t.userText} /></Pressable> : null}
          {status === "active" ? <Pressable accessibilityRole="button" accessibilityLabel="Меню памяти" disabled={busy} onPress={() => setMenuOpen(true)} style={{ ...button, paddingHorizontal: 12 }}><Feather name="more-vertical" size={24} color={t.text} /></Pressable> : null}
        </View>}
    <FlatList
      testID="memory-note-list" ref={listRef} key={columns} numColumns={columns}
      onViewableItemsChanged={onViewableItemsChanged} viewabilityConfig={viewabilityConfig}
      onScroll={event => {
        scrollY.current = event.nativeEvent.contentOffset.y;
        if (scrollY.current < 20 && !pendingAnchor.current) listAnchors.current.delete(scope);
      }}
      scrollEventThrottle={100}
      onScrollBeginDrag={() => { pendingAnchor.current = null; }}
      onContentSizeChange={() => restoreListAnchor()}
      onScrollToIndexFailed={({ index, averageItemLength }) => {
        const pending = pendingAnchor.current;
        if (!pending || pending.scope !== scope) return;
        if (pending.attempts >= 4) { pendingAnchor.current = null; return; }
        listRef.current?.scrollToOffset({ offset: Math.max(0, averageItemLength * index), animated: false });
        if (restoreTimer.current) clearTimeout(restoreTimer.current);
        restoreTimer.current = setTimeout(restoreListAnchor, 90);
      }}
      initialNumToRender={8} windowSize={5} columnWrapperStyle={columns > 1 ? { gap: nebulaSpacing.sm, alignItems: "flex-start" } : undefined}
      ListHeaderComponent={<View style={{ paddingTop: nebulaSpacing.sm, paddingBottom: nebulaSpacing.sm, gap: nebulaSpacing.sm }}>
        <View style={{ flexDirection: "row", alignItems: "center", borderWidth: 1, borderColor: t.line, borderRadius: nebulaRadii.field, backgroundColor: t.panel }}>
          <Feather name="search" size={19} color={t.muted} style={{ marginLeft: nebulaSpacing.sm }} />
          <TextInput testID="memory-search" accessibilityLabel="Поиск по заметкам"
            value={search} editable={!selecting && !loading} onChangeText={setSearch}
            placeholder={status === "trashed" ? "Поиск в корзине" : status === "archived" ? "Поиск в архиве" : "Поиск по памяти"}
            placeholderTextColor={t.muted} returnKeyType="search"
            style={{ flex: 1, minWidth: 0, minHeight: nebulaTouch.minimum, fontSize: 16, color: t.text, paddingHorizontal: nebulaSpacing.sm }} />
          {search ? <Pressable accessibilityRole="button" disabled={selecting} accessibilityLabel="Очистить поиск по памяти"
            onPress={() => setSearch("")} style={{ minWidth: nebulaTouch.minimum, minHeight: nebulaTouch.minimum, justifyContent: "center", alignItems: "center" }}>
            <Feather name="x" size={20} color={t.muted} />
          </Pressable> : null}
        </View>
        {status === "active" && !term && !collectionId && !selecting ? <View testID="memory-quick-sections"
          style={{ flexDirection: "row", flexWrap: "wrap", gap: nebulaSpacing.xs }}>
          <NebulaAction testID="memory-open-archive" icon="archive" label="Архив"
            accessibilityLabel="Открыть архив" disabled={busy || loading} onPress={() => openStatus("archived")} />
          <NebulaAction testID="memory-open-trash" icon="trash-2" label="Корзина"
            accessibilityLabel="Открыть корзину" disabled={busy || loading} onPress={() => openStatus("trashed")} />
        </View> : null}
        {!term && status === "active" && !collectionId ? <>
          <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
            <Text style={{ color: t.text, fontSize: 18, fontWeight: "700" }}>Коллекции</Text>
            <NebulaAction icon="grid" label="Все разделы" accessibilityLabel="Все коллекции" disabled={selecting} onPress={() => setCollectionMenu(true)} />
          </View>
          <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: nebulaSpacing.sm }}>
            {collectionCards.map(c => <Pressable key={c.id} accessibilityRole="button" accessibilityLabel={"Раздел " + c.name}
              disabled={selecting} accessibilityState={{ disabled: selecting }} onPress={() => setCollectionId(c.id)}
              style={{ width: Math.min(width - 48, 176 * Math.min(fontScale, 1.3)),
                minHeight: nebulaTouch.minimum + nebulaSpacing.md, padding: nebulaSpacing.sm,
                flexDirection: "row", alignItems: "center", gap: nebulaSpacing.sm,
                borderRadius: nebulaRadii.field, backgroundColor: t.panel, borderWidth: 1, borderColor: t.line }}>
              <View style={{ width: 40, height: 40, flexShrink: 0, borderRadius: nebulaRadii.chip,
                backgroundColor: t.soft, justifyContent: "center", alignItems: "center" }}>
                <Feather name={c.slug === "people" ? "users" : c.slug === "preferences" ? "heart" : c.slug === "events" ? "calendar" : "folder"}
                  size={21} color={t.secondary} />
              </View>
              <View style={{ flex: 1, minWidth: 0, gap: 3 }}>
                <Text numberOfLines={2} style={{ color: t.text, fontWeight: "700", fontSize: 15 }}>{c.name}</Text>
                <Text numberOfLines={1} style={{ color: t.muted, fontSize: 13 }}>Записей: {counts[c.id] ?? 0}</Text>
              </View>
            </Pressable>)}
          </ScrollView>
        </> : null}
        <View style={{ flexDirection: "row", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <Text testID={status === "trashed" ? "trash-total-counter" : undefined}
            style={{ flex: 1, minWidth: status === "trashed" && width < 560 ? width - 32 : undefined,
              color: t.text, fontSize: 18, fontWeight: "700" }}>
            {term ? "Результаты поиска" : status === "archived" ? "Записи в архиве" :
              status === "trashed" ? "Корзина · " + trashPurgeCountLabel(trashCount) : collectionId ? "Записи раздела" : "Недавнее"}
          </Text>
          {status === "trashed" && !term && !search && !selecting && !collectionId &&
            trashCount > 0 && !loading ? <NebulaAction testID="memory-empty-trash"
              icon="trash-2" label="Очистить корзину" variant="danger"
              accessibilityLabel="Очистить всю корзину" disabled={busy}
              onPress={() => void inspectWholeTrash()} /> : null}
          {status === "active" && width >= 350 && fontScale < 1.4 ?
            <NebulaAction icon={grid ? "list" : "grid"} label={grid ? "Список" : "Плитки"}
              accessibilityLabel={grid ? "Показать списком" : "Показать плитками"}
              disabled={selecting} onPress={switchMemoryView} /> : null}
        </View>
        {collectionId && status === "active" && !term && !selecting &&
            collections.some(c => c.id === collectionId && c.sensitivity === "standard") ?
          <Pressable accessibilityRole="button" accessibilityLabel="Открыть предложения по изменению памяти"
            style={{ ...button, alignItems: "flex-start", borderWidth: 1, borderColor: t.line, backgroundColor: t.panel }}
            onPress={() => navigation.navigate("MemoryTemporalReview", { collectionId })}>
            <Text style={{ color: t.secondary, fontWeight: "700" }}>На проверке · возможные изменения</Text>
            <Text style={{ color: t.muted, fontSize: 13 }}>Сравнить источники и решить, что делать с прежними фактами</Text>
          </Pressable> : null}
        {notes.length && !selecting ? <View style={{ alignItems: "flex-start" }}>
          <NebulaAction icon="check-square" label="Выбрать записи"
            disabled={loading || busy} onPress={() => { setContextNote(null); setSelecting(true); }} />
        </View> : null}
        {status === "trashed" ? <Text style={{ color: t.muted, fontSize: 13, lineHeight: 19 }}>
          Удалённые записи исключены из поиска агента. Их можно восстановить или удалить окончательно.
          Команда «Очистить корзину» касается только этого профиля и требует отдельного подтверждения.
        </Text> : null}
        {status === "trashed" && !term && !selecting && trashMessage ? <View style={{ gap: 8 }}>
          <Text accessibilityLiveRegion="polite" style={{ color: t.text }}>{trashMessage}</Text>
          <View style={{ alignItems: "flex-start" }}>
            <NebulaAction icon="refresh-cw" label="Проверить состояние корзины" disabled={busy}
              onPress={() => { setTrashMessage(""); setRetry(n => n + 1); }} />
          </View>
        </View> : null}
      {undo ? <View style={{ alignItems: "flex-start" }}>
        <NebulaAction icon="rotate-ccw" label={noteUndoLabel(undo)}
          accessibilityLabel={noteUndoLabel(undo)} disabled={busy || selecting}
          onPress={() => { if (!repository.current) return; setBusy(true); void repository.current.undoNotes(undo).then(() => { setUndo(""); setRetry(n => n + 1); if (profile) scheduleVectors(profile); }).catch(e => setError(memoryErrorMessage(e))).finally(() => setBusy(false)); }} />
      </View> : null}
    {error && !hygieneReviewOpen && !hygieneSuggestionsOpen ? <View style={{ paddingHorizontal: 18, gap: 8 }}><Text accessibilityRole="alert" style={{ color: t.err }}>{error}</Text><NebulaAction icon="refresh-cw" label="Повторить загрузку" onPress={() => setRetry(n => n + 1)} /></View> : null}
    {loading ? <ActivityIndicator accessibilityLabel="Загрузка записей" /> : null}
</View>} data={notes} keyExtractor={item => item.id} keyboardShouldPersistTaps="handled" keyboardDismissMode="on-drag"
      contentContainerStyle={{ paddingHorizontal: nebulaSpacing.md, paddingBottom: nebulaSpacing.xl, gap: nebulaSpacing.sm, flexGrow: 1 }}
      ListEmptyComponent={!loading && !error ? <View style={{ flex: 1, alignItems: "center", justifyContent: "center", padding: 24, gap: 12 }}><Feather name={term ? "search" : "book-open"} size={40} color={t.secondary} />
        <Text style={{ color: t.text, fontSize: 20, fontWeight: "700", textAlign: "center" }}>{term ? "Ничего не найдено" : status === "archived" ? "Архив пуст" : status === "trashed" ? "Корзина пуста" : "Начните с важного"}</Text>
        <Text style={{ color: t.muted, textAlign: "center", lineHeight: 21 }}>{term ? "Попробуйте другое слово или раздел «Все записи»." : status === "trashed" ? "Здесь будут удалённые заметки, пока вы их не восстановите." : status === "archived" ? "Здесь хранятся записи, которые вы отправили в архив. Их можно вернуть в обычную память." : "Создайте запись или добавьте сведения из файла."}</Text>
        {!term && status !== "active" ? <NebulaAction icon="arrow-left" label="Вернуться в память" onPress={openAll} /> : null}
      </View> : null}
      renderItem={({ item }) => <View style={{ flex: 1, maxWidth: columns === 2 ? "50%" : "100%" }}><MemoryNoteCard note={item} grid={columns === 2}
        cover={profile && memoryNoteHasPhoto(item)
          ? <MemoryCover profile={profile} entityId={item.id} active={visibleIds.has(item.id)}
            height={columns === 2 ? MEMORY_GRID_MEDIA_HEIGHT : 56} compact={columns !== 2} label={"Обложка " + item.title} /> : undefined}
        sectionName={collectionId ? "" : collections.find(c => c.id === item.collection_id)?.name || "Запись"}
        selected={selectedIds.includes(item.id)} selecting={selecting}
        onToggleSelection={() => toggleSelection(item.id)}
        onRestore={status === "trashed" ? () => { void act("restore", undefined, [item]); } : undefined}
        restoreDisabled={busy || loading}
        onActions={() => { if (!busy && !loading) { setConfirmation(null); setContextNote(item); setActionsOpen(true); } }}
        onOpen={() => selecting
          ? toggleSelection(item.id)
          : navigation.navigate("MemoryNote", { entityId: item.id })}
      /></View>}
      ListFooterComponent={more && !loading ? <NebulaAction icon="chevron-down"
          label={busy ? "Загружаю…" : "Показать ещё"} accessibilityLabel="Показать ещё заметки"
          disabled={busy} onPress={() => void loadMore()} /> : null} />
      <BottomSheet visible={Boolean(trashPreview)} title={trashConfirm ? "Очистить корзину?" : "Проверка корзины"}
        onClose={() => { if (busy) return; trashEpoch.current++; setTrashPreview(null); setTrashConfirm(false); }}>
        {trashPreview ? <>
          <Text style={{ color: t.text, fontSize: 17, lineHeight: 25 }}>
            {trashConfirm
              ? `Будут безвозвратно удалены ${trashPurgeCountLabel(trashPreview.items.length)} из корзины этого профиля.`
              : `Всего в корзине ${trashPurgeCountLabel(trashPreview.totalCount)}. Массово можно удалить ${trashPurgeCountLabel(trashPreview.items.length)}. Проверен весь список, а не только видимые 50.`}
          </Text>
          <Text style={{ color: t.muted, lineHeight: 22 }}>
            Оригиналов в удаляемых записях: {trashPreview.originalCount}.
            {trashPreview.protectedCount > 0
              ? ` Защищены от массового удаления: ${trashPurgeCountLabel(trashPreview.protectedCount)}. Эти записи содержат связи, источники или подтверждённые факты и требуют отдельного просмотра. Связанных отношений: ${trashPreview.affectedRelationCount}.`
              : ""}
            История и оригиналы удаляемых записей исчезнут. Экспортированные ранее копии не затрагиваются.
            Восстановить удалённое в приложении нельзя.
          </Text>
          {busy ? <Text accessibilityLiveRegion="polite" style={{ color: t.muted }}>
            Подтверждено удаление {trashProgress} из {trashPreview.items.length}…
          </Text> : null}
          <NebulaAction icon="x" label="Отмена" accessibilityLabel="Отменить очистку корзины"
            disabled={busy} onPress={() => { trashEpoch.current++; setTrashPreview(null); setTrashConfirm(false); }} />
          {trashPreview.items.length === 0
            ? <Text accessibilityRole="alert" style={{ color: t.muted }}>
                Все записи требуют отдельной проверки. Массовое удаление недоступно.
              </Text>
            : trashConfirm ? <NebulaAction icon="trash-2" variant="danger-solid"
              label={`Удалить ${trashPurgeCountLabel(trashPreview.items.length)}`}
              accessibilityLabel="Подтвердить очистку всей корзины" disabled={busy}
              onPress={() => void emptyWholeTrash()} />
            : <NebulaAction icon="alert-triangle" variant="danger" label="Продолжить к подтверждению"
                accessibilityLabel="Проверить последствия очистки корзины"
                disabled={busy} onPress={() => setTrashConfirm(true)} />}
        </> : null}
      </BottomSheet>
      <BottomSheet visible={actionsOpen && selectedNotes.length > 0} title={confirmation ? (confirmation === "trash" ? "В корзину?" : "Удалить навсегда?") : selectedNotes.length === 1 ? "Действия с записью" : `Действия · ${selectedNotes.length}`} onClose={() => { if (busy) return; if (confirmation) setConfirmation(null); else { setActionsOpen(false); setContextNote(null); } }}>
      {error ? <Text accessibilityRole="alert" style={{ color: t.err }}>{error}</Text> : null}
      <Text numberOfLines={2} style={{ color: t.muted }}>{selectedNotes.map(memoryDisplayTitle).join(", ")}</Text>
      {confirmation ? <>
        <Text style={{ color: t.text }}>
          {confirmation === "trash"
            ? `Записей: ${selectedNotes.length}. Их можно будет восстановить из корзины.`
            : `Записей: ${selectedNotes.length}. Записи, оригиналы и история будут удалены без возможности восстановления.`}
        </Text>
        <NebulaAction icon="x" label="Отмена" disabled={busy} onPress={() => setConfirmation(null)} />
        <NebulaAction icon="trash-2" variant={confirmation === "purge" ? "danger-solid" : "danger"}
          label={busy ? "Выполняю…" : confirmation === "trash" ? "В корзину" : "Удалить навсегда"}
          accessibilityLabel={confirmation === "trash" ? "Подтвердить перемещение в корзину" : "Подтвердить удаление навсегда"}
          disabled={busy} onPress={() => confirmation === "trash" ? void act("trash") : void purgeSelected()} />
      </> : <>
        {selectedNotes.length === 1 ? <NebulaAction icon={status === "trashed" ? "eye" : "edit-3"}
          label={status === "trashed" ? "Открыть запись" : "Редактировать"}
          disabled={busy} onPress={() => { setActionsOpen(false); setConfirmation(null); setContextNote(null);
            navigation.navigate("MemoryNote", { entityId: selectedNotes[0].id }); }} /> : null}
        {status === "trashed" ? <>
          <NebulaAction icon="rotate-ccw" label="Восстановить" disabled={busy}
            onPress={() => void act("restore")} />
          <NebulaAction icon="trash-2" label="Удалить навсегда" variant="danger" disabled={busy}
            onPress={() => setConfirmation("purge")} />
        </> : <>
          <NebulaAction icon={status === "archived" ? "corner-up-left" : "archive"}
            label={status === "archived" ? "Вернуть из архива" : "В архив"}
            disabled={busy} onPress={() => void act(status === "archived" ? "unarchive" : "archive")} />
          <NebulaAction icon="folder" label="Перенести" disabled={busy}
            onPress={() => { setActionsOpen(false); setMoveOpen(true); }} />
          {selectedNotes.length >= 2 && status === "active" ? <NebulaAction icon="git-merge"
            label="Объединить записи" disabled={busy}
            onPress={() => { setActionsOpen(false); setMergeOpen(true); }} /> : null}
          {selectedNotes.length >= 2 && status === "active" ? <NebulaAction icon="clipboard"
            label="Проверить группу и исключения" accessibilityLabel="Проверить последствия групповой ревизии"
            disabled={busy} onPress={() => {
              setActionsOpen(false); setHygieneExcluded([]); setHygienePreview(null);
              setHygieneAction("archive"); setHygieneConfirm(false); setHygienePolicyItem(null);
              setHygieneReviewOpen(true); void inspectHygiene([]);
            }} /> : null}
          <NebulaAction icon="trash-2" label="В корзину" variant="danger"
            disabled={busy} onPress={() => setConfirmation("trash")} />
        </>}
        {contextNote ? <NebulaAction icon="check-square" label="Выбрать несколько"
          disabled={busy} onPress={() => {
            setSelectedIds([contextNote.id]); setSelecting(true); setContextNote(null); setActionsOpen(false);
          }} /> : null}
      </>}
      </BottomSheet>

    <BottomSheet visible={hygieneSuggestionsOpen} title="Предложения для ревизии" onClose={closeHygieneSuggestions}>
      <Text style={{color:t.muted}}>
        Найденные группы — повод проверить записи, а не решение об удалении. Без вашего подтверждения ничего не изменится.
      </Text>
      {busy?<ActivityIndicator accessibilityLabel="Ищу группы для ревизии" color={t.secondary}/>:null}
      {hygieneSuggestions?<Text accessibilityLiveRegion="polite" style={{color:t.text,fontWeight:"600"}}>
        Найдено групп: {hygieneSuggestions.groups.length} · Проверено записей: {hygieneSuggestions.scanned}
      </Text>:null}
      {hygieneSuggestions?.groups.length===0?
        <Text style={{color:t.muted}}>В проверенной части памяти групп не обнаружено.</Text>:null}
      {hygieneSuggestions?.partial?
        <Text style={{color:t.muted}}>Анализ ограничен первыми {hygieneSuggestions.scanned} записями. Другие группы могут находиться за пределами выборки.</Text>:null}
      {hygieneSuggestions?.groups.map((group,index)=>
        <Pressable key={group.reason+":"+index} accessibilityRole="button" disabled={busy}
          accessibilityLabel={"Проверить группу: "+group.title+", записей "+group.targets.length}
          accessibilityHint="Откроется ручная проверка с исключениями; изменения потребуют подтверждения"
          style={{...actionButton,minHeight:nebulaTouch.minimum,borderWidth:1,borderColor:t.line,
            borderRadius:nebulaRadii.field,backgroundColor:t.soft,padding:nebulaSpacing.md,gap:6}}
          onPress={()=>void inspectSuggestedGroup(group)}>
          <View style={{flexDirection:"row",alignItems:"center",gap:nebulaSpacing.sm}}>
            <Feather name={group.reason==="same_saved_url"?"link":"bookmark"} size={20} color={t.secondary}/>
            <Text style={{flex:1,color:t.text,fontWeight:"700"}}>{group.title}</Text>
            <Feather name="chevron-right" size={18} color={t.muted}/>
          </View>
          <Text style={{color:t.muted,fontSize:13,lineHeight:19}}>
            {group.reason==="same_saved_url"?
              "Совпала исходная ссылка; тексты и заметки могут отличаться.":
              "Отмечено «прочитать/посмотреть позже»; интерес к материалам не оценивался."}
          </Text>
          <Text style={{color:t.secondary,fontSize:13}}>Записей: {group.targets.length} · Проверить и исключить</Text>
        </Pressable>)}
      {error?<Text accessibilityRole="alert" style={{color:t.err}}>{error}</Text>:null}
      <NebulaAction icon="x" label="Закрыть без изменений"
        accessibilityLabel="Закрыть предложения для ревизии" onPress={closeHygieneSuggestions} />
    </BottomSheet>

    <BottomSheet visible={hygieneReviewOpen && reviewNotes.length>=2}
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
      {reviewNotes.map(note=>{
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
      {hygienePolicyItem && reviewNotes.some(n=>n.id===hygienePolicyItem) ?
        <Text style={{color:t.muted}}>Правила хранения сохраняются отдельно от архивации. Они действуют и при следующей ревизии.</Text>:null}
      {reviewNotes.map(note=>{
        const available=note.record_status==="active" &&
          ["standard","inherit"].includes(note.sensitivity) &&
          collections.some(c=>c.id===note.collection_id&&c.sensitivity==="standard");
        if(!available)return null;
        const expanded=hygienePolicyItem===note.id;
        return <View key={"policy:"+note.id} style={{gap:4}}>
          <Pressable accessibilityRole="button"
            accessibilityLabel={"Правила сохранения "+memoryDisplayTitle(note)}
            accessibilityState={{expanded,disabled:busy}} disabled={busy}
            style={{...actionButton,minHeight:nebulaTouch.minimum}}
            onPress={()=>setHygienePolicyItem(expanded?null:note.id)}>
            <Text style={{color:t.secondary}}>Правила сохранения · {memoryDisplayTitle(note)} {expanded?"⌃":"⌄"}</Text>
          </Pressable>
          {expanded?<View style={{gap:4}}>
            {([
              {label:"Всегда сохранять",guard:"pinned" as const,days:null},
              {label:"Не предлагать к очистке",guard:"never_suggest" as const,days:null},
              {label:"Отложить на 30 дней",guard:"normal" as const,days:30},
              {label:"Снять ограничения",guard:"normal" as const,days:null},
            ]).map(policy=><Pressable key={policy.label} accessibilityRole="button"
              accessibilityLabel={policy.label+" · "+memoryDisplayTitle(note)}
              disabled={busy} style={actionButton}
              onPress={()=>void setGroupPolicy(note,policy.guard,policy.days)}>
              <Text style={{color:t.text}}>{policy.label}</Text>
            </Pressable>)}
          </View>:null}
        </View>;
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
          <NebulaAction icon="check" accessibilityLabel="Подтвердить групповое действие памяти"
            label={hygieneAction==="archive"?"Подтвердить архивирование":"Подтвердить перемещение в корзину"}
            variant={hygieneAction==="trash"?"danger":"quiet"} onPress={()=>void applyHygiene()} />
          <NebulaAction icon="arrow-left" label="Назад к проверке"
            accessibilityLabel="Отмена подтверждения группового действия"
            onPress={()=>setHygieneConfirm(false)} />
        </> : <NebulaAction icon={hygieneAction==="archive"?"archive":"trash-2"}
          accessibilityLabel={hygieneAction==="archive"?"Продолжить архивирование группы":"Продолжить перемещение группы в корзину"}
          variant={hygieneAction==="trash"?"danger":"quiet"}
          label={(hygieneAction==="archive"?"Архивировать":"В корзину")+" · "+hygienePreview.eligibleIds.length}
          onPress={()=>setHygieneConfirm(true)} />) : null}
      <NebulaAction icon="x" label="Закрыть без изменений"
        accessibilityLabel="Закрыть предпросмотр без изменений" onPress={closeHygiene} />
    </BottomSheet>

    <BottomSheet visible={addOpen} title="Добавить в память" onClose={() => setAddOpen(false)}>
      {([
        ["text", "edit-3", "Текст или голос", "Написать или надиктовать заметку"],
        ["camera", "camera", "Камера", "Сделать новый снимок"],
        ["gallery", "image", "Галерея", "Выбрать одно или несколько фото"],
        ["file", "paperclip", "Файл", "Документы, аудио и видео"],
        ["link", "link", "Ссылка", "Загрузить статью или файл"],
      ] as const).map(([source, icon, label, hint]) => <Pressable key={source} accessibilityRole="button"
        accessibilityLabel={label} accessibilityHint={hint} onPress={() => {
          setAddOpen(false);
          if (source === "text") navigation.navigate("MemoryNote", { collectionId });
          else navigation.navigate("MemoryImport", { source, collectionId });
        }} style={({pressed}) => ({flexDirection:"row", alignItems:"center", gap:14,
          padding:12, minHeight:56, borderRadius:16, backgroundColor:pressed ? t.line : t.soft})}>
        <Feather name={icon} size={21} color={t.secondary}/>
        <View style={{flex:1}}><Text style={{color:t.text,fontSize:16,fontWeight:"600"}}>{label}</Text>
          <Text style={{color:t.muted,fontSize:13}}>{hint}</Text></View>
      </Pressable>)}
    </BottomSheet>
    <BottomSheet visible={menuOpen && status === "active"} title="Инструменты памяти" onClose={() => setMenuOpen(false)}>
      <Text style={{ color: t.muted }}>Ревизия</Text>
      <Pressable accessibilityRole="button" accessibilityLabel="Найти группы для проверки памяти"
        disabled={busy} style={{ ...button, alignItems: "flex-start" }}
        onPress={() => {setMenuOpen(false);void openHygieneSuggestions();}}>
        <Text style={{ color: t.text }}>Предложения для ревизии</Text>
        <Text style={{ color: t.muted, fontSize: 13 }}>Только ручная проверка · без автоматического удаления</Text>
      </Pressable>
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
