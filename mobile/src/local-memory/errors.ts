/** Native SQLite exceptions may contain SQL/parameters; never show key-bearing
 * error strings in UI. Preserve actionable messages authored by this app.
 */
export function memoryErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  const known: Record<string, string> = {
    application_locked: "Для доступа войдите в приложение.",
    hygiene_review_changed_repeat_preview: "Записи, доступ или правила сохранения изменились. Проверьте группу заново — ничего не изменено.",
    memory_source_not_available_or_stale: "Источник изменён или недоступен. Повторите поиск.",
    local_memory_unlock_failed: "Ключ существующей памяти недоступен. Исходная база сохранена; не удаляйте приложение.",
    sqlcipher_required_native_build: "Для шифрованной памяти нужна нативная сборка с SQLCipher. Expo Go не подходит.",
    local_memory_schema_too_new: "Память создана более новой версией приложения. Обновите PersAI.",
    invalid_local_memory_key: "Не удалось прочитать ключ памяти. Исходные данные сохранены.",
    secure_storage_unavailable: "Защищённое хранилище телефона недоступно. Повторите вход в приложение.",
  };
  if (known[message]) return known[message];
  if (/^[А-Яа-яЁё]/u.test(message) && !/[a-f0-9]{64}/i.test(message) && message.length <= 500) return message;
  return "Не удалось выполнить операцию с памятью. Повторите открытие или перезапустите приложение.";
}
