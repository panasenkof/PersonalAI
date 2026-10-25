import React from "react";
import { Pressable, Text, View } from "react-native";
import Feather from "@expo/vector-icons/Feather";
import type { EntityRecord } from "../../local-memory/types";
import { useTheme } from "../../theme";
import { nebulaRadii, nebulaSpacing } from "./tokens";
import { memoryDisplayTitle, memoryNoteDate, memoryNotePreview, memoryNoteType } from "./memoryNotePresentation";

/** The library card is display-only: selection, long-press and navigation
 * remain under the owning Memory screen. No persistence or LLM calls here. */
export function MemoryNoteCard({ note, sectionName, selected, onOpen, onToggleSelection, cover, grid = false }: {
  cover?: React.ReactNode;
  grid?: boolean;
  note: EntityRecord;
  sectionName: string;
  selected: boolean;
  onOpen: () => void;
  onToggleSelection: () => void;
}) {
  const t = useTheme();
  const type = memoryNoteType(note);
  const title = memoryDisplayTitle(note);
  const preview = memoryNotePreview(note);
  const excerpt = preview === title ? "" : preview.startsWith(title + " ") ? preview.slice(title.length).trim() : preview;
  const date = memoryNoteDate(note.updated_at);
  return <Pressable testID={"memory-note-" + note.id}
    accessibilityRole="button" accessibilityLabel={"Открыть заметку " + title}
    accessibilityState={{ selected }} accessibilityHint="Нажмите для открытия, удерживайте для выбора"
    onLongPress={onToggleSelection} onPress={selected ? onToggleSelection : onOpen}
    style={({ pressed }) => ({
      borderWidth: 1, borderColor: selected ? t.accent : t.line,
      borderRadius: nebulaRadii.card, backgroundColor: pressed ? t.soft : t.panel,
      overflow: "hidden", minHeight: grid ? 164 : 88, flex: 1,
    })}>
    {cover}
    <View style={{ padding: nebulaSpacing.sm, gap: nebulaSpacing.xs, flex: 1 }}>
    {grid ? <>
      {!cover || selected ? <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
        <Feather name={type.icon} size={22} color={t.secondary} />
        {selected ? <Feather name="check-square" size={22} color={t.secondary} /> : null}
      </View> : null}
      <Text numberOfLines={3} style={{ color: t.text, fontWeight: "700", fontSize: 16, lineHeight: 23 }}>{title}</Text>
    </> : <View style={{ flexDirection: "row", alignItems: "flex-start", gap: nebulaSpacing.xs }}>
      <View accessible={false} style={{ padding: nebulaSpacing.xs, borderRadius: nebulaRadii.chip, backgroundColor: t.soft }}><Feather name={type.icon} size={20} color={t.secondary} /></View>
      {selected ? <Feather name="check-square" size={20} color={t.secondary} /> : null}
      <Text numberOfLines={2} style={{ flex: 1, minWidth: 0, color: t.text, fontWeight: "700", fontSize: 16, lineHeight: 23 }}>{title}</Text>
      <Feather name="chevron-right" size={18} color={t.muted} />
    </View>}
    {type.label !== "Заметка" && type.label !== "Предпочтение" ? <Text style={{ color: t.secondary, fontSize: 13, lineHeight: 20 }}>{type.label}</Text> : null}
    {excerpt ? <Text numberOfLines={3} style={{ color: t.muted, fontSize: 14, lineHeight: 20 }}>{excerpt}</Text> : null}
    <Text numberOfLines={2} style={{ color: t.muted, fontSize: 13, lineHeight: 20 }}>{sectionName}</Text>
    {date ? <Text style={{ color: t.muted, fontSize: 13, lineHeight: 20 }}>{date}</Text> : null}
    </View>
  </Pressable>;
}
