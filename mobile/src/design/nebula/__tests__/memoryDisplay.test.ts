import { memoryDisplayTitle, memoryNotePreview, memoryNoteHasPhoto } from "../memoryNotePresentation";
test("filenames yield to a caption without changing stored metadata", () => {
 const note = { title: "record.m4a", payload: { source_file: "record.m4a", body: "Разговор с Лизой\nПланы" } };
 expect(memoryDisplayTitle(note)).toBe("Разговор с Лизой"); expect(note.title).toBe("record.m4a");
 expect(memoryDisplayTitle({ ...note, title: "Мой заголовок" })).toBe("Мой заголовок");
});
test("excerpts render plain markdown and retain meaningful underscores", () => {
 expect(memoryNotePreview({ payload: { body: "# Рецепт\n- **Рыба**\n- [Источник](https://example.com)\n`file_name`" } })).toBe("Рецепт Рыба Источник file_name");
});

test("generic OCR headings and camera filenames do not become the useful title", () => {
 expect(memoryDisplayTitle({ title: "1000038724.jpg", payload: { source_file: "1000038724.jpg", extracted_text: "# Распознанный текст\nГарантия на холодильник" } })).toBe("Гарантия на холодильник");
 expect(memoryDisplayTitle({ title: "IMG_20261024_165134.jpg", payload: { source_file: "IMG_20261024_165134.jpg" } })).toBe("Фото");
});

test("legacy single and appended photo notes show image tiles without inventing a saved title", () => {
 const legacy = { title: "IMG_20261024_165134.jpg", payload: { source_file: "IMG_20261024_165134.jpg" } };
 expect(memoryNoteHasPhoto(legacy)).toBe(true);
 expect(memoryDisplayTitle(legacy)).toBe("Фото");
 expect(memoryDisplayTitle({ ...legacy, title: "Фото без подписи" })).toBe("Фото");
 expect(memoryNoteHasPhoto({ payload: { source_file: "notes.pdf", source_files: ["notes.pdf", "1000039427.jpg"] } })).toBe(true);
 expect(memoryNoteHasPhoto({ payload: { source_file: "notes.pdf", source_media_types: ["document", "image"] } })).toBe(true);
 expect(memoryNoteHasPhoto({ payload: { source_file: "notes.pdf", source_media: "document" } })).toBe(false);
 expect(memoryDisplayTitle({ title: "Обувь", payload: { source_file: "1000039427.jpg" } })).toBe("Обувь");
});
