/** Native SQLite exceptions may contain SQL/parameters; never show key-bearing
 * error strings in UI. Preserve actionable messages authored by this app.
 */
export function memoryErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  const known: Record<string, string> = {
    application_locked: "Для доступа войдите в приложение.",
    section_parent_unavailable: "Родительский раздел отсутствует или недоступен помощнику.",
    section_parent_changed: "Родительский раздел изменился. Создайте предложение заново.",
    section_sibling_name_exists: "В этой папке уже есть раздел с таким названием.",
    collection_sibling_name_exists: "В этой папке уже есть раздел с таким названием.",
    section_delete_protected_or_missing: "Этот раздел недоступен для удаления помощником.",
    collection_delete_protected: "Нельзя удалять системный, защищённый или недоступный подраздел.",
    section_has_children: "Сначала переместите или удалите вложенные подразделы.",
    section_not_empty: "В разделе есть записи. Удаление не выполнено.",
    collection_not_empty: "В разделе остались записи или подразделы. Удаление не выполнено.",
    stale_collection: "Раздел изменился после подготовки предложения. Проверьте его ещё раз.",
    collection_cycle: "Нельзя переместить раздел внутрь самого себя или своего потомка.",

    vision_model_not_installed: "Чтобы искать фотографии, сначала скачайте и выберите модель EmbeddingGemma 2 в настройках.",
    vision_invalid_query_image: "Выберите JPEG, PNG или WebP из файлов телефона. HEIC пока не поддерживается.",
    vision_query_image_size: "Фотография пуста или превышает 80 МБ. Выберите файл меньшего размера.",
    vision_query_cancelled: "Поиск похожих фотографий остановлен.",
    vision_camera_permission_denied: "Разрешите доступ к камере, чтобы сфотографировать предмет для поиска.",
    vision_query_one_image: "Для поиска похожих фотографий прикрепите один снимок.",
    vision_model_changed: "Выбранная модель изменилась во время поиска. Повторите запрос.",
    vision_native_unavailable: "В установленной версии PersAI недоступен модуль поиска фотографий. Установите актуальное обновление.",
    vision_model_checksum_mismatch: "Файл модели повреждён. Удалите его в настройках и скачайте заново.",
    hygiene_review_changed_repeat_preview: "Записи, доступ или правила сохранения изменились. Проверьте группу заново — ничего не изменено.",
    merge_only_notes: "Объединить можно только заметки. Выберите записи типа «Заметка».",
    merge_source_has_links_review_required: "У выбранной записи есть связанные сведения, имена, ручные поисковые слова или защитная отметка. Чтобы их не скрыть, объединение отклонено без изменений. Проверьте источник отдельно.",
    merge_too_many_tags_review_required: "У выбранных записей вместе более 12 разных тегов. Сократите теги перед объединением, чтобы не потерять ни один.",
    merge_undo_source_changed: "Вложения или отметки ранее импортированных материалов изменились после объединения. Отмена заблокирована, чтобы не потерять оригиналы. Проверьте записи заново.",
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
