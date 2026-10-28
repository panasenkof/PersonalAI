# PersAI: ретроспективная архитектурная сверка PR #166–185 — 28.10.2026

**Основание и границы:** проверен текущий `main` после #185, метаданные и diff PR #166, #168–185; PR #167 относится к отдельно открытой PDF-ветке и **не входит** в слитую цепочку памяти. Сопоставлены `PLAN.md §2`, `ROADMAP_STATUS.md`, `MEMORY_ENGINE_ARCHITECTURE.md`, `TEMPORAL_MEMORY.md`, `RELATIONAL_MEMORY.md`, `MEMORY_C1_C2_ACCEPTANCE_2026-10-27.md`, 96-сценарная матрица, текущие readers/writers/backup и инженерные правила. Проверка аналитическая на фактическом коде; **повторный E2E-прогон, физический Android backup/restore и измерение производительности НЕ выполнялись**. Ранее зелёные CI относятся к SHA каждого PR, не заменяют новые регрессии.

## Ретроспективная матрица (C3; повторная оценка, не новый roadmap)

| PR | Факт / основа | Архитектурная сверка | Остаток / статус |
| --- | --- | --- | --- |
| #166 | Pure temporal candidate contract | Новой БД или независимой истины нет | MATCH; исходники/решения последующих этапов отдельно |
| #168 | SQLCipher v11 claim/evidence/proposal/decision + backup | Типизированные записи в существующей БД, FK и сохранение версий | MATCH для T1b; двухвременная истина и общий review требуют продолжения |
| #169 | Temporal CAS/undo в `memory_temporal_decisions` | Один writer для времени; нет автозакрытия | MATCH для T2a; **F2** существующий отдельный журнал учитывать в R2/C3 |
| #170 | Адресный bounded temporal staging | Никакого глобального N² обхода, источник сохраняется отдельно | MATCH; review зависимости и частичное покрытие |
| #171 | Source-backed temporal history | Keyset + source revision; не подменяет состояние «сейчас» | MATCH; T3b2 ещё не готов |
| #172 | Temporal review inbox + repository lease | Единый профиль и SQLCipher; отложенная UI | MATCH; единое отображение relation+temporal **F2** |
| #173 | Pure relation path evaluator | Не создаёт нового графа | MATCH; требовался persisted witness (#179–181) |
| #174 | 96 сценариев и guards | Больше доменов, чем исходный кейс с Лизой; pure fixture ≠ E2E | MATCH; **F5** оставшиеся нативные и end-to-end проверки |
| #175 | Valid-time candidates | Read-only и без ложной «подтверждённой истины» | MATCH; T3b2 и known-as-of остаются |
| #176 | Первый UI temporal review | Переиспользует прежний temporal repository/CAS, не второй экран памяти | MATCH для первого среза; общий relation UI не готов |
| #177 | Общий ACL guard для temporal решений | Убирает дублирующую проверку eligibility | SIMPLIFIED; держать регрессию на все стадии staging/apply/undo |
| #178 | Approved note namesake guard | Устранено опасное `aliases()[0]`; старое `about` не равно участию | MATCH; **F3** legacy `about` требует явного отображения в модели |
| #179 | Канонический `memory_relations` + `memory_relation_evidence` v12, backup | FK на существующий edge, не второй граф, versioned witness, старые архивы | MATCH; **F5** physical restore |
| #180 | User-only подтверждение с цитатой, версиями, ACL | Повторно использует same edge, не модельное подтверждение | MATCH; до UI нет автоматической приёмки |
| #181 | Bounded relation→participant traversal | Один `CURRENT_PROOF_SQL`, проверка ACL по всем hop | MATCH для read API; **F1** consistency across sequential reads |
| #182 | Option `verifiedRelative` внутри `searchMemory` | Не создал второй search engine; только доказанный путь | MATCH с оговоркой; **F1** путь и ответ не atomic, **F4** фильтр `query` не применён в typed mode и требует явного контракта |
| #183 | Актуализация PLAN/status | Нет runtime/storage duplication | MATCH |
| #184 | v13 immutable `memory_review_actions`, relation retract/undo, backup v4 | Сохраняет канонический witness, проверяет CAS/undo | MATCH для R2a; **F2** temporal journal ещё отдельный; **F5** device restore |
| #185 | История действий из общего журнала | Тот же repository и standard ACL/source-version guard | MATCH; **F1** последовательные проверки ACL/снимка при read |

## Найденные риски, решения и очередность (без второго плана задач)

**F1 · P1 · TOCTOU между доказательством и результатом поиска/истории.** `findCurrentRelativeConversationPaths` делает несколько SQL SELECT; `SqliteMemoryRepository.searchMemory` получает доказательный путь и затем читает возвращаемую заметку/чанк в других SELECT. Источник может сменить приватность, версию или статус **после** proof lookup, но **до** выдачи ответа. Аналогично `listUserRelationReviewHistory` сначала проверяет свидетельство, потом читает журнал. Эти сценарии не доказывают утечку в зафиксированном запуске; это **подтверждённое архитектурное окно гонки**, особенно опасное при выдаче ответа внешней LLM. **Решение:** ближайший небольшой security PR: единый consistent-read SQLCipher transaction или последняя проверка всех witness/notes и source revisions прямо перед возвращением результата; тест моделирует ACL change between reads. После исправления — повторная C1 и Android native, без нового search/API.

**F2 · P1/P2 · два механизма фиксации пользовательских review-решений во время перехода.** `memory_temporal_decisions` и `memory_review_actions` — разные истории; `memory_temporal_proposals` уже очередь. Нельзя называть `memory_review_actions` *единым завершённым* workflow: temporal ещё не перенесён. **Решение:** для R2b использовать один UI review фасад и общую семантику решений, не дублировать старые temporal decision rows и не создавать второй независимый workflow. Если необходима физическая staging таблица для гипотез, она должна быть типизированным расширением **той же** review queue, с FK на стабильные source IDs и общей точкой чтения; провести ревизию схемы/backup перед PR. Без удаления временных legacy таблиц до C3.

**F3 · P2 · legacy `about` и идентичность.** `linkEntities`/direct-agent approved note всё ещё используют legacy `about` без подтверждающего witness, что допустимо для старой функции, но никогда не доказывает `participant_of`, родство или identity. Связи с тёзками защищены #178. **Решение:** R2/R3b UI указывает различие «упоминает» и «участвовал», не повышает legacy edge до факта; исправлять только конкретных callers с C1.

**F4 · P2 · typed `searchMemory` строго фильтрует по роли, а не по тексту вопроса.** В ветке `verifiedRelative` параметр `query` не ограничивает возвращаемые беседы, хотя обычный поиск его использует. Это может быть намеренно («все разговоры с сестрой»), но нужен явный API-контракт и тест запросов с датой/исключением/другой темой; иначе пользователь ожидает текстовую фильтрацию, которой нет. **Решение:** R3b, не выдавать строгий role-only результат за полное удовлетворение вопроса.

**F5 · P2 · неисполненные проверки интеграции.** Внешний агентский entrypoint пока не разрешает `person:user` и роль из свободного текста, source reader не открывает аудио автоматически; не проведён физический SQLCipher backup/restore v13 и реальный телефон C2; 96-корпус не весь E2E. **Решение:** оставить R3b/M4/C2 открытыми, не заявлять DONE; соответствующие отрицательные сценарии для новых PR.

**F6 · DEFERRED (пункт C3/PLAN §2 6.5):** широкое удаление `about` / дублей search entrypoints / temporal legacy journal и реорганизация большого `repository.ts`. Без принятого M1–M4 и миграций может повредить старые данные. Сейчас — локальная проверка против дублирования в каждом PR; полноценная консолидация после M1–M4.

## Итог текущего среза

- Не обнаружено второго физического графа родства в #179–185: единственный authoritative relation-edge — `memory_relations`, evidence — `memory_relation_evidence`; FTS/vector — производные. Это **не** означает полностью завершённую общую модель review.
- #166–185 прошли ретроспективную **статическую архитектурную** сверку по фактическому diff и current code. **Отсутствующие индивидуальные pre/post C3-отчёты задним числом не объявляются выполненными**; этот документ фиксирует реальный охват и исключения.
- Новые PR: обязательная явная архитектурная сверка **ДО и ПОСЛЕ** (матрица operation→authoritative store→writer→read→ACL/CAS→backup), записи F1–F6 в реальных pre/post PR-отчётах, C1/C2 отдельно. Приоритет P1 F1 до расширения R2b/agent-facing read, затем новый user-facing workflow в `PLAN.md §2`, без самостоятельной очереди из находок.


## Дополнение после #186–188 и перед R2b1 (28.10.2026)

**Примечание к исторической секции выше:** статус F1 «первым исправить» описывает момент ревизии #166–185, а не нынешний `main`.

| PR | Архитектура ДО → ПОСЛЕ | Итог и непокрытое |
| --- | --- | --- |
| #186 | До: C0-A/C3-B не были явно представлены в шаблоне; после: AGENTS/Cursor/DEVELOPMENT_GATES/PR template требуют обе карты, старый audit не выдаётся за историю выполненных preflight | PASS docs-only, no runtime table/index/queue; правило проверять по diff, не по галочке |
| #187 | До: P1 F1 read proof→conversation и history не были единым SQLCipher snapshot; после: `withUnlockedTransaction` защищает обе связанные read-операции, без второго graph/search/helper | F1 исправлен **для внутренней операции чтения в БД**, required CI PASS. Перед внешней LLM всё ещё нужен check-at-use; physical device NOT RUN |
| #188 | До: temporal proposals/decisions и relation witness/review actions частично расходятся; после: единый review contract на уровне спецификации, без новой таблицы, клиента или исполняемого workflow | MATCH DESIGN ONLY; нельзя объявлять F2 закрытым до реализации R2b2/R2c и последующей C3 |
| #189 | До: `purgeNotes` сталкивался с v13 FK `memory_review_actions.undoes_id ON DELETE RESTRICT` после relation retract→undo; после: существующая транзакция удаляет зависимый журнал только при подтверждённом hard purge, не при trash/restore | **F7 исправлен для затронутого удаления** без дополнительного store, search или queue; тест FK/rollback, физический Android C2 NOT RUN; будущий C3 FK rebuild проверять отдельно |
| #190, C0-A | До: v13 один canonical relation edge/evidence, один temporal authoritative journal, R2b design; missing persisted unconfirmed candidates | EXTEND `memory_review_proposals` **только для гипотез**, one source+ACL guard, current versions/quote, no confirmation edge; encrypted manifest count. C3-B после тестов подтвердить, что источник истины/решения не задвоены и нет новой P1 |

В этой ревизии проверены оба реальных направления идентификации (`person→person`, `note→person`), изменение источника, две тёзки, чувствительность каждого промежуточного узла, отмена и блокировка старого решения. Старые `about` остаются только legacy mention; `memory_review_proposals` не является уже доказанной связью. **F2 остаётся PARTIAL:** единый пользовательский экран и общий typed inbox ещё не включены, временные `memory_temporal_decisions` не копируются в `memory_review_actions`. Массовый рефакторинг C3 ждёт приёмки M1–M4.

**C3-B для #190 (дополнить итогом CI):** operation/staging → `memory_review_proposals` (неистинная гипотеза) → existing profile-leased `stageRelationCandidate` / `relationCandidateInbox` → тот же original-note ACL/версии/quote, что у confirmed writer → manifest v5 + v13 old-archive migration; `memory_relations/evidence` остаются единственными подтверждениями, `memory_temporal_proposals/decisions` не тронуты, новые FTS/vector indexes отсутствуют. Уменьшение дублирования: общий `validatedCandidate` применяется и при stage, и при confirm. Отложено строго по PLAN §2: R2b2 actions and unified read, R2c UI, C3 historic journals. Physical SQLCipher restore C2 NOT RUN.

**Уточнение области ретроспективы (решение владельца 28.10.2026):** аудировать задним числом только PR, относящиеся к **текущей переработке памяти #166–190**; PDF-only #167 вне этой цепочки, ранние независимые PR не расширять в отдельный всеобщий аудит. Исторически отсутствие preflight не записывать как его фактическое прохождение. Правило C0-A и C3-B для каждого **будущего** PR остаётся общепроектным по `AGENTS.md`, `docs/DEVELOPMENT_GATES.md` и PR template; ретроспективный охват не равен охвату будущего правила.

**Ограничение R2b1:** `relationCandidateInbox` — пока специализированное чтение неподтверждённых кандидатов отношений. Единого работающего `MemoryReviewInbox` для временных фактов и отношений **ещё нет**. `memory_review_proposals` является *staging*, а не новым authoritative relation store: доказательство подтверждённой связи — только `memory_relations` + `memory_relation_evidence`; `searchMemory` и `memory_temporal_decisions` не подменены. Следующий R2b2 должен использовать **один** существующий writer подтверждения и журнал действий, не создавать самостоятельные relation decision store/queue/UI. Последующая общая сверка при R2c, а не преждевременное удаление legacy temporal state.
