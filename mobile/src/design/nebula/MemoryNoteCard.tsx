import React from "react";
import { Pressable, Text, View } from "react-native";
import Feather from "@expo/vector-icons/Feather";
import type { EntityRecord } from "../../local-memory/types";
import { useTheme } from "../../theme";
import { nebulaRadii, nebulaSpacing } from "./tokens";
import { memoryDisplayTitle, memoryNoteDate, memoryNotePreview, memoryNoteType } from "./memoryNotePresentation";

/** The library card is display-only: selection, long-press and navigation
 * remain under the owning Memory screen. No persistence or LLM calls here. */
export function MemoryNoteCard({ note, sectionName, selected, selecting = false, onOpen, onToggleSelection, onActions, cover, grid = false }: {
  cover?: React.ReactNode;
  grid?: boolean;
  note: EntityRecord;
  sectionName: string;
  selected: boolean;
  selecting?: boolean;
  onActions?: () => void;
  onOpen: () => void;
  onToggleSelection: () => void;
}) {
  const t = useTheme();
  const type = memoryNoteType(note);
  const title = memoryDisplayTitle(note);
  const preview = memoryNotePreview(note);
  const excerpt = preview === title ? "" : preview.startsWith(title + " ") ? preview.slice(title.length).trim() : preview;
  const date = memoryNoteDate(note.updated_at);
  return <View style={{ position: "relative" }}><Pressable testID={"memory-note-" + note.id}
    accessibilityRole={selecting ? "checkbox" : "button"} accessibilityLabel={(selecting ? "Выбрать заметку " : "Открыть заметку ") + title}
    accessibilityState={{ selected, ...(selecting ? { checked: selected } : {}) }} accessibilityHint={selecting ? "Нажмите, чтобы изменить выбор" : "Нажмите для открытия, удерживайте для выбора"}
    onLongPress={onToggleSelection} onPress={selected ? onToggleSelection : onOpen}
    style={({ pressed }) => ({
      borderWidth: 1, borderColor: selected ? t.accent : t.line,
      borderRadius: nebulaRadii.card, backgroundColor: pressed ? t.soft : t.panel,
      overflow: "hidden", minHeight: grid ? 164 : 88,
    })}>
    <View style={{ minHeight: 48, paddingHorizontal: nebulaSpacing.sm, flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
      <Feather name={type.icon} size={22} color={t.secondary} />
      {selecting ? <Feather name={selected ? "check-square" : "square"} size={22} color={t.secondary} /> : null}
    </View>
    {cover}
    <View style={{ padding: nebulaSpacing.sm, gap: nebulaSpacing.xs }}>
    {grid ? <>
      <Text numberOfLines={3} style={{ color: t.text, fontWeight: "700", fontSize: 16, lineHeight: 23 }}>{title}</Text>
    </> : <View style={{ flexDirection: "row", alignItems: "flex-start", gap: nebulaSpacing.xs }}>
      <Text numberOfLines={2} style={{ flex: 1, minWidth: 0, color: t.text, fontWeight: "700", fontSize: 16, lineHeight: 23 }}>{title}</Text>
      <Feather name="chevron-right" size={18} color={t.muted} />
    </View>}
    {type.label !== "Заметка" && type.label !== "Предпочтение" ? <Text style={{ color: t.secondary, fontSize: 13, lineHeight: 20 }}>{type.label}</Text> : null}
    {excerpt ? <Text numberOfLines={3} style={{ color: t.muted, fontSize: 14, lineHeight: 20 }}>{excerpt}</Text> : null}
    <Text numberOfLines={2} style={{ color: t.muted, fontSize: 13, lineHeight: 20 }}>{sectionName}</Text>
    {date ? <Text style={{ color: t.muted, fontSize: 13, lineHeight: 20 }}>{date}</Text> : null}
    </View>
  </Pressable>
    {!selecting && onActions ? <Pressable accessibilityRole="button" accessibilityLabel={"Действия с заметкой " + title} onPress={onActions}
      style={{ position: "absolute", top: 0, right: 0, minHeight: 48, minWidth: 48, alignItems: "center", justifyContent: "center" }}><Feather name="more-vertical" size={22} color={t.secondary} /></Pressable> : null}
  </View>;
}
