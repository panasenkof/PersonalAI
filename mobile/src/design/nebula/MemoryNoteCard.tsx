import React from "react";
import { Pressable, Text, View } from "react-native";
import Feather from "@expo/vector-icons/Feather";
import type { EntityRecord } from "../../local-memory/types";
import { useTheme } from "../../theme";
import { nebulaRadii, nebulaSpacing, nebulaTouch } from "./tokens";
import { memoryNoteDate, memoryNotePreview } from "./memoryNotePresentation";

/** The library card is display-only: selection, long-press and navigation
 * remain under the owning Memory screen. No persistence or LLM calls here. */
export function MemoryNoteCard({ note, sectionName, selected, onOpen, onToggleSelection }: {
  note: EntityRecord;
  sectionName: string;
  selected: boolean;
  onOpen: () => void;
  onToggleSelection: () => void;
}) {
  const t = useTheme();
  const preview = memoryNotePreview(note);
  const date = memoryNoteDate(note.updated_at);
  return <Pressable testID={"memory-note-" + note.id}
    accessibilityRole="button" accessibilityLabel={"Открыть заметку " + (note.title || "Без названия")}
    accessibilityState={{ selected }} accessibilityHint="Нажмите для открытия, удерживайте для выбора"
    onLongPress={onToggleSelection} onPress={selected ? onToggleSelection : onOpen}
    style={({ pressed }) => ({
      borderWidth: 1, borderColor: selected ? t.accent : t.line,
      borderRadius: nebulaRadii.card, backgroundColor: pressed ? t.soft : t.panel,
      padding: nebulaSpacing.md, gap: nebulaSpacing.xs, minHeight: 88,
    })}>
    <View style={{ flexDirection: "row", alignItems: "flex-start", gap: nebulaSpacing.xs }}>
      {selected ? <Feather name="check-square" size={20} color={t.accent} style={{ marginTop: 3 }} /> : null}
      <Text numberOfLines={2} style={{ flex: 1, minWidth: 0, color: t.text, fontWeight: "700", fontSize: 16, lineHeight: 23 }}>
        {note.title || "Без названия"}
      </Text>
      <Feather name="chevron-right" size={18} color={t.muted} />
    </View>
    {preview ? <Text numberOfLines={3} style={{ color: t.muted, fontSize: 14, lineHeight: 20 }}>{preview}</Text> : null}
    <Text numberOfLines={1} style={{ color: t.muted, fontSize: 12, lineHeight: 18 }}>
      {sectionName}{date ? " · " + date : ""}
    </Text>
  </Pressable>;
}
