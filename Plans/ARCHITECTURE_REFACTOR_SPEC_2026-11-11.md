# PersAI — спецификация упорядочивания плана и архитектуры

**Статус:** СОГЛАСОВАНО ВЛАДЕЛЬЦЕМ В ЧАСТИ ПОРЯДКА, ПРОМПТА И УЧЁТА РАСХОДА (11.11.2026); в очередь `PLAN.md` вносится пакетом A1. Дата: 11.11.2026. Снимок кода: `main@c272a11c`.
**Кому:** LLM-исполнителю (Cursor или аналог) и владельцу.
**Что это:** набор маленьких последовательных пакетов. Один пакет = одна ветка = один PR.
**Чем это не является:** это не вторая очередь работ. Порядок исполнения задаёт только `PLAN.md` §2. Пакет A1 ниже добавляет туда одну строку со ссылкой на этот файл; до этого ни один пакет ARCH не выполнять.

Номера строк в тексте взяты из снимка `main@c272a11c` и служат ориентиром. Перед работой всегда сверяйся с актуальным `main`.

---

## 0. Правила для исполнителя (читать перед КАЖДЫМ пакетом)

### 0.1. Порядок действий в каждом пакете

1. Прочитай `AGENTS.md` и `docs/DEVELOPMENT_GATES.md`. Они обязательны и важнее этого файла. При противоречии остановись и спроси владельца.
2. Обнови `main`, создай ветку с именем из заголовка пакета.
3. Сними исходное состояние и запиши результат (число тестов, PASS/FAIL) в описание PR:
   ```bash
   cd mobile
   npm ci
   npm run typecheck
   npm test
   ```
   Нужен Node 22.13+. Если исходное состояние красное, остановись и сообщи; не чини чужие падения в этом PR.
4. Выполни шаги пакета строго по порядку. Не добавляй ничего, чего нет в пакете.
5. Повтори команды из шага 3. Для пакетов, меняющих экраны, дополнительно: `node scripts/verify-mobile-ui.cjs`.
6. Проверь раздел «Готово, когда» пакета. Каждый пункт отметь PASS / FAIL / NOT RUN.
7. Оформи PR по шаблону `.github/pull_request_template.md`, включая C0-A, C3-B, матрицу соответствия плану и строку `CHAT-FIRST: N/A (рефакторинг без изменения поведения)`, если пакет не меняет поведение.
8. В описании PR раздельно укажи: автоматический CI, release APK, физический телефон. Если телефон не проверялся, пиши `NOT_RUN_PHYSICAL`. Если живая модель не вызывалась, пиши `NOT_RUN_LIVE_MODEL`.

### 0.2. Два типа пакетов

| Тип | Что разрешено | Что запрещено |
| --- | --- | --- |
| **REFACTOR** (поведение не меняется) | Переносить код между файлами, переименовывать внутренние (не экспортируемые наружу модуля) имена, добавлять новые тесты | Менять любой текст, уходящий в LLM (системный промпт, описания и схемы инструментов). Менять ожидания существующих тестов. Менять SQL, схему БД, формат сохранённых диалогов, формат резервной копии. Добавлять зависимости |
| **BEHAVIOR** (поведение меняется) | Только изменения, прямо перечисленные в пакете | Всё остальное. Обязательна отметка `NOT_RUN_LIVE_MODEL` до прогона владельцем |

Тип указан в заголовке каждого пакета.

### 0.3. Условия остановки

Остановись, ничего не коммить сверх сделанного и напиши владельцу, если:

- существующий тест падает и чтобы он прошёл, нужно изменить его **ожидание** (а не путь импорта);
- золотой тест (пакет ARCH-0) показывает расхождение в REFACTOR-пакете;
- для выполнения шага нужно тронуть файл из списка 0.4;
- шаг пакета не соответствует реальному коду (функции нет, сигнатура другая);
- изменение одного пакета превышает примерно 600 строк диффа без учёта чистых переносов.

### 0.4. Файлы, которые нельзя менять в пакетах ARCH (если пакет прямо не разрешает)

- `mobile/src/local-memory/storage.ts` (миграции, `LOCAL_MEMORY_SCHEMA_VERSION = 19`)
- `mobile/src/local-memory/backup.ts`, `backup-settings.ts`
- `mobile/src/local-memory/transaction.ts`, `note-actions.ts`
- `mobile/src/security/**`
- `mobile/src/design/nebula/assets/**`, иконки, `brand/**`
- `mobile/modules/**`, `.github/workflows/**`
- `Plans/history/**` (только добавление новых файлов в пакете A1)

### 0.5. Неизменяемые архитектурные решения (не пересматривать)

1. Сервера нет. Одна база SQLCipher на профиль.
2. Каждое сообщение чата идёт через цикл LLM с инструментами. Никаких ответов по регулярным выражениям в обход модели.
3. Модель только предлагает. Запись делает приложение после подтверждения пользователя через существующий writer с проверкой версии (CAS), прав (ACL) и возможностью отмены.
4. Единственный writer импорта — `saveMediaNote` (`mobile/src/media/attachments.ts:201`).
5. Единственный каталог инструментов — `createToolCatalog`. Второй runtime, второй индекс, вторую таблицу для тех же данных не создавать.
6. Пиксели и векторы фото не уходят провайдеру LLM автоматически.

---

## Часть A. Упорядочивание плана

### Проблема

- `PLAN.md` весит 149 КБ. До первого заголовка `##` идёт около 59 КБ датированных сводок. Раздел §2 «единственная рабочая очередь» занимает 42 КБ и состоит в основном из отчётов о уже слитых PR.
- Статус пунктов продублирован: §3 `PLAN.md` (17 КБ) и `Plans/ROADMAP_STATUS.md`.
- В «ближайших действиях» стоят уже слитые MSG-0/1/2/6. Приёмочный стоп этапа 9 от 09.11 и запуск TDLib B1–B11 от 10.11 противоречат друг другу без явной записи о решении.
- В плане и реестре 31 отметка `NOT_RUN_PHYSICAL`, единого списка долга нет.
- Агент читает `PLAN.md` перед каждой задачей; размер и противоречия стоят денег и порождают ошибки.

### Пакет A1 — `docs/plan-compact` · тип: только документы · **ВЫПОЛНЕН 11.11.2026**

> Выполнен вручную 11.11.2026 (изменения в рабочем каталоге, коммит делает владелец). Результат: `PLAN.md` ред. 96, архивные снимки в `Plans/history/`, `Plans/CHANGELOG.md`, `Plans/PHYSICAL_ACCEPTANCE_DEBT.md`, `Plans/LATE_STAGES_13_15.md`, сокращённый `Plans/ROADMAP_STATUS.md`. Отличия от шагов ниже: журнал PR собран из `git log --first-parent` без ручного статуса проверок; прежний §3 `PLAN.md` сохранён только в архивном снимке; этапы 13 и 15 вынесены в отдельный файл с прежними якорями. **Исполнителю этот пакет не выполнять.** Шаги оставлены как описание сделанного.

**Цель:** `PLAN.md` не длиннее 250 строк и 20 КБ, без потери единого слова истории.

**Шаги:**

1. Создай `Plans/history/PLAN_FULL_2026-11-11.md` и скопируй в него текущий `PLAN.md` целиком, байт в байт. В первой строке добавь: `> АРХИВ. Не является очередью работ. Снимок PLAN.md ред. 95 от 11.11.2026.`
2. Создай `Plans/history/ROADMAP_STATUS_FULL_2026-11-11.md` тем же способом из `Plans/ROADMAP_STATUS.md`.
3. Создай `Plans/CHANGELOG.md`. Формат записи: одна строка на PR — `дата · №PR · пакет · что изменилось для пользователя · статус (CI / APK / телефон)`. Перенеси туда по одной строке на каждый PR, начиная с #371 (берётся из архивного снимка; ссылки на прогоны CI сохрани).
4. Перепиши `PLAN.md` по структуре ниже. Тексты правил не сочиняй заново: давай ссылку на `AGENTS.md` и `docs/DEVELOPMENT_GATES.md`.

   ```markdown
   # Единый план PersAI — ред. 96

   ## 1. Сейчас
   Один активный пакет: название, цель в одну фразу, ссылка на спецификацию, критерий завершения.
   Блокеры (если есть).

   ## 2. Очередь
   ### 2.1. Следующие пакеты (не больше 7 строк)
   | № | Пакет | Результат | Условие перехода |
   ### 2.2. Этапы 9–15 (таблица из прежнего §2, по одной строке на этап, без истории PR)

   ## 3. Открытые решения владельца
   Список вопросов, без ответа на которые нельзя идти дальше.

   ## 4. Обязательные правила
   Только ссылки: AGENTS.md, docs/DEVELOPMENT_GATES.md, Plans/DIALOG_FIRST_UX.md.

   ## 5. Неизменяемые решения
   Перенести прежний §5 без изменений.

   ## 6. Где что лежит
   Статусы №1–91 → Plans/ROADMAP_STATUS.md. История PR → Plans/CHANGELOG.md.
   Долг физической приёмки → Plans/PHYSICAL_ACCEPTANCE_DEBT.md. Архив → Plans/history/.

   ## 7. Как вести план
   - PLAN.md меняется только когда меняется очередь или решение владельца.
   - Каждый PR: одна строка в CHANGELOG.md и, если изменился статус пункта, одна ячейка в ROADMAP_STATUS.md.
   - Запрещено дописывать в PLAN.md отчёты о PR.
   ```
5. В `Plans/ROADMAP_STATUS.md` удали все датированные абзацы над заголовком `## Полный реестр` (они уже лежат в архиве из шага 2). Таблицу №1–91 и раздел «Связи и контроль полноты» не трогай.
6. Удали из `PLAN.md` прежний §3 «Реестр задач и зависимостей»: он дублирует `ROADMAP_STATUS.md`. Если в §3 есть сведения, которых нет в реестре, перенеси их в соответствующую ячейку реестра, а не удаляй.
7. Создай `Plans/PHYSICAL_ACCEPTANCE_DEBT.md`: чек-лист всех мест с `NOT_RUN_PHYSICAL`, `NOT_RUN_LIVE_MODEL`, `NOT_RUN_RESTORE_DRILL`, `C2_PENDING`. Найти их:
   ```bash
   grep -rn "NOT_RUN_PHYSICAL\|NOT_RUN_LIVE_MODEL\|NOT_RUN_RESTORE_DRILL\|C2_PENDING" Plans/history/PLAN_FULL_2026-11-11.md Plans/history/ROADMAP_STATUS_FULL_2026-11-11.md
   ```
   Формат строки: `- [ ] пакет/PR · что именно проверить на телефоне · ссылка на сценарий (если есть)`. Одинаковые проверки объедини в одну строку.
8. Запиши в `PLAN.md` решения владельца от 11.11.2026:
   - §1 «Сейчас»: активный пакет — **завершение блока Telegram** (TDLib, «Избранное», темы; остаток по архивному снимку плана).
   - §2.1 «Следующие пакеты», в таком порядке: (1) блок Telegram; (2) ARCH-0…ARCH-4 по этой спецификации; (3) единая приёмка этапа 9 **вместе с Telegram** на подписанном APK и телефоне по `Plans/PHYSICAL_ACCEPTANCE_DEBT.md`; (4) ARCH-6, ARCH-7 и далее.
   - Приёмочный стоп этапа 9 от 09.11.2026 заменён этим порядком: приёмка этапа 9 проводится один раз, после Telegram.
   - §3 «Открытые решения владельца» — один вопрос: выполнять ARCH-0…ARCH-4 до приёмки этапа 9 (рекомендуется: тогда принятый APK уже содержит новый промпт и приёмку не придётся повторять) или после неё.
9. Пакет ARCH-7 меняет файлы `mobile/src/telegram/**`, поэтому в очереди он стоит строго после завершения блока Telegram и приёмки. Запиши это условие в ячейку «Условие перехода».
10. Обнови ссылки: `README.md`, `AGENTS.md`, `.cursor/rules/persai-development-gates.mdc` ссылаются на якоря `PLAN.md`. Каждую ссылку на удалённый якорь замени ссылкой на новое место или на архивный снимок.

**Готово, когда:**

- `wc -l PLAN.md` ≤ 250 и `wc -c PLAN.md` ≤ 20000.
- Архивные снимки совпадают с исходниками: `git show HEAD~1:PLAN.md | tail -n +1 | diff - <(tail -n +2 Plans/history/PLAN_FULL_2026-11-11.md)` не выводит различий (с поправкой на добавленную первую строку).
- Ни одной битой относительной ссылки в `PLAN.md`, `README.md`, `AGENTS.md`, `Plans/ROADMAP_STATUS.md`. Проверка: для каждой ссылки вида `](путь)` без `http` файл существует.
- В `PLAN.md` нет номеров PR, SHA и ссылок на прогоны CI.
- Код в `mobile/` не изменён.

---

## Часть B. Архитектура

### Что не так сейчас (факты из кода)

| № | Факт | Где | Последствие |
| --- | --- | --- | --- |
| F1 | Два разных системных промпта: `systemPrompt` для OpenAI и `system` для остальных провайдеров. Второй короче и не содержит правил про подборки статей, источники, рабочие черновики | `direct-agent/engine.ts:130`, `direct-agent/compatible.ts:18` | YandexGPT, DeepSeek, Anthropic и локальные модели получают другие инструкции, чем OpenAI, при том же наборе инструментов |
| F2 | Промпт — одна склеенная строка. Правила про инструмент включены, даже когда инструмент недоступен | там же | Лишние токены; слабые модели вызывают несуществующие инструменты |
| F3 | Все 22 инструмента объявлены в одной функции `createToolCatalog` (около 890 строк) с общими переменными в замыкании: `moveHandles`, `movePreview`, `sectionPreview`, `contextCandidate`, `importTagsCandidate`, `articleCoverage` и др. | `direct-agent/tool-catalog.ts:43–930` | Каждый новый инструмент увеличивает один файл и риск задеть соседей |
| F4 | `DirectAgentOptions` содержит около 30 необязательных полей-колбэков; `DirectResult` и `ChatRow` получают отдельное поле под каждую функцию: `moveProposal`, `moveReceipt`, `sectionProposal`, `sectionReceipt`, `articlePage`, `articleReadReport`, `importTags`, `contextCandidate`, `photoAction` | `engine.ts:28–111`, `conversations.ts:37` | Каждое новое действие требует правок в движке, каталоге, хранилище чата, типе строки и экране |
| F5 | Для каждого вида предложения свои методы хранилища (`confirmMoveProposal`, `confirmSectionProposal`, `undoConfirmedMove`) и своя вёрстка карточки прямо в экране | `chat-store.ts:616–725`, `HomeScreen.tsx:460–530` | Нет общей карточки подтверждения; сценарии S07, A05 и DIALOG-ADMIN умножат дублирование |
| F6 | Под подборки статей сделано пять инструментов: `select_local_articles`, `continue_local_articles`, `read_selected_local_articles`, `read_selected_article_chunk`, `selected_article_read_coverage` | `tool-catalog.ts` | Та же схема понадобится для заметок, фото и сообщений Telegram |
| F7 | Крупные файлы: `repository.ts` 77 КБ, `tool-catalog.ts` 72 КБ, `HomeScreen.tsx` 57 КБ, `chat-store.ts` 51 КБ | — | Трудно читать и проверять, слабая модель теряет контекст |
| F8 | `telegram/bot-sync.ts` и `telegram/saved-import.ts` независимо реализуют один цикл: получить страницу → `saveMediaNote` с receipt → посчитать сохранённые/дубли/пропуски | `bot-sync.ts:50`, `saved-import.ts:47` | Каждый новый источник будет копировать цикл |
| F9 | Фильтры по источнику, дате публикации и тегам выполняются через `json_extract` / `json_each` по `payload_json` без индексов | `agent-catalog.ts:84–159`, `repository.ts:970,1022` | Возможное замедление на больших базах; не измерено |
| F10 | Нет учёта расхода вызовов LLM по назначению; фоновое обогащение уже делает платные вызовы | `direct-agent/enrich-runner.ts`, `helper-model.ts` | Нельзя ограничить расход фона |
| F11 | Нет библиотек уведомлений и фоновых задач в `package.json` | `mobile/package.json` | Напоминания и сводки (этапы 10–11) не на чем строить |

### Порядок пакетов

```
A1 → ARCH-0 → ARCH-1 → ARCH-2 → ARCH-3 → ARCH-4 → ARCH-6 → ARCH-7 → ARCH-5
                                                     └→ ARCH-8, ARCH-9, ARCH-10, ARCH-11 (независимы, после решения владельца)
```

Место в общей очереди (решение владельца 11.11.2026): блок Telegram → ARCH-0…ARCH-4 → приёмка этапа 9 вместе с Telegram → остальные пакеты ARCH. ARCH-7 — только после приёмки, так как меняет файлы Telegram.

ARCH-0…ARCH-4 и ARCH-6…ARCH-7 расписаны пошагово. ARCH-5 и ARCH-8…ARCH-11 даны как контракт и начинаются с инвентаризации: их детали зависят от кода, который нужно сначала прочитать, и от решений владельца.

---

### ARCH-0 — `arch/golden-tests` · тип: REFACTOR (только тесты)

**Цель:** зафиксировать всё, что уходит в LLM, чтобы следующие пакеты не могли изменить это незаметно.

**Шаги:**

1. В `direct-agent/engine.ts` добавь слово `export` к `const systemPrompt`. В `direct-agent/compatible.ts` добавь `export` к `const system`. Больше в этих файлах ничего не меняй.
2. Создай `mobile/src/direct-agent/__tests__/golden-prompt.test.ts`. Тест вызывает обе функции с четырьмя наборами аргументов и сравнивает результат со снимком (`toMatchSnapshot()`):
   - без аргументов;
   - `sections` = `DEFAULT_SECTIONS` из `fact-tool.ts`, `context` не задан, `enabled = true`;
   - `sections` заданы, `context = { topic: "Тест", sectionSlug: "notes", pinned: false }` (остальные обязательные поля типа `ConversationContext` возьми из `conversation-context.ts`), `enabled = true`;
   - то же, `pinned: true`.
3. Создай `mobile/src/direct-agent/__tests__/golden-tools.test.ts`. Посмотри, как строятся `options` в существующих `tool-catalog-*.test.ts`, и возьми оттуда способ создания. Тест вызывает `createToolCatalog(options, [], [], [])` и снимает `catalog.definitions` (весь массив: имена, порядок, описания, параметры) в четырёх конфигурациях:
   - минимальная: только обязательные поля (`settings`, `prompt`, `history`, `lookup`, `propose`);
   - полная: заданы все необязательные колбэки (`read`, `searchSources`, `listSources`, `readSource`, `list`, `count`, `selectArticles`, `searchPhotos`, `previewMove`, `previewSectionAction`, `saveWorkspace`, `workspaceAvailable`) как `jest.fn()`, `contextClassificationEnabled: true`, `photoQueryAvailable: true`, заданы `articleContinuation` и `articleSelection` (минимально валидные значения по типу `ChatArticlePage`);
   - `contextOnly: true`;
   - `contextOnly: true, importTagsEnabled: true`.
4. Отдельным тестом в том же файле зафиксируй список имён инструментов в полной конфигурации простым массивом строк (не снимком), чтобы расхождение читалось глазами.
5. Запусти тесты, закоммить созданные файлы снимков.

**Готово, когда:** два новых файла тестов и их снимки в репозитории; все прежние тесты проходят; дифф рабочего кода состоит из двух добавленных слов `export`.

---

### ARCH-1 — `arch/prompt-module` · тип: REFACTOR

**Цель:** один файл, отвечающий за системный промпт. Тексты пока не меняются.

**Шаги:**

1. Создай `mobile/src/direct-agent/prompt.ts`.
2. Перенеси в него `systemPrompt` из `engine.ts` под именем `responsesSystemPrompt` и `system` из `compatible.ts` под именем `compatibleSystemPrompt`. Переноси вырезанием и вставкой, не перепечатывай текст.
3. Туда же перенеси два текста режима `contextOnly` (строка `content:` в `engine.ts:213` и в `compatible.ts:38`), оформив функцией `restrictedSystemPrompt(protocol: "responses" | "compatible", importTags: boolean): string`. Тексты у двух протоколов разные; сохрани оба дословно.
4. В `engine.ts` и `compatible.ts` импортируй функции из `prompt.ts`. Для совместимости с тестом ARCH-0 оставь в `engine.ts` строку `export { responsesSystemPrompt as systemPrompt } from "./prompt";` и аналогично `system` в `compatible.ts`.
5. Добавь в `golden-prompt.test.ts` снимки `restrictedSystemPrompt` для четырёх сочетаний аргументов. Эти снимки новые; снимки из ARCH-0 меняться не должны.

**Готово, когда:** снимки ARCH-0 не изменились; в `engine.ts` и `compatible.ts` не осталось строковых литералов с текстом системного промпта; typecheck и тесты проходят.

---

### ARCH-2 — `arch/tool-modules` · тип: REFACTOR

**Цель:** разложить `tool-catalog.ts` по файлам. Сигнатура и результат `createToolCatalog` не меняются.

**Целевая структура:**

```
mobile/src/direct-agent/tools/
  types.ts            ToolDefinition, ToolSpec, тип TurnState
  turn-state.ts       createTurnState(options, sources, notes, initialUsed): TurnState
  memory-tools.ts     search_local_notes, read_local_note, list_local_notes, count_local_notes
  source-tools.ts     search_local_source_segments, list_local_sources, read_local_source_segment
  article-tools.ts    select_local_articles, continue_local_articles, read_selected_local_articles,
                      read_selected_article_chunk, selected_article_read_coverage
  photo-tools.ts      search_local_photos
  proposal-tools.ts   propose_move_local_note, propose_create_memory_section,
                      propose_delete_memory_section, propose_import_metadata, draft_memory_fact
  conversation-tools.ts  set_conversation_context, инструмент TASK_STATE_TOOL,
                         workspace_put / workspace_list / workspace_get / workspace_clear
  index.ts            createToolCatalog: собирает specs в ПРЕЖНЕМ порядке, содержит run / finish / memory / observeSources
mobile/src/direct-agent/tool-catalog.ts   остаётся: `export * from "./tools";`
```

**Шаги:**

1. **Инвентаризация замыкания.** Выпиши все `let` и `const`, объявленные внутри `createToolCatalog` вне объектов инструментов (например `used`, `moveHandles`, `movePreview`, `sectionPreview`, `contextCandidate`, `importTagsCandidate`, `articleCoverage`, `state`, `proposalIds`, `readNotes`, `photoMatches`, `photoRecovery`, `persistedArticle`, `usedSelectedArticleTool`, `mixedArticleFilters`), и все внутренние функции (`admitMoveHandle`, `observe`, `emit`, `selectedArticleHandles` и т. д.). Список приложи к описанию PR.
2. **TurnState.** В `tools/types.ts` объяви тип `TurnState` с полем на каждую переменную из шага 1 и методом на каждую внутреннюю функцию. В `tools/turn-state.ts` напиши `createTurnState(...)`, который создаёт объект с теми же начальными значениями. Переменные, которые раньше менялись через `let`, становятся изменяемыми полями объекта: `movePreview = x` превращается в `turn.movePreview = x`.
3. **Перенос по одной группе.** Для каждого файла из структуры:
   - создай функцию `export function memoryTools(options: DirectAgentOptions, turn: TurnState): ToolSpec[]` (имя по файлу);
   - перенеси в неё объекты инструментов вырезанием и вставкой;
   - замени обращения к переменным замыкания на `turn.<имя>`;
   - условия включения (`...(options.read ? [{...}] : [])`) переноси вместе с инструментом без изменений;
   - после каждой группы запускай `npm test -- golden-tools` и `npm run typecheck`. Делай отдельный коммит на группу.
4. **Порядок.** В `tools/index.ts` собери массив `specs` так, чтобы порядок инструментов совпал с прежним. Если инструменты одной группы в исходном массиве стояли не подряд, верни из групповой функции объект с именованными спецификациями и расставь их в `index.ts` в исходном порядке. Порядок проверяет золотой тест.
5. `run`, `finish`, `memory`, `observeSources`, выбор `activeSpecs` для `contextOnly` перенеси в `tools/index.ts` без изменения логики.
6. `tool-catalog.ts` сведи к реэкспорту. Импорты в остальных файлах (`engine.ts`, `compatible.ts`, тесты) не меняй.

**Готово, когда:** снимки ARCH-0 не изменились; ни один существующий тест не изменён, кроме путей импорта; каждый файл в `tools/` не длиннее 400 строк (если группа больше, раздели её на два файла и укажи это в PR); `tool-catalog.ts` не длиннее 5 строк.

---

### ARCH-3 — `arch/tool-guidance` · тип: BEHAVIOR

**Цель:** промпт собирается из правил только тех инструментов, которые сейчас доступны, и одинаков для всех провайдеров.

**Решение владельца 11.11.2026:** промпт выравнивается для всех провайдеров. Правило отбора: указание остаётся в промпте, только если оно относится к инструменту, доступному в этом запросе, или является общим правилом безопасности и честности; всё остальное убирается у всех провайдеров одинаково. За основу берётся полный текст для OpenAI (`responsesSystemPrompt`): его правила про чтение источника перед пересказом, точные ссылки на фрагменты и отчёт о покрытии нужны для качества поиска и ответа. Предложения, которые есть только в коротком промпте (`compatibleSystemPrompt`), сверить по смыслу с полным текстом: если такого правила в полном тексте нет, добавить его в общую часть и перечислить в PR.

**Шаги:**

1. В `ToolSpec` (`tools/types.ts`) добавь необязательное поле `guidance?: string` — правило использования инструмента для системного промпта.
2. Разрежь текст `responsesSystemPrompt` на части по границам предложений и разложи:
   - предложения про конкретный инструмент → в `guidance` этого инструмента (например, предложение, начинающееся с «Если пользователь просит ПЕРЕНЕСТИ…», → `propose_move_local_note`);
   - предложение про несколько инструментов одной группы → в `guidance` первого инструмента группы;
   - всё остальное (роль, недоверие к данным, запрет выдумывать, `DIALOGUE_GUIDE`, `factGuide`, запрет сохранять документы и пароли) → в константы `PROMPT_HEAD` и `PROMPT_TAIL` в `prompt.ts`.
   Текст частей не редактируй. Сначала сделай таблицу «предложение → куда» и приложи к PR.
3. В `prompt.ts` напиши:
   ```ts
   export function buildSystemPrompt(input: {
     sections?: MemorySection[];
     context?: ConversationContext;
     contextEnabled: boolean;
     tools: Array<{ name: string; guidance?: string }>;   // только активные, в порядке каталога
   }): string
   ```
   Результат: `PROMPT_HEAD` + блок про тему диалога (как сейчас, только если `contextEnabled`) + `guidance` активных инструментов в порядке каталога + `PROMPT_TAIL`.
4. Каталог должен возвращать `guidance` наружу: добавь в результат `createToolCatalog` поле `guidance: Array<{name, guidance?}>` для `activeSpecs`.
5. В `engine.ts` и `compatible.ts` каталог сейчас создаётся **после** сборки сообщений. Поменяй порядок: сначала `createToolCatalog`, затем сборка системного сообщения через `buildSystemPrompt`. Оба файла используют одну и ту же функцию. Тексты режима `contextOnly` (`restrictedSystemPrompt`) пока оставь как есть.
6. **Проверка эквивалентности.** Добавь тест: при полной конфигурации инструментов набор предложений в `buildSystemPrompt` равен набору предложений прежнего `responsesSystemPrompt` (сравнение множеств предложений после разбиения, без учёта порядка). Прежний текст возьми из снимка ARCH-0.
7. Добавь тест: при минимальной конфигурации в промпте нет имён недоступных инструментов (перебери имена из полной конфигурации, которых нет в минимальной, и проверь `not.toContain`).
8. Добавь в диагностику (`options.diagnostic?.("agent.prompt", { chars })`) длину системного промпта.
9. Удали `responsesSystemPrompt` и `compatibleSystemPrompt`. Обнови снимки `golden-prompt.test.ts`: теперь они снимают `buildSystemPrompt` в четырёх конфигурациях инструментов из ARCH-0. В PR приложи длину промпта до и после для каждой конфигурации.

**Готово, когда:** тесты шагов 6–7 проходят; снимки `golden-tools` не изменились (описания и схемы инструментов прежние); в PR есть таблица разбиения и замер длины; статус `NOT_RUN_LIVE_MODEL` указан явно. Слияние только после прогона владельцем минимум на двух провайдерах (см. ARCH-11).

---

### ARCH-4 — `arch/proposals` · тип: REFACTOR

**Цель:** один механизм подтверждения предложений и одна карточка в чате. Формат сохранённых диалогов не меняется.

**Главное ограничение:** поля `moveProposal`, `moveReceipt`, `sectionProposal`, `sectionReceipt` в `ChatRow` сохраняются в базе (`direct_conversations.snapshot_json`) и в резервных копиях. Их имена и форму **не менять**. `parseConversation` (`conversations.ts:60`) не менять.

**Шаги:**

1. Создай `mobile/src/direct-agent/proposals.ts`:
   ```ts
   export type ProposalKind = "move_note" | "section";
   export type ProposalCardView = {
     heading: string;            // «Перенести запись?», «Создать раздел?», «Удалить пустой раздел?»
     lines: string[];            // строки описания в том порядке, как сейчас на экране
     note?: string;              // пояснение мелким шрифтом
     confirmLabel: string;
     confirmIcon: string;        // имя иконки Feather
     danger: boolean;
     openNoteId?: string;        // если заголовок ведёт на запись
   };
   export type ReceiptView = { text: string; undoable: boolean; undone: boolean };
   export interface ProposalHandler<P, R> {
     kind: ProposalKind;
     fromRow(row: ChatRow): P | undefined;
     receiptFromRow(row: ChatRow): R | undefined;
     present(proposal: P): ProposalCardView;
     presentReceipt(receipt: R): ReceiptView;
     confirm(profile: string, proposal: P): Promise<R>;
     undo?(profile: string, receipt: R): Promise<R>;
     withReceipt(row: ChatRow, receipt: R): ChatRow;     // убрать предложение, записать квитанцию
     withoutProposal(row: ChatRow): ChatRow;             // отклонить
   }
   export const proposalHandlers: ProposalHandler<any, any>[];
   export function rowProposal(row: ChatRow): { handler: ProposalHandler<any, any>; proposal: unknown } | undefined;
   export function rowReceipt(row: ChatRow): { handler: ProposalHandler<any, any>; receipt: unknown } | undefined;
   ```
2. Реализуй два обработчика: `moveNoteHandler` (использует существующие `confirmMove`, `undoMove` из `move-proposal.ts`) и `sectionHandler` (использует `confirmSectionAction` из `section-actions.ts`). Тексты для `present` и `presentReceipt` перенеси из `HomeScreen.tsx:460–530` дословно.
3. В `DirectChatStore` (`chat-store.ts`) добавь три метода: `confirmProposal(rowId)`, `dismissProposal(rowId)`, `undoProposal(rowId)`. Перенеси в них общую логику из `confirmSectionProposal`, `confirmMoveProposal`, `undoConfirmedMove` и методов отклонения: проверки `busy / movingRowId / deleting / disposed`, поиск строки, установка флага занятости, вызов обработчика, запись результата, обработка ошибок. Сообщения об ошибках сохрани дословно; если тексты у двух видов различаются, вынеси текст в обработчик.
4. Прежние методы `confirmSectionProposal`, `confirmMoveProposal`, `undoConfirmedMove` оставь как однострочные обёртки над новыми. Существующие тесты (`chat-move-confirmation.test.ts`, `section-actions.test.ts`, `chat-store.test.ts`) должны пройти без изменений.
5. Создай `mobile/src/components/ProposalCard.tsx`: принимает `ProposalCardView`, колбэки `onConfirm`, `onDismiss`, `onOpenNote`, флаг `busy`. Вёрстку, стили, `accessibilityLabel` перенеси из `HomeScreen.tsx` без изменений внешнего вида. Аналогично `ReceiptLine` для квитанции с кнопкой отмены.
6. В `HomeScreen.tsx` замени два блока карточек одним: `const p = rowProposal(item); if (p) <ProposalCard view={p.handler.present(p.proposal)} … />`. То же для квитанций.
7. Добавь `mobile/src/direct-agent/__tests__/proposals.test.ts`: для каждого обработчика — `fromRow`, `present` (снимок), `withReceipt`, `withoutProposal`; для хранилища — подтверждение, отклонение, отмена, отказ при блокировке приложения, отказ при устаревшей версии записи.
8. Запусти `node scripts/verify-mobile-ui.cjs`.

**Не делать в этом пакете:** не трогать черновики фактов (`drafts`, `approve(draft)`), `importTags`, `contextCandidate`, `articlePage`; не менять `DirectResult`; не добавлять новые виды предложений.

**Готово, когда:** существующие тесты не изменены и проходят; в `HomeScreen.tsx` нет обращений к `item.moveProposal` и `item.sectionProposal` в разметке; браузерная проверка экранов проходит; резервная копия и сохранённые диалоги не затронуты (дифф не содержит `conversations.ts`, `backup.ts`).

**Как потом добавлять новый вид предложения (правило на будущее, не часть пакета):** новый вид добавляет в `ChatRow` одно общее поле `proposal?: { kind: string; payload: unknown }` и `receipt?: { kind: string; payload: unknown }` с проверкой в `parseConversation`, обработчик в `proposalHandlers` и инструмент в `tools/proposal-tools.ts`. Движок, экран и хранилище при этом не меняются.

---

### ARCH-6 — разбиение крупных файлов · тип: REFACTOR · три отдельных PR

Общие правила для всех трёх: только перенос кода; публичные имена и сигнатуры не меняются; SQL-строки переносятся дословно; один PR на файл.

**ARCH-6a — `arch/split-chat-store`**

1. Создай `direct-agent/agent-host.ts` с функцией `buildAgentOptions(input): Parameters<typeof runDirectAgent>[0]`. Перенеси в неё сборку объекта `agentOptions` из метода `send` (`chat-store.ts`, примерно строки 335–430): все колбэки `lookup`, `previewSectionAction`, `previewMove`, `searchPhotos`, `read`, `searchSources`, `listSources`, `readSource`, `list`, `count`, `selectArticles` и т. д. Всё, что колбэки брали из `this` и локальных переменных `send`, передавай через `input` явными полями.
2. Обработку результата агента (примерно строки 450–480: применение `contextCandidate`, сборка строки ассистента) вынеси в чистую функцию `assistantRowFromResult(result, conversation, sections, now)` в `direct-agent/agent-result.ts`.
3. Класс `DirectChatStore` и его публичные методы остаются в `chat-store.ts`.

**ARCH-6b — `arch/split-home-screen`**

1. Вынеси отрисовку одной строки чата (функция `renderItem` и всё, что внутри) в `components/chat/ChatRowView.tsx`. Пропсы: строка, тема, колбэки. Состояние экрана внутрь не переносить.
2. Вынеси блок ввода (поле, вложения, голос, кнопки отправки и остановки) в `components/chat/ChatComposer.tsx`.
3. `HomeScreen.tsx` остаётся владельцем состояния и навигации.
4. Стили, отступы, тексты, `accessibilityLabel`, `testID` не менять. Проверка: `node scripts/verify-mobile-ui.cjs` и все тесты в `screens/__tests__` без изменений.

**ARCH-6c — `arch/split-repository`**

1. Создай каталог `local-memory/repository/` и перенеси тела методов класса `SqliteMemoryRepository` в функции вида `export async function listCollections(db: SQL, …)` по файлам:
   - `collections.ts` — `collectionNoteCounts`, `listCollections`, `createCollection`, `moveCollection`, `deleteEmptyCollection`;
   - `entities.ts` — `entity`, `entities`, `createEntity`, `reviseEntity`, `setEntityStatus`, `setEntityKind`, `revisions`, `aliases`, `setAliases`, `entitiesByAlias`;
   - `observations.ts` — `observation`, `observations`, `createObservation`, `reviseObservation`, `linkEntities`, `relationsForEntity`;
   - `index-terms.ts` — `indexTerms`, `setIndexTerms`, `applyIndexEnrichment`, `indexTermsStatus`, `staleIndexTerms`;
   - `vectors.ts` — `pendingVectorChunks`, `saveVectors`, `vectorStatus`, `vectorMatches`, `saveImageVector`;
   - `search.ts` — `listNoteTags`, `searchNotes`, `matches`, `linkedFacts`, `searchMemory`;
   - `misc.ts` — остальное (`temporalCandidatesAtDate`, `trashNoteCount`, `lastNoteOperation`).
2. Класс `SqliteMemoryRepository` остаётся в `repository.ts` как фасад: каждый метод состоит из одного вызова соответствующей функции. Интерфейс `MemoryRepository` в `types.ts` не менять.
3. Переноси по одному файлу за коммит, после каждого запускай тесты `local-memory/__tests__` и `memory-sql-acceptance.test.ts`.
4. Транзакции: если метод открывал транзакцию, функция открывает её так же. Не объединяй и не разделяй транзакции.

**Готово, когда (для каждого из трёх):** ни один существующий тест не изменён, кроме путей импорта; исходный файл стал не длиннее 500 строк (для `repository.ts` — не длиннее 300); снимки ARCH-0 не изменились.

---

### ARCH-7 — `arch/source-connectors` · тип: REFACTOR

**Цель:** общий цикл импорта для источников, работающих страницами. Начать с двух существующих: бот Telegram и «Избранное» Telegram.

**Шаг 0 — инвентаризация (обязательна, результат в описании PR).** Прочитай целиком `telegram/bot-sync.ts`, `telegram/saved-import.ts`, `telegram/bot-api.ts`, `telegram/saved-messages.ts`, `telegram/saved-topics.ts` и их тесты. Составь таблицу различий двух циклов: как получают страницу, какой receipt, какие поля происхождения передают в `saveMediaNote`, когда фиксируют курсор, что считают пропущенным, как проверяют блокировку приложения и отмену, как защищаются от параллельного запуска. Если различий больше, чем покрывает контракт ниже, остановись и опиши их владельцу.

**Контракт (`mobile/src/sources/connector.ts`):**

```ts
export type SourceItem =
  | { status: "ok"; externalId: string; receipt: string; title: string; body: string;
      provenance: Partial<Pick<Parameters<typeof saveMediaNote>[1],
        "botMessage" | "telegramSavedMessage" | "sourceUrl" | "sourceCoverage">> }
  | { status: "unsupported"; externalId: string; reason: string }
  | { status: "empty"; externalId: string };

export type SourcePage = { items: SourceItem[]; nextCursor: string | null; meta?: Record<string, unknown> };

export interface SourceConnector {
  id: string;                                   // "telegram-bot" | "telegram-saved"
  sensitivity: "sensitive" | "standard";
  fetchPage(cursor: string | undefined, signal?: AbortSignal): Promise<SourcePage>;
  /** Вызывается ТОЛЬКО после успешной записи всей страницы. */
  commitCursor?(nextCursor: string | null, page: SourcePage): Promise<void>;
  /** true = остановить импорт страницы на первом неподдерживаемом элементе без фиксации курсора. */
  stopOnUnsupported: boolean;
}

export type ImportPageResult = { saved: number; duplicates: number; unsupported: number; empty: number; nextCursor: string | null };

export async function importSourcePage(profile: string, connector: SourceConnector,
  cursor?: string, signal?: AbortSignal): Promise<ImportPageResult>;
```

**Шаги:**

1. Реализуй `importSourcePage`: защита от параллельного запуска по ключу `profile + connector.id`; проверка разблокировки перед каждой записью тем же способом, что в `saved-import.ts`; для каждого элемента `ok` — вызов `saveMediaNote` с `receipt`, `onReplay` для подсчёта дублей и полями `provenance`; после страницы — `commitCursor`; если сохранена хотя бы одна запись — запуск той же постановки векторов в очередь, что сейчас.
2. Напиши `telegram/bot-connector.ts` и `telegram/saved-connector.ts`, перенеся в `fetchPage` получение и преобразование сообщений из существующих файлов.
3. `syncTelegramBotText` и `importSavedTextPage` оставь с прежними сигнатурами и типами результата; внутри они вызывают `importSourcePage` и преобразуют результат в прежний вид.
4. Существующие тесты `telegram/__tests__` должны пройти без изменений. Добавь тест `sources/__tests__/connector.test.ts` с поддельным коннектором: дубль, пустой элемент, неподдерживаемый элемент в обоих режимах `stopOnUnsupported`, отмена в середине, блокировка приложения в середине, сбой записи (курсор не фиксируется).

**Не делать:** не переводить на коннекторы Android Share, импорт ссылок и импорт файлов (у них интерактивный предпросмотр, это другой поток); не менять `saveMediaNote`.

**Готово, когда:** тесты Telegram не изменены и проходят; новый тест проходит; в `bot-sync.ts` и `saved-import.ts` нет собственных циклов с `saveMediaNote`.

---

### ARCH-5 — `arch/result-sets` · тип: BEHAVIOR · контракт, требует решения владельца

**Цель:** схема «выборка → чтение по индексу → отчёт о покрытии» работает для любых записей, а не только для статей. Это открывает сценарии S01, S03, S06, S11, S12 без новых инструментов под каждый.

**Шаг 0 — инвентаризация.** Прочитай `tools/article-tools.ts` (после ARCH-2), `article-selection.ts`, `article-read-coverage.ts`, `local-memory/agent-catalog.ts`, тип `ChatArticlePage` и тесты `tool-catalog-articles`, `selected-article-*`, `chat-local-articles`, `multi-source-synthesis-scenarios`. Опиши в PR: какие фильтры поддерживает выборка статей, что хранится в `ChatArticlePage`, как проверяются права и версии при повторном чтении, как считается покрытие.

**Целевой контракт:**

- Внутренний тип `ResultSet = { kind: "articles" | "notes"; filter: {...}; selected: Array<{ id: string; version: number; title?: string }>; nextCursor?: {...} }`. Для `kind: "articles"` форма совпадает с `ChatArticlePage`, чтобы сохранённые диалоги читались без миграции.
- Новый инструмент `select_local_records` с фильтрами: `query?`, `sectionSlug?`, `tag?`, `sourcePlatform?` (`telegram` | `web` | `share` | `file`), `savedFrom?`, `savedTo?` (локальные даты `YYYY-MM-DD`), `limit` (до 20). Реализация — через существующие `SqliteMemoryRepository.searchNotes` и чтение из `agent-catalog.ts`; новый SQL-путь не создавать. Фильтр `sourcePlatform` опирается только на реально сохранённые поля происхождения.
- `read_selected_local_articles`, `read_selected_article_chunk`, `selected_article_read_coverage` начинают работать с любой выборкой текущего диалога. Имена и схемы этих инструментов не менять (их знают сохранённые диалоги и тесты).
- `select_local_articles` и `continue_local_articles` остаются и работают как раньше.
- Права: каждая запись выборки перечитывается с проверкой ACL и версии перед чтением, как сейчас для статей. Записи из разделов с уровнем доступа выше «обычный» в выборку не попадают.

**Приёмка:** тесты на 0 / 1 / 5 / 20 / 100+ записей; фильтр по датам на границе суток в локальном часовом поясе; запись изменилась между выборкой и чтением (отказ по версии); блокировка приложения в середине; отчёт о покрытии не считает непрочитанное. Статус `NOT_RUN_LIVE_MODEL` до прогона владельцем.

---

### ARCH-8 — `arch/query-perf` · тип: измерение, затем решение владельца

1. В существующем наборе масштабных тестов (`.github/workflows/memory-scale.yml` и связанные скрипты в `mobile/scripts`) добавь замер на синтетической базе 50 000 записей для запросов: `listNoteTags`, `searchNotes` с фильтром по тегу, выборка статей по дате публикации и по `source_url` (`agent-catalog.ts`). Записывай медиану и p95.
2. Результат оформи таблицей в `docs/architecture/QUERY_PERF_2026-11.md`.
3. Изменения схемы в этом пакете **не делать**. Если p95 любого запроса больше 300 мс, предложи владельцу вариант: индексы по выражению `json_extract(payload_json, '$.source_url')` и `'$.source_publication_date'` в миграции v20. Отдельную таблицу тегов не предлагать: решение владельца (#428, #430) — теги живут только в `payload_json`.

---

### ARCH-9 — `arch/llm-usage` · тип: BEHAVIOR · контракт, требует решения владельца

**Цель:** знать, сколько вызовов и токенов уходит на чат, фоновое обогащение, переформулировку запроса и вспомогательные вызовы; ограничить фон дневным пределом.

- Одна точка учёта: `requestModel` в `direct-agent/request.ts` и `askHelperModel` в `helper-model.ts` получают обязательный параметр `purpose: "chat" | "enrich" | "rewrite" | "import_classify" | "summary" | "other"`.
- Токены берутся из поля `usage` ответа провайдера. Если поля нет, вызов считается с пометкой «токены неизвестны»; ноль не подставлять.
- **Где хранить (решение владельца 11.11.2026: в резервную копию не включать):** защищённое хранилище устройства `expo-secure-store`, там же, где лимит вызовов (`direct-agent/agent-preferences.ts`). Новый ключ `pia.agent.usage.v1.<profile>`, одно значение JSON со счётчиками по дням за последние 14 дней, размер не больше 2 КБ (старые дни отбрасывать при записи). Базу SQLCipher и миграции не трогать. **Не добавлять** этот ключ в `local-memory/backup-settings.ts`: в резервную копию попадают только перечисленные там настройки, поэтому учёт расхода останется только на телефоне и обнулится при переустановке. Добавь тест, что резервная копия не содержит ключ учёта.
- Настройка «Дневной предел фоновых вызовов» (по умолчанию 50). При достижении `enrich-runner.ts` останавливается до следующего дня и показывает это в существующей карточке состояния обогащения.
- Экран: строка в `AgentLimitsCard.tsx` — «Сегодня: чат N, фон M».

---

### ARCH-10 — `docs/adr-background` · тип: только документ

Напиши `docs/architecture/ADR_BACKGROUND_AND_NOTIFICATIONS_2026-11.md` (решение принимает владелец). Сравни по актуальной документации Expo 57 и Android 16:

- локальные уведомления по расписанию (`expo-notifications`) для напоминаний №22/57а — срабатывают без запуска приложения, LLM не нужен;
- периодическая фоновая задача (`expo-background-task`, WorkManager) — гарантии запуска, ограничения производителей (Vivo), доступность ключа SQLCipher при заблокированном приложении;
- вариант «только при открытии приложения» (как сейчас в `TelegramAutoSync`).

Обязательные выводы документа: что можно делать при заблокированном AppLock (предположительно ничего, что требует чтения базы); можно ли вызывать платную модель в фоне (предположительно нет до ARCH-9); какой минимальный набор нужен для сценария «напомнить о сроке». Код не писать, зависимости не добавлять.

---

### ARCH-11 — `eval/live-tool-choice` · тип: тесты, запуск только владельцем

1. Изучи `mobile/eval/` (`natural-dialogues.ts`, `evaluate.ts`, `README.md`) и `.github/workflows/llm-connectivity.yml`.
2. Добавь в существующий набор 15 диалогов на выбор инструмента, по одному–двум на каждую группу: поиск заметки, чтение заметки, подсчёт, подборка статей, продолжение подборки, поиск фото по описанию, предложение переноса, создание раздела, предложение запомнить факт, вопрос без нужды в инструментах, запрос с недоступным инструментом (модель должна сказать, что не может, а не выдумать вызов).
3. Проверка в каждом диалоге: какой инструмент вызван первым, не вызваны ли запрещённые, нет ли выдуманных идентификаторов записей.
4. Запуск вручную (`workflow_dispatch`) с выбором провайдера; ключи только из секретов CI. Отчёт: доля верных выборов по провайдеру, число вызовов, длина системного промпта.
5. Исполнитель сам платные вызовы не запускает. В PR указать `NOT_RUN_LIVE_MODEL`.

Этот набор — условие слияния ARCH-3 и ARCH-5.

---

## Часть C. Как передавать пакет исполнителю

Для каждого пакета используй один и тот же стартовый текст, меняя только идентификатор:

```
Ты работаешь в репозитории PersAI. Выполни ровно один пакет: <ARCH-N> из файла
Plans/ARCHITECTURE_REFACTOR_SPEC_2026-11-11.md.

1. Сначала прочитай: AGENTS.md, docs/DEVELOPMENT_GATES.md, раздел 0 спецификации и раздел пакета <ARCH-N>.
2. Перечисли мне файлы, которые собираешься изменить и создать, и дождись моего «да».
3. Выполняй шаги пакета по порядку. Не делай ничего, чего нет в пакете.
4. После каждого шага запускай: cd mobile && npm run typecheck && npm test
5. Если сработало любое условие остановки из раздела 0.3 — остановись и опиши проблему.
6. В конце покажи: список изменённых файлов, результат каждой проверки из «Готово, когда»
   (PASS / FAIL / NOT RUN), и текст описания PR по шаблону репозитория.
Не объявляй пакет завершённым, если хотя бы один пункт «Готово, когда» не PASS.
```

**Проверка владельцем после каждого пакета (2–3 минуты):**

- `git diff --stat main` — затронуты только ожидаемые файлы, нет файлов из раздела 0.4;
- для REFACTOR-пакетов: `git diff main -- mobile/src/direct-agent/__tests__/__snapshots__` пуст (кроме новых снимков, прямо названных в пакете);
- `git diff main -- '*.test.ts' '*.test.tsx'` — в существующих тестах изменены только пути импорта;
- обязательный CI зелёный на точном SHA.

## Часть D. Что эта спецификация сознательно не решает

- Приоритет продуктовых сценариев (какие из S01–S24, A01–A07 довести первыми) — отдельное решение владельца.
- Судьбу вертикали TDLib — вопрос записан в `PLAN.md` §3 пакетом A1.
- Изменения схемы БД и формата резервной копии — ни один пошагово расписанный пакет их не содержит.
- Черновики фактов (`drafts`) и их подтверждение — остаются как есть до появления третьего вида предложения.
