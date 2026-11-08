import React, { useEffect, useRef, useState } from "react";
import { ActivityIndicator, ScrollView, Text, TextInput, View } from "react-native";
import { BottomSheet } from "../../components/BottomSheet";
import { parseNoteTagsInput } from "../../local-memory/note-tags";
import type { SqliteMemoryRepository } from "../../local-memory/repository";
import { memoryErrorMessage } from "../../local-memory/errors";
import { localMemorySessionUnlocked, onLocalMemorySessionChange } from "../../local-memory/storage";
import { useTheme } from "../../theme";
import { nebulaRadii, nebulaSpacing, nebulaTouch } from "./tokens";
import { NebulaAction } from "./components";

type NoteStatus = "active" | "archived" | "trashed";
const PAGE_SIZE = 50;

/** Read-only facet over the existing SQLCipher note payload, not a tag store.
 * Opening a filter never writes or calls LLM; result pages use searchNotes.
 */
export function MemoryTagFacet({ repository, profile, collectionId, status, tag, disabled, onTagChange, onError }: {
  repository: SqliteMemoryRepository | null;
  profile: string; collectionId?: string; status: NoteStatus;
  tag?: string; disabled: boolean;
  onTagChange: (tag: string | undefined) => void;
  onError: (message: string) => void;
}) {
  const t = useTheme();
  const [open, setOpen] = useState(false);
  const [entry, setEntry] = useState("");
  const [choices, setChoices] = useState<string[]>([]);
  const [pageOffset, setPageOffset] = useState(0);
  const [more, setMore] = useState(false);
  const [busy, setBusy] = useState(false);
  const generation = useRef(0);
  const identity = JSON.stringify([profile, collectionId ?? null, status]);
  const identityRef = useRef(identity); identityRef.current = identity;
  const close = () => {
    generation.current++;
    setOpen(false); setBusy(false);
  };
  useEffect(() => {
    // Component is also keyed by profile/collection/status in the library.
    return () => { generation.current++; };
  }, []);
  useEffect(() => onLocalMemorySessionChange(unlocked => {
    if (!unlocked) { generation.current++; setOpen(false); setBusy(false); setChoices([]); setEntry(""); }
  }), []);

  async function load(offset: number) {
    if (!repository || disabled || !localMemorySessionUnlocked()) return;
    const request = ++generation.current, scope = identityRef.current;
    setBusy(true);
    try {
      const batch = await repository.listNoteTags({ collectionId, status }, PAGE_SIZE, offset);
      if (request !== generation.current || scope !== identityRef.current || !localMemorySessionUnlocked()) return;
      setChoices(previous => offset ? [...new Set([...previous, ...batch])] : batch);
      setPageOffset(offset + PAGE_SIZE);
      setMore(batch.length === PAGE_SIZE);
    } catch (e) {
      if (request === generation.current) onError(memoryErrorMessage(e));
    } finally {
      if (request === generation.current) setBusy(false);
    }
  }
  function choose(value: string) {
    if (disabled || !localMemorySessionUnlocked()) return;
    try {
      const labels = parseNoteTagsInput(value);
      if (labels.length !== 1) throw new Error("Для фильтра укажите один тег.");
      onTagChange(labels[0]);
      close();
    } catch (e) { onError((e as Error).message); }
  }
  return <>
    <View style={{ flexDirection:"row", flexWrap:"wrap", alignItems:"center", gap:nebulaSpacing.sm }}>
      <NebulaAction icon="tag" label={tag ? "#" + tag : "Теги"} size="compact"
        accessibilityLabel="Фильтр по тегу" disabled={disabled}
        onPress={() => {
          if (disabled || !repository || !localMemorySessionUnlocked()) return;
          setEntry(""); setChoices([]); setMore(false); setOpen(true); void load(0);
        }} />
      {tag ? <NebulaAction icon="x" label="Сбросить тег" size="compact"
        accessibilityLabel="Сбросить фильтр тега" disabled={disabled}
        onPress={() => onTagChange(undefined)} /> : null}
    </View>
    <BottomSheet visible={open} title="Фильтр по тегу" onClose={close}>
      <Text style={{ color:t.muted }}>
        Только заметки с выбранным тегом. Текстовый поиск, раздел и статус сохраняются; в интернет ничего не отправляется.
      </Text>
      <TextInput accessibilityLabel="Ввести тег для фильтра" value={entry} onChangeText={setEntry}
        maxLength={34} editable={!disabled} placeholder="Например, авто"
        placeholderTextColor={t.muted}
        style={{ color:t.text, borderColor:t.line, borderWidth:1, borderRadius:nebulaRadii.field,
          minHeight:nebulaTouch.minimum, paddingHorizontal:nebulaSpacing.md }} />
      <NebulaAction icon="check" label="Применить тег" size="compact"
        disabled={disabled || !entry.trim()} onPress={() => choose(entry)} />
      {choices.length ? <Text style={{color:t.muted,fontSize:12}}>Существующие теги:</Text> :
        !busy ? <Text style={{color:t.muted,fontSize:12}}>Тегов пока нет в этом разделе и статусе. Можно ввести тег вручную.</Text> : null}
      <ScrollView nestedScrollEnabled keyboardShouldPersistTaps="handled" style={{maxHeight:232}}>
        <View style={{flexDirection:"row",flexWrap:"wrap",gap:nebulaSpacing.sm}}>
          {choices.map(value=><NebulaAction key={value} icon="tag" label={"#"+value}
            accessibilityLabel={"Выбрать тег "+value} size="compact" disabled={disabled}
            onPress={() => choose(value)} />)}
        </View>
      </ScrollView>
      {busy ? <ActivityIndicator accessibilityLabel="Загрузка тегов" /> : null}
      {more && !busy ? <NebulaAction icon="chevron-down" label="Показать ещё теги"
        size="compact" disabled={disabled} onPress={() => void load(pageOffset)} /> : null}
      {tag ? <NebulaAction icon="x" label="Показать без фильтра" size="compact"
        disabled={disabled} onPress={() => { onTagChange(undefined); close(); }} /> : null}
    </BottomSheet>
  </>;
}
