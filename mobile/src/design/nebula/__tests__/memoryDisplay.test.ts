import { memoryDisplayTitle, memoryNotePreview } from "../memoryNotePresentation";
test("filenames yield to a caption without changing stored metadata", () => {
 const note = { title: "record.m4a", payload: { source_file: "record.m4a", body: "Разговор с Лизой\nПланы" } };
 expect(memoryDisplayTitle(note)).toBe("Разговор с Лизой"); expect(note.title).toBe("record.m4a");
 expect(memoryDisplayTitle({ ...note, title: "Мой заголовок" })).toBe("Мой заголовок");
});
test("excerpts render plain markdown and retain meaningful underscores", () => {
 expect(memoryNotePreview({ payload: { body: "# Рецепт\n- **Рыба**\n- [Источник](https://example.com)\n`file_name`" } })).toBe("Рецепт Рыба Источник file_name");
});
