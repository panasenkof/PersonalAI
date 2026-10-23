import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("Android viewport regressions from real device recordings", () => {
  const root = join(__dirname, "..", "..", "..");
  const home = readFileSync(join(root, "screens", "HomeScreen.tsx"), "utf8");
  const note = readFileSync(join(root, "screens", "MemoryNoteScreen.tsx"), "utf8");
  const smoke = readFileSync(join(root, "..", ".maestro", "flows", "smoke.yaml"), "utf8");

  it("keeps the composer available and prevents native stream offsets disabling follow", () => {
    expect(home).toContain("onScrollBeginDrag={() => {");
    expect(home).toContain("if (busy && nearChatBottom.current) return;");
    expect(home).toContain("pendingSendFollow.current = true;");
    expect(home).toContain("scheduleBottomFollow()");
  });
  it("pins Save outside the scrolling note form even with the Android IME", () => {
    const endScroll = note.indexOf("</ScrollView>");
    const saveButton = note.indexOf('accessibilityLabel="Сохранить запись"');
    expect(saveButton).toBeGreaterThan(endScroll);
    expect(note).toContain("Keyboard.dismiss(); void save();");
    expect(smoke).toContain('- assertVisible: "Сохранить запись"');
    expect(smoke).not.toContain('element: "Сохранить запись"');
  });
  it("uses stable accessibility labels for both note edit steps", () => {
    expect(note).toContain('accessibilityLabel="Текст заметки"');
    expect(smoke.match(/element: "Текст заметки"/g)).toHaveLength(2);
    expect(smoke.match(/- tapOn: "Текст заметки"/g)).toHaveLength(2);
    expect(smoke).not.toContain('element: "Persisted offline content"');
    expect(smoke).not.toContain('element: "Что нужно запомнить?"');
    expect(smoke).toContain('timeout: 15000');
  });

});
