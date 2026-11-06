import React from "react";
import { Pressable, Text, View } from "react-native";
import Feather from "@expo/vector-icons/Feather";
import type { EntityRecord } from "../../local-memory/types";
import { useTheme } from "../../theme";
import { nebulaRadii, nebulaSpacing, nebulaTouch } from "./tokens";
import { NebulaAction } from "./components";
import { memoryDisplayTitle, memoryNoteDate, memoryNotePreview, memoryNoteType } from "./memoryNotePresentation";
import { MemoryTypeIcon } from "./MemoryTypeIcon";

/** Shared with the FlatList cover: tiles keep identical footprints during thumbnail decoding. */
export const MEMORY_GRID_MEDIA_HEIGHT = 108;

/** Presentation only: selection, navigation and versioned operations are owned by LocalMemoryScreen.
 * A list row never expands just to repeat full source/type/date metadata. */
export function MemoryNoteCard({ note, sectionName, selected, selecting = false, onOpen, onToggleSelection, onActions, onRestore, restoreDisabled = false, cover, grid = false }: {
  cover?: React.ReactNode;
  grid?: boolean;
  note: EntityRecord;
  sectionName: string;
  selected: boolean;
  selecting?: boolean;
  onActions?: () => void;
  onRestore?: () => void;
  restoreDisabled?: boolean;
  onOpen: () => void;
  onToggleSelection: () => void;
}) {
  const t = useTheme();
  const type = memoryNoteType(note);
  const title = memoryDisplayTitle(note);
  const preview = memoryNotePreview(note);
  const excerpt = preview === title ? "" : preview.startsWith(title + " ") ? preview.slice(title.length).trim() : preview;
  const date = memoryNoteDate(note.updated_at);
  // Inside a collection, sectionName is blank and does not get repeated on every row.
  const context = type.label === "Заметка" ? sectionName : type.label;
  // A photo note already says «Фото» in the title; repeating it in meta is noise.
  const meta = [(context && context !== title ? context : ""), date].filter(Boolean).join(" · ");
  const media = cover || <MemoryTypeIcon feather={type.icon} size={28} />;

  return <View style={{ position: "relative" }}>
    <Pressable testID={"memory-note-" + note.id}
      accessibilityRole={selecting ? "checkbox" : "button"} accessibilityLabel={(selecting ? "Выбрать заметку " : "Открыть заметку ") + title}
      accessibilityState={{ selected, ...(selecting ? { checked: selected } : {}) }}
      accessibilityHint={selecting ? "Нажмите, чтобы изменить выбор" : "Нажмите для открытия, удерживайте для выбора"}
      onLongPress={onToggleSelection} onPress={selecting || selected ? onToggleSelection : onOpen}
      style={({ pressed }) => ({
        borderWidth: 1, borderColor: selected ? t.accent : t.line,
        borderRadius: nebulaRadii.card, backgroundColor: pressed ? t.soft : t.panel,
        overflow: "hidden", minHeight: grid ? 172 : 88,
      })}>
      {grid ? <>
        <View testID="memory-grid-media-slot" style={{
          height: MEMORY_GRID_MEDIA_HEIGHT, backgroundColor: t.soft, alignItems: "center",
          justifyContent: "center", overflow: "hidden", gap: 3,
          paddingHorizontal: cover ? 0 : nebulaSpacing.sm,
        }}>
          {media}
          {!cover && excerpt ? <Text numberOfLines={2} style={{
            color: t.muted, fontSize: 12, lineHeight: 16, textAlign: "center",
          }}>{excerpt}</Text> : null}
        </View>
        <View style={{ padding: nebulaSpacing.sm, gap: 4 }}>
          <Text numberOfLines={2} style={{ color: t.text, fontWeight: "700", fontSize: 16, lineHeight: 23 }}>{title}</Text>
          {meta ? <Text numberOfLines={1} style={{ color: t.muted, fontSize: 13, lineHeight: 20 }}>{meta}</Text> : null}
        </View>
      </> : <View style={{ minHeight: 88, flexDirection: "row", alignItems: "center", padding: nebulaSpacing.sm, gap: nebulaSpacing.sm }}>
        <View style={{ width: 56, height: 56, flexShrink: 0, borderRadius: nebulaRadii.chip, backgroundColor: t.soft, alignItems: "center", justifyContent: "center", overflow: "hidden" }}>
          {media}
        </View>
        <View style={{ flex: 1, minWidth: 0, gap: 3, paddingRight: !selecting && onActions ? 44 : 0 }}>
          <Text numberOfLines={2} style={{ color: t.text, fontWeight: "700", fontSize: 16, lineHeight: 22 }}>{title}</Text>
          {excerpt ? <Text numberOfLines={1} style={{ color: t.muted, fontSize: 13, lineHeight: 19 }}>{excerpt}</Text> : null}
          {meta ? <Text numberOfLines={1} style={{ color: t.muted, fontSize: 13, lineHeight: 19 }}>{meta}</Text> : null}
        </View>
      </View>}
    </Pressable>
    {selecting ? <View pointerEvents="none" style={{ position: "absolute", right: 6, top: 6, width: nebulaTouch.minimum, height: nebulaTouch.minimum, alignItems: "center", justifyContent: "center", borderRadius: nebulaRadii.chip, backgroundColor: t.panel }}>
      <Feather name={selected ? "check-square" : "square"} size={23} color={t.secondary} />
    </View> : null}
    {!selecting && onActions ? <Pressable accessibilityRole="button" accessibilityLabel={"Действия с заметкой " + title}
      onPress={onActions} style={{ position: "absolute", top: 6, right: 6, minHeight: nebulaTouch.minimum, minWidth: nebulaTouch.minimum,
        borderRadius: nebulaRadii.chip, borderWidth: 1, borderColor: t.line, backgroundColor: t.panel, alignItems: "center", justifyContent: "center" }}>
      <Feather name="more-vertical" size={22} color={t.secondary} />
    </Pressable> : null}
    {!selecting && onRestore ? <View style={{ marginTop: nebulaSpacing.xs, alignItems: "flex-end" }}>
      <NebulaAction testID={"memory-restore-" + note.id} icon="rotate-ccw" label="Вернуть" size="compact"
        accessibilityLabel={"Восстановить заметку " + title} disabled={restoreDisabled} onPress={onRestore} />
    </View> : null}
  </View>;
}

