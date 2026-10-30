# C3 · Архитектурная консолидация базовой памяти PersAI (30.10.2026)

> **Исполнительный порядок остаётся только в [PLAN.md §2](../../PLAN.md)**. Этот файл — инвентаризационная карта и критерии отдельных PR шага **6.5**, а не новая очередь, не отдельная модель памяти и не разрешение на глобальную миграцию.

## 0. Основание и согласованная граница

- Последняя ручная полная проверка реальной LLM: [Memory acceptance #41036186493](https://github.com/panasenkof/PersonalAI/actions/runs/41036186493), `main` SHA `cc0858c3ad8b1c973febfcb294f2ff8c02f2aa63`, `deepseek-flash`, **77 диалогов / 79 реплик: 79 PASS, 0 FAIL, 0 ERROR, 183 вызова, unsafe=false**. Параллельная SQL/Jest часть: **348/348 PASS**; оба job success. **Полную live-LLM acceptance считать DONE на этом SHA**, не переносить PASS на непроверенный будущий код.
- Исправления PR #234–#239 уже в `main`; они не отдельный активный этап. Новые платные полные прогоны — только по запросу владельца, не при каждом PR.
- Разделить 79 LLM-реплик и **независимую матрицу 96 инженерных сценариев**. Гейт прогона сообщает **45 PARTIAL_C1 / 51 REVIEW_REQUIRED**, ни один не полный автоматически доказанный C1 E2E; физический C2 не проводился. Старая статическая crosswalk-страница пока содержит **42/54** — несовпадение версий реестра, **не** три новых провала: сверить источник при инвентаризации, не переписывать статусы в PASS.
- По решению владельца от 30.10.2026 **не назначать обязательную ручную кампанию из 96 кейсов и отдельный gate видеоприёмки телефона**. Владелец использует приложение, ошибки разбираются адресно. Сохранять все 96 ID и автоматические регрессии, отмечать C2 `NOT_RUN_PHYSICAL` до фактической проверки. Безусловные гейты безопасности изменений, способных потерять данные или нарушить приватность: миграции SQLCipher/старых копий, restore, CAS/undo, права доступа, originals, hard purge.
- Итог C3: **ровно один канонический источник пользовательских данных, один подтверждённый путь решения по факту/связи, один объединённый маршрут search→authorized read**, любые FTS/vector/summary — только восстанавливаемые проекции. Не создавать второй граф, второй decision queue или параллельный поисковый индекс.

## 1. Исходная инвентаризация по реальному main, без преждевременных выводов

| Область | Фактические точки и таблицы | Текущий статус / вопрос C3 |
| --- | --- | --- |
| Источник записей/версий | `mobile/src/local-memory/repository.ts`: `SqliteMemoryRepository.createEntity/reviseEntity`; `storage.ts`: `memory_entities`, `memory_revisions`, `memory_observations`; `direct-agent/memory.ts`: `saveApprovedNote` | Пользовательская запись имеет единственный SQLCipher authority. Проследить Android Share, UI, agent, edit, batch actions до этого writer; отличить самостоятельные observations от копий фактов. **Ничего пока не удалять.** |
| Время и valid/known-as-of | `temporal-store.ts`, `temporal-decisions.ts`, `temporal-review-inbox.ts`, `temporal-claims.ts`; `memory_temporal_claims/evidence/proposals/decisions` | Проверить применение решения, версии, rewind, источник и undo; не объединять журнал пользовательских решений с кандидатами или событиями только из-за сходства названий. |
| Связи и подтверждения | `relation-evidence.ts`, `relational-proof.ts`, `repository.ts`; `memory_relations`, `memory_relation_evidence`, `memory_review_proposals`, `memory_review_actions` | Убедиться, что proposal не становится фактом без подтверждения, graph один; проверить независимые подтверждения, retraction, ACL, CAS и undo; сопоставить с временным review без нового универсального writer. |
| Идентичность пользователя | `self-identity.ts`, `memory_profile_self`, `localMemoryIdentity` | User-selected pointer к существующему person не является вторым графом; проверить отсутствие угадывания пользователя по имени. |
| Поиск для чата | `direct-agent/memory.ts`: `searchApprovedNotes/readApprovedNote`; `repository.ts`: `searchMemory`; `direct-agent/tool-catalog.ts` | `searchApprovedNotes` — authorized adapter, `searchMemory` — основной retrieval. Сверить все вызовы с UI/agent и snapshot/ACL. |
| Поиск по оригиналам | `source-retrieval.ts`: `list/read/searchApprovedSourceSegments`, `memory_extractions`, `memory_extraction_segments`, extraction FTS | Это может быть **обоснованным специализированным поиском по содержимому оригинала**, а не дублем. Проверить, нужен ли единый router/facade для выдачи доказанного результата и нет ли обхода ACL; не уничтожать source provenance. |
| Производные индексы | `search-index.ts`, `query.ts`, `vectors.ts`, `vector-jobs.ts`; `memory_chunks/aliases/index_terms/search_fts/vectors/vector_models/vector_jobs` | У каждой проекции должны быть source version, инвалидация, rebuild и проверка доступа на выдаче. Наличие нескольких индексов ≠ несколько источников истины; удалять только подтверждённо неиспользуемый путь. |
| Оригиналы и импорт | `extractions.ts`, `storage.ts`: attachments/parts/extractions/shares; функции Share, note UI, attachment viewer | Проверить один путь materialize, SHA частей, текущие permissions и cleanup временного plaintext; не выдавать неизвестные page/time за доказанные. |
| Действия, очистка и UI | `note-actions.ts`, `hygiene.ts`, M4-UX, review/undo UI | Проверить единый versioned apply и возможность исключать элементы из группы; не переносить user-approved данные в фоновые автоматические задачи. |
| Долговечность | `backup.ts`, `storage.ts` schema v17, upgrade/restore, AppLock | Любое удаление/объединение persistent таблицы возможно только после анализа старых версий, миграционного пути, манифеста, encrypted backup restore и rollback. |

Это **первичная карта к проверке**, а не доказательство дублирования. Сначала снять реальные read/write callsites и SQL-пути, затем принимать решения.

### C3-0a · Проверенный маршрут сохранения карточки

- **UI вход:** `mobile/src/screens/MemoryNoteScreen.tsx`, `save`. Ранее карточка последовательно вызывала `reviseEntity`/ `createEntity`, отдельно `setEntityKind`, `setAliases` и `setIndexTerms(source='user')`. Ошибка на позднем шаге оставляла наполовину изменённую карточку: текст уже обновился, но имя — нет, CAS/version и поисковый индекс могли относиться к разным состояниям.
- **Authority:** `memory_entities` (текст, тип, версия), `memory_aliases` (введённые имена) и `memory_index_terms` только для `source='user'` (введённые человеком слова) — **пользовательские долговечные данные**. Их нельзя объявлять одноразовой проекцией или удалять при rebuild. `memory_search_fts`, `memory_chunks`, векторы и `model:*` enrichment — производные, их обновляет/проверяет существующий индексатор.
- **Единый маршрут:** UI передаёт `NoteCardFields` существующему `SqliteMemoryRepository.createEntity/reviseEntity`, который в **той же SQLCipher-транзакции** сохраняет карточку, алиасы, слова пользователя, одну версию/ревизию и вызывает `indexEntity`. Старые публичные `setAliases` / `setIndexTerms` для независимых вызывающих сторон сохранены; новых таблиц, второго writer и общего доменного сервиса нет.
- **Защита:** проверка длины имени/числа имён до записи, CAS ожидаемой версии, транзакционный rollback при ошибке на alias insert, единственный новый record version при смене типа и текста, сохранение private→standard gate и исходного attachment callback. Проверять настоящим SQLite, не fake-ответами SQL.
- **Граница:** это подтверждённый дефект **одного UI save-пути**, а не повод переписывать всю базу. Архивирование карточки по-прежнему отличается от действий в списке: см. следующий малый C3 PR, пока `OPEN`.



## 2. Последовательные небольшие PR

| Шаг | Результат | Критерий завершения |
| --- | --- | --- |
| **C3-0 · Инвентаризация** (этот PR) | Зафиксировать текущий baseline и карту областей; следующий PR дополняет её **конкретными callsites** всех UI/Share/agent/backup/read/restore путей с пометками authority / projection / adapter / legitimate separate concern / unused candidate. Без изменения runtime. | Для каждой пользовательской функции есть точный write→read путь, владелец данных, права, связь с оригиналом, доказательства и последствия отключения; непроверенное явно `UNKNOWN`. |
| **C3-1 · Writer / review / ACL** | Адресно объединять реально дублирующиеся точки применения пользовательского решения. Только reuse/redirect/delete доказанных дубликатов; не создавать «идеальный» новый service layer. | Из разных входов достигается один writer; тесты same-source, CAS, rollback, undo, private→standard race, user rejection. |
| **C3-2 · Search → evidence → original** | Выстроить один пользовательский поисковый контракт, сохранив законные режимы FTS/vector/source/extraction и query rewrite как части pipeline. Исключить обходы ACL/версионирования; адаптеры удалять только при наличии замены. | FTS/vector/source совпадают по контролю доступа и версии; search hit можно авторизованно дочитать и открыть исходник; нет скрытой параллельной выдачи приватного текста. |
| **C3-3 · Проекции, индексы, временный долг** | Удалить только доказанно мёртвые projection/legacy helpers и дублирующие вычисления; оставить необходимые aliases/chunks/jobs, версии и восстановление. | Повторный import/edit/delete/reindex/crash не оставляет stale результат; действующие data не потеряны. |
| **C3-4 · Backup, UI и совместимость** | Сверить фактические транзакции, restore, manifest, старые версии, UI review/hygiene/source и один AppLock. Если schema change реально необходим — отдельный PR с безопасным upgrade/restore. | Старые копии читаются по контракту; encrypted backup/restore, draft/undo/ACL и UI не регрессировали; без реального телефона — C2 `NOT_RUN_PHYSICAL`. |
| **C3-5 · Финиш** | Сопоставить после всех изменений карту с baseline и обновить `PLAN.md`/единственный `ROADMAP_STATUS.md`. | Нет двух активных writer или competing search/graph; все обязательные CI exact HEAD успешны; доказанные потери/утечки исправлены; оставшиеся опции/physical QA явно `DEFERRED`, без бесконечного refactor. |

Каждая следующая техническая правка — один конкретный модуль и один небольшой PR; перед ним **C0-A**, после **C3-B** по `docs/DEVELOPMENT_GATES.md`. Никакой автоматической платной LLM проверки и принудительной полной 96-case ручной кампании. PR с изменениями runtime — положительные/негативные Jest/SQL, TS, стандартный Android/native CI на точном SHA; docs-only — обязательная документная проверка. При невозможности доказать дублирование — **NO CHANGE NEEDED**, а не бесконечный рефакторинг.

### C3-1a · Архив/возврат через единый writer

- **Ранее два маршрута:** `MemoryNoteScreen` → `SqliteMemoryRepository.setEntityStatus` → самостоятельный UPDATE/ревизия без `notes:` batch-токена; `LocalMemoryScreen` и M4 hygiene → `changeNotes(archive|unarchive)` → `memory_revisions` с token → `undoNotes`. Из карточки можно было лишь вручную открыть архив, а единая «Отменить» не получала токен.
- **После консолидации:** прежний публичный `setEntityStatus(id, expectedVersion, active|archived)` является совместимым адаптером к `changeNotes(archive|unarchive)`. Обе кнопки и групповой review попадают в **один SQLCipher CAS writer и тот же `undoNotes`**; `lastNoteOperation` обнаруживает архивирование карточки при возврате в список памяти. Сохранён UI архив/возврат и существующие исходники/история; note history отображает понятные действия вместо UUID token.
- **Без нового сервиса и таблиц:** запись `memory_entities`, история `memory_revisions`, вложения и searchable/vector-derived слои остаются на месте. Переход `active→archived` / `archived→active` строго проверяет исходный статус и record version; на повторном нажатии или при новой редакции — конфликт, а не незаметный перезаписанный факт.
- **Проверки:** тесты настоящего SQLite на единую ревизию/token, возврат из архива, rollback после undo, запрет undo после более поздней правки; C2 физический Android отдельно `NOT_RUN_PHYSICAL`.
- **Оставшийся C3:** журналы временных и relation decisions сохраняются как семантически самостоятельные, их нельзя объединять с архивом только из-за слова «отмена».

## 3. Чего не делаем

1. Не меняем SQLCipher схему «для красоты», не объединяем таблицы фактов, событий, истории и доказательств только из-за родственных имен.
2. Не создаём конкурирующие `MemoryRepository`, decision journal, graph, индекс синонимов или embeddings store.
3. Не объявляем покрытие 96-case полным на основании 79/79 live LLM; не требуем 96 ручных демонстраций от владельца.
4. Не подменяем пользовательское использование приложения утверждением, что C2 уже прошёл; не запускаем дорогие или разрушающие испытания на личной базе.
5. Не блокируем начало C3 optional relative-chat resolver, native photo search, фоновыми напоминаниями, semantic auto-hygiene и 2+ GiB scale-benchmark без доказанного дефекта безопасности или потери данных.

**Смысл консолидации:** сохранить достигнутую корректность и сделать код проще только там, где это подтверждено фактическими путями исполнения и тестами.
