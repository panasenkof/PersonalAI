# №72.3 · T3a — чтение временной истории с источниками и защищённой пагинацией

Статус: кодовый эксперимент поверх T2b/PR #170. Не означает завершение unified retrieval M3, автоматический поиск текущих фактов или UI.

## Контракт
- listTemporalKnowledgeHistory(db,{subjectId,collectionId,mode,limit,before}) только в разблокированной локальной SQLCipher с явно указанными ID и коллекцией.
- mode = all / states / events. Чётко возвращать knowledge/recorded time и отдельно valid time/precision из исходного утверждения; не заменять год точным днём.
- Один source evidence+quote для соответствующего source_record_version; только active источники с совпадающей ревизией и standard collection + standard/inherit sensitivity.
- Не раскрывать private, secret, unclassified ни как содержимое, ни как число скрытых записей. Разрешение на локальный расширенный просмотр этих разделов потребует отдельной UI/ACL политики.
- Keyset cursor по (knowledge_recorded_at DESC, id DESC); до 50 записей, LIMIT+1 и честный nextCursor. Не выдавать OFFSET, не обещать полный поиск без страниц.
- Каждая строка имеет verification=candidate_unconfirmed: в текущей SQLCipher v11 нет завершённого жизненного цикла accepted claims. Даже когда существует approved end, нельзя считать, что все остальные сведения достоверны.
- Не посылать текст в облако и не связывать выведенную цитату с чужим source или timecode.

## C1
- Синтетическая SQLite: сохранение разных событий и состояний, две страницы без дублей, исходные границы precision=year, источники/версии.
- Изменение ревизии, archived/trashed источник, private/unclassified collection, secret entity исключаются до списка и cursor.
- Некорректные лимиты/таймстемпы курсора отклоняются. Реальный Android SQLCipher C2, UI и end-to-end assistant retrieval — отдельно.

## Остаток
T3b: подтверждённые claims, current/history/as-of с противопоставлением knowledge vs valid time, отдельные события, query/count и explainability. №66.4: идентичность/связи человека с аудио. M3: unified retrieval and access policy. M4-UX следует после стабильных M1–M3. C3 только после принятия памяти.