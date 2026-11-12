import { memoryErrorMessage } from "../errors";

describe("QA-9 DEF-6 safe, actionable recovery diagnostics", () => {
  test.each([
    ["backup_wrong_key_or_corrupt", "проверьте код восстановления и целостность файла"],
    ["invalid_backup_size", "некорректный размер"],
    ["backup_source_size_mismatch", "неполным"],
    ["backup_restore_detach_failed", "Проверьте записи и настройки"],
  ])("%s presents a localized recovery action", (code, expected) => {
    expect(memoryErrorMessage(new Error(code))).toContain(expected);
  });

  test("a native SQLCipher exception never reveals file paths or key fragments", () => {
    const nativeError = new Error("SQLITE_NOTADB on /data/private/backup.db with key 1234");
    const text = memoryErrorMessage(nativeError);
    expect(text).not.toContain("/data/private/");
    expect(text).not.toContain("1234");
    expect(text).toContain("Не удалось выполнить операцию");
  });
});
