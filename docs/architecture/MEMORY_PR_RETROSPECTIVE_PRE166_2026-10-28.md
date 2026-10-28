# PersAI — ретроспективная архитектурная сверка PR #134–165 (28.10.2026)

**Область:** GitHub PR #134–165: статусы `merged`, фактические base branches, состав изменённых файлов и выборочная проверка реализационных patches (backup, FTS/search, note/source tools, durable vector jobs, extraction, PDF). Сопоставлено с действующим `main`, [поздним аудитом #166–185](MEMORY_PR_RETROSPECTIVE_2026-10-28.md), `AGENTS.md`, `docs/DEVELOPMENT_GATES.md` и `PLAN.md §2`. **Это ретроспективная статическая архитектурная проверка, а не утверждение, что тогда выполнялись C0-A или C3-B.** Полный повтор C1/Android C2 и физический backup/restore здесь не выполнялся. Старые green CI принадлежат прежним SHA.

## Матрица PR и архитектурных последствий

| PR | Проверенное изменение | Итог архитектурной сверки / остаток |
| --- | --- | --- |
| #134 | Preflight для legacy backup, аудит ограничений | REUSE SQLCipher/backup; preflight не равен надёжному многогигабайтному restore |
| #135 | Share receipts в restore, merged **в промежуточную ветку** | **A1 GAP**: статус merged не означал наличие в main; фактически восстановлено #141 |
| #136 | Длинный пользовательский запрос и FTS | REUSE одного существующего поискового входа; остальная точность поиска отдельно |
| #137 | Индексация observation/typed полей, merged **в #136-ветку** | **A1 GAP**: реальное включение в main через #143 |
| #138 | Адресное чтение заметки агентом, merged **в #137-ветку** | **A1 GAP**: реальное включение в main через #144 |
| #139 | Промежуточный SQL LIMIT/OFFSET для векторов, merged **в #138-ветку** | **A1/A2 GAP**: в main перенесён улучшенный keyset через #149; durable job queue позже #156 |
| #140 | Иерархия единого плана, merged **в #134-ветку** | **A1 GAP**: актуальные изменения восстановлены через #142, без второго roadmap |
| #141 | Перенос receipts в main | A1 repair — единственный существующий backup; после restore нужна C2-проверка |
| #142 | Перенос плана/статусов в main | A1 repair — одна очередь и один статус-регистр |
| #143 | Перенос typed/observations FTS в main | A1 repair; derived FTS, не отдельное хранилище знаний |
| #144 | Перенос `readApprovedNote` в main | A1 repair; bounded note read, revision/ACL, не независимый memory store |
| #145 | Устаревший промежуточный perf PR **закрыт без merge** | NOT IN MAIN; не учитывать как поставленный код |
| #146 | Шифрованный manifest и расширение политики объёмов backup | REUSE SQLCipher; **A3** многогигабайтный physical restore не доказан |
| #147 | `list/count` агента, SQL-проверки доступа | Каталог разрешённых метаданных; **A4** следить за согласованностью фильтров с основным поиском |
| #148 | Negative/year evidence guard | Никакого второго индекса; evidence gate перед выдачей ответа |
| #149 | Keyset вместо OFFSET в vector batches | A2 repair; после #156 legacy batch не должен становиться второй очередью |
| #150 | Портативный архив Engineering Harness v1.1 | Docs/ZIP-only; правила в активном репозитории обновлены позже #186, ZIP не считать автоматически синхронизированным |
| #151 | Manifest export/restore count checks до COMMIT | REUSE прежнего backup; **A3** physical device и большое хранилище отдельно |
| #152 | Coverage/source range для note read | Дополняет существующее чтение, не вводит новый источник истины |
| #153 | Синтетические 1k/10k scale tests | CI fixture, не доказательство производительности/надёжности на реальном телефоне |
| #154 | Фиксация C1/C2 и ручной приёмки | Docs-only, без runtime второго статуса |
| #155 | Разделение embedding model/backend spaces | Производные vectors с явной версией; другие пространства не объединять при поиске |
| #156 | SQLCipher v8 durable vector job queue, lease/rollback | **A2 repair** — одна авторитетная очередь подготовки derived vectors; schema/backup согласованы |
| #157 | SHA-256 downloaded embedding artifacts | Продолжение namespace одного vector pipeline; модели не выдавать за идентичные по названию |
| #158 | SQLCipher v9 source/versioned extraction provenance | Новые evidence записи об исходниках, не дублирующие первичные файлы; **A3** archive roundtrip обязателен |
| #159 | ACL/version guarded source-segment reader для агента | Чтение оригинального сегмента отдельно от чтения note; **A4** единая политика доступа обязательна |
| #160 | C3 per-PR consolidation и post-memory milestone | Первое явное архитектурное правило, дополненное обязательным pre/post в #186 |
| #161 | SQLCipher v10 derived source-segment FTS | **A4** два derived поисковых представления (заметки/сегменты) не должны стать двумя источниками истины |
| #162 | Привязка ASR к своему оригиналу при multi-file | Single original+revision; нет выдуманного provenance для объединённой расшифровки |
| #163 | Реальные ASR time ranges, validation | Только source-provided ranges; нет придуманных word-level timestamps |
| #164 | Android 15+ PDF page extraction через native API | Отдельный reader исходной страницы, не новый память-store; Android below API35 отдельно |
| #165 | Android 12–14 S Extensions PDF + native fixture | Дополняет тот же PDF reader; native CI не доказывает physical C2 |

## Результаты и обязательные действия

**A1 — CONFIRMED / repaired in later main PRs.** У #135, #137–140 статус `merged=true` относился к родительским feature-веткам, не к конечному main. #141–144/#149 вернули необходимый код, а #145 закрыт без merge. После **каждого** нового merge сверять `base.ref`, изменённые файлы и реально доступные symbols в дереве main, затем CI итогового SHA. Не выдавать stacked merge за delivery. Проверка уже закреплена в `docs/DEVELOPMENT_GATES.md`.

**A2 — historical temporary implementation / repaired for active pipeline.** Сканирование всех chunks из #139 не должно стать альтернативой durable SQLCipher vector-job очереди #156. #149 перенёс keyset, #156 ввёл leases. При будущем C3 (PLAN §2, step 6.5) найти реально используемых callers legacy pending-batch и убрать только подтверждённый мёртвый путь; до этого не менять память параллельно с миграцией.

**A3 — PARTIAL / known coverage gap.** Manifest, FK/counted restore и versioned extraction развивались #146/#151/#158 и после #168/#179/#184. Статические/SQL fixtures не заменяют реальную проверку шифрованного восстановления с файлами и большим объёмом. Не утверждать C2 PASS; продолжать в существующей матрице `Plans/MEMORY_C1_C2_ACCEPTANCE_2026-10-27.md`.

**A4 — REVIEW RISK, not proof of duplicate truth.** #143 (note FTS), #147 (metadata list), #159 (source reader), #161 (source FTS) и #144 (full note reader) обслуживают разные типы результатов. Первичный источник — `memory_entities`/original attachments/extraction evidence в одном SQLCipher; FTS/vector — **только производные**. Каждое новое чтение должно использовать те же ACL/current revision/profile, а объединение поисковых фильтров выполнять через существующий repository/search contract, без второго общего memory engine. Review actual code after #187's consistent read, не считать старые отдельные вызовы автоматически безопасными.

**A5 — portability drift.** Архив переносимого Harness из #150 предшествует правилам C0-A/C3-B из #186. При следующем обновлении архива синхронизировать правила; не править старый бинарный ZIP «на месте» без проверки содержимого и версий. Это не блокирует M1–M4.

**Дальше:** [аудит #166–185](MEMORY_PR_RETROSPECTIVE_2026-10-28.md) фиксирует F1–F6; #186 закрепил C0-A/C3-B; #187–189 исправили F1/обсудили общий review/починили hard purge. #190 — **OPEN draft**, R2b1 v14 candidate: до завершения его exact-head CI, backup/privacy тестов и фактического merge нельзя объявлять R2b1 доставленным. Следующий шаг после проверки — R2b2 подтверждения/отклонения с одной канонической записью отношений и существующим review-журналом. Широкая консолидация — **только после M1–M4, PLAN §2 step 6.5**.

## Проверочный стандарт

- Ретроспектива **не** сертифицирует исторические C0-A: до появления требования их нельзя выполнить задним числом.
- Статус строки MATCH относится только к названному техническому срезу. Android/backup/LLM/E2E остаются NOT RUN или PARTIAL, где их не проверяли.
- Для будущего PR обязательны отдельно **C0-A до изменения** и **C3-B после diff**, проверяемая привязка к файлам, single source-of-truth и доказанный `main` target; CI проверяет наличие содержательных разделов, но не подменяет экспертную архитектурную оценку.
