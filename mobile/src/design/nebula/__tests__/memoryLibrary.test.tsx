import React from "react";
import { fireEvent, render } from "@testing-library/react-native";
import { Text } from "react-native";
import type { EntityRecord } from "../../../local-memory/types";
import { MemoryNoteCard } from "../MemoryNoteCard";
import { memoryNoteDate, memoryNotePreview } from "../memoryNotePresentation";
import { readFileSync } from "node:fs";
import { join } from "node:path";

jest.mock("@expo/vector-icons/Feather", () => () => null);
jest.mock("../../../theme", () => ({
  useNebulaColors: () => ({
    text: "#ffffff", textOnAccent: "#ffffff", border: "#445574", accent: "#7051db",
    danger: "#ff9faf", surfaceElevated: "#1d2e51",
  }),
  useTheme: () => ({
    bg: "#070d20", panel: "#14213d", soft: "#26395c", line: "#445574",
    text: "#ffffff", muted: "#abbad8", accent: "#7051db",
  }),
}));

const note = (payload: Record<string, unknown> = { body: "Мой длинный текст заметки" }): EntityRecord => ({
  id: "a", title: "Очень длинное название заметки на русском языке для проверки читаемости",
  updated_at: "2026-10-22T15:30:00Z", collection_id: "notes", payload,
} as unknown as EntityRecord);

describe("U2 Memory library note presentation", () => {
  it("keeps the full note in storage but cleans whitespace for a readable preview", () => {
    const item = note({ body: "Первый абзац\n\n   Второй   абзац" });
    expect(memoryNotePreview(item)).toBe("Первый абзац Второй абзац");
    expect(item.payload.body).toContain("\n");
    expect(memoryNotePreview(note({ body: "", extracted_text: "Текст из фото\nстрока" }))).toBe("Текст из фото строка");
    expect(memoryNotePreview(note({ body: null, extracted_text: null }))).toBe("");
    expect(memoryNoteDate("not-a-date")).toBe("");
  });
  it("opens a note on press and selects it on long press", () => {
    const onOpen = jest.fn(), onToggleSelection = jest.fn();
    const view = render(<MemoryNoteCard note={note()} selected={false}
      sectionName="Рецепты" onOpen={onOpen} onToggleSelection={onToggleSelection} />);
    const button = view.getByLabelText("Открыть заметку " + note().title);
    expect(button.props.accessibilityState.selected).toBe(false);
    fireEvent.press(button);
    fireEvent(button, "longPress");
    expect(onOpen).toHaveBeenCalledTimes(1);
    expect(onToggleSelection).toHaveBeenCalledTimes(1);
    expect(view.getByText(note().title || "Без названия").props.numberOfLines).toBe(2);
    expect(view.getByText("Мой длинный текст заметки").props.numberOfLines).toBe(1);
    expect(view.getByText(/^Рецепты · /).props.numberOfLines).toBe(1);
  });
  it("keeps tiled previews compact while retaining the full underlying note", () => {
    const view = render(<MemoryNoteCard note={note()} grid selected={false}
      sectionName="Рецепты" onOpen={jest.fn()} onToggleSelection={jest.fn()}
      cover={<Text testID="library-cover">Фото</Text>} />);
    expect(view.getByTestId("library-cover")).toBeTruthy();
    expect(view.getByText(note().title || "Без названия").props.numberOfLines).toBe(2);
    expect(view.getByText(/^Рецепты · /).props.numberOfLines).toBe(1);
    expect(view.queryByText("Мой длинный текст заметки")).toBeNull();
    const inside = render(<MemoryNoteCard note={note()} selected={false}
      sectionName="" onOpen={jest.fn()} onToggleSelection={jest.fn()} />);
    expect(inside.queryByText(/^Рецепты · /)).toBeNull();
  });
  it("toggles selected cards without opening their editor", () => {
    const onOpen = jest.fn(), onToggleSelection = jest.fn();
    const view = render(<MemoryNoteCard note={note()} selected
      sectionName="Заметки" onOpen={onOpen} onToggleSelection={onToggleSelection} />);
    fireEvent.press(view.getByLabelText("Открыть заметку " + note().title));
    expect(onToggleSelection).toHaveBeenCalledTimes(1);
    expect(onOpen).not.toHaveBeenCalled();
  });
  it("retains the operations that existing browser/native flows require", () => {
    const home = readFileSync(join(__dirname, "..", "..", "..", "screens", "LocalMemoryScreen.tsx"), "utf8");
    for (const label of ["Текст или голос", "Добавить в память", "Поиск по заметкам",
      "Раздел ", "Открыть архив", "Открыть корзину",
      "Выбрать записи", "Новый раздел памяти"]) {
      expect(home).toContain(label);
    }
    // Backups are reached from Settings only, not duplicated in the memory overflow.
    const settings = readFileSync(join(__dirname, "..", "..", "..", "screens", "DeviceSettingsScreen.tsx"), "utf8");
    expect(home).not.toContain('accessibilityLabel="Резервные копии"');
    expect(settings).toContain('title="Резервные копии"');
    expect(home).toContain("MemoryNoteCard");
    expect(home).toContain('testID="memory-note-list"');
    expect(home).toContain("selectedIds.length");
    expect(home).toContain('void act("restore")');
    expect(home).toContain('void act("merge")');
    expect(home).toContain('void act("trash")');
    expect(home).toContain("undoNotes(undo)");
  });
});

test("trashed card shows a labelled restore button next to the record without opening it", () => {
 const open = jest.fn(), select = jest.fn(), restore = jest.fn();
 const v = render(<MemoryNoteCard note={note()} selected={false} sectionName="Заметки"
   onOpen={open} onToggleSelection={select} onRestore={restore} />);
 const action = v.getByLabelText("Восстановить заметку " + note().title);
 expect(action.props.accessibilityState.disabled).toBe(false);
 fireEvent.press(action);
 expect(restore).toHaveBeenCalledTimes(1);
 expect(open).not.toHaveBeenCalled();
 expect(select).not.toHaveBeenCalled();
 v.rerender(<MemoryNoteCard note={note()} selected={false} selecting sectionName="Заметки"
   onOpen={open} onToggleSelection={select} onRestore={restore} />);
 expect(v.queryByLabelText("Восстановить заметку " + note().title)).toBeNull();
});
test("memory tiles reserve the same preview footprint with or without an encrypted image", () => {
 const open = jest.fn(), select = jest.fn();
 const image = render(<MemoryNoteCard note={note({ source_file: "photo.jpg", source_media: "image" })}
   grid selected={false} sectionName="Рецепты" onOpen={open} onToggleSelection={select}
   cover={<Text testID="grid-image-cover">Показываю фото</Text>} />);
 const imageSlot = image.getByTestId("memory-grid-media-slot");
 expect(imageSlot.props.style.height).toBe(108);
 expect(image.getByTestId("grid-image-cover")).toBeTruthy();
 expect(image.queryByText("Мой длинный текст заметки")).toBeNull();
 const textTile = render(<MemoryNoteCard note={note()} grid selected={false}
   sectionName="Рецепты" onOpen={open} onToggleSelection={select} />);
 expect(textTile.getByTestId("memory-grid-media-slot").props.style.height)
   .toBe(imageSlot.props.style.height);
 expect(textTile.getByText("Мой длинный текст заметки").props.numberOfLines).toBe(2);
 expect(textTile.getByText(note().title).props.numberOfLines).toBe(2);
});

test("tapping an unselected note in selection mode checks it without opening it", () => {
 const open = jest.fn(), select = jest.fn(), menu = jest.fn();
 const ui = render(<MemoryNoteCard note={note()} selecting selected={false}
   sectionName="Рецепты" onOpen={open} onToggleSelection={select} onActions={menu} />);
 const card = ui.getByLabelText("Выбрать заметку " + note().title);
 expect(card.props.accessibilityState.checked).toBe(false);
 fireEvent.press(card);
 expect(select).toHaveBeenCalledTimes(1);
 expect(open).not.toHaveBeenCalled();
 expect(ui.queryByLabelText("Действия с заметкой " + note().title)).toBeNull();
});

test("overflow is a separate accessible action and never opens the note", () => {
 const open = jest.fn(), select = jest.fn(), menu = jest.fn();
 const v = render(<MemoryNoteCard note={note()} selected={false} sectionName="Заметки" onOpen={open} onToggleSelection={select} onActions={menu} />);
 fireEvent.press(v.getByLabelText("Действия с заметкой " + note().title));
 expect(menu).toHaveBeenCalledTimes(1); expect(open).not.toHaveBeenCalled(); expect(select).not.toHaveBeenCalled();
});
