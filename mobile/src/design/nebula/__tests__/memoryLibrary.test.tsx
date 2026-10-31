import React from "react";
import { fireEvent, render } from "@testing-library/react-native";
import type { EntityRecord } from "../../../local-memory/types";
import { MemoryNoteCard } from "../MemoryNoteCard";
import { memoryNoteDate, memoryNotePreview } from "../memoryNotePresentation";
import { readFileSync } from "node:fs";
import { join } from "node:path";

jest.mock("@expo/vector-icons/Feather", () => () => null);
jest.mock("../../../theme", () => ({
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
    expect(view.getByText("Мой длинный текст заметки").props.numberOfLines).toBe(3);
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
      "Раздел ", "Открыть архив", "Открыть текущие записи", "Открыть корзину",
      "Резервные копии", "Выбрать записи", "Новый раздел памяти"]) {
      expect(home).toContain(label);
    }
    expect(home).toContain("MemoryNoteCard");
    expect(home).toContain('testID="memory-note-list"');
    expect(home).toContain("selectedIds.length");
    expect(home).toContain('void act("restore")');
    expect(home).toContain('void act("merge")');
    expect(home).toContain('void act("trash")');
    expect(home).toContain("undoNotes(undo)");
  });
});

test("overflow is a separate accessible action and never opens the note", () => {
 const open = jest.fn(), select = jest.fn(), menu = jest.fn();
 const v = render(<MemoryNoteCard note={note()} selected={false} sectionName="Заметки" onOpen={open} onToggleSelection={select} onActions={menu} />);
 fireEvent.press(v.getByLabelText("Действия с заметкой " + note().title));
 expect(menu).toHaveBeenCalledTimes(1); expect(open).not.toHaveBeenCalled(); expect(select).not.toHaveBeenCalled();
});
