# Acceptance crosswalk — все 96 сценариев памяти PersAI (28.10.2026)

**29.10.2026 · фактическое C1 после #217:** [PR #217](https://github.com/panasenkof/PersonalAI/pull/217), required CI [run 40837981692](https://github.com/panasenkof/PersonalAI/actions/runs/40837981692), merged `f9fa748a8ead76c22a653137cf4c563c269814be`. Реальный SQL сценарий `memory-sql-acceptance.test.ts` прошёл на точном head `4eb2a32b5acc9788b0b0b7a887ed2cfaf3bedea6`: user-approved note → canonical FTS → guarded source read → correction → FTS/old-read invalidation; hidden collection and source reclassification; link-only URL with unknown content/page/time. Поэтому **DOC-04** и **DOC-08** переходят из `REVIEW_REQUIRED` только в `PARTIAL_C1`, а **не** в `C1_PASS_EXACT_SHA`: ещё не проверены Android Share-вход, естественно-языковое уточнение «где обсуждался» и полноценное UI-открытие исходного материала. Ни один физический C2 не заявляется выполненным. Эта точная связка соответствует C0-A/C3-B без новых таблиц, хранилища, индекса, модели или альтернативного writer/search.

**Источник истины сценариев:** [MEMORY_SCENARIO_MATRIX_2026-10-27.md](MEMORY_SCENARIO_MATRIX_2026-10-27.md). Здесь нет дополнительного backlog или нового механизма хранения/поиска. В планировании по-прежнему первичен `PLAN.md §2`. Каждая строка ниже — **отдельное обязательство проверки**, не тест и не признание готовности всей функциональности.

**Значения C1:** `PARTIAL_C1` — уже найден узкий воспроизводимый unit/SQLite/UI тест, но полная цепочка не принята; `REVIEW_REQUIRED` — сопоставление ещё не выполнено; `C1_PASS_EXACT_SHA` — допускается **только после** настоящего E2E сценария, проверки запрещённого результата и записи `тестовый файл @40-символьный SHA CI-run`. Все строки, отмеченные `PARTIAL_C1`, **не являются PASS**. **Значения C2:** `NOT_RUN_PHYSICAL` — физическая проверка не выполнена; `C2_VERIFIED` — допустима только со ссылкой на существующий QA-отчёт по реальному Android/шифрованному backup и применимому оригиналу. `NOT_RUN_PHYSICAL` всегда требует `—` в поле C2 evidence. Это позволяет **впоследствии завершать** проверки, а не навсегда фиксировать NOT RUN. Не считать ни TM/RE чистые fixtures, ни зелёный CI физической приёмкой.

Для каждого следующего PR памяти: назвать затронутые IDs, воспроизвести отрицательные кейсы, указать реальный тест и точный SHA CI, обновить эту строку (с C2 отдельно). Если сценарий невозможно проверить на текущем устройстве — отметить блокировку, а не PASS. C3-консолидация только после M1–M4 и требований физической приёмки.

| ID | Проверяемая ситуация | C1 статус | C1 доказательство | C2 | C2 доказательство |
| --- | --- | --- | --- | --- | --- |
| TIME-01 | В 2021 работал в фирме А, в 2024 перешёл в Б | PARTIAL_C1 | `mobile/src/local-memory/__tests__/temporal-claims.test.ts` | NOT_RUN_PHYSICAL | — |
| TIME-02 | Сегодня загружен старый приказ 2019 года об увольнении из А | PARTIAL_C1 | `mobile/src/local-memory/__tests__/upgrade.test.ts` | NOT_RUN_PHYSICAL | — |
| TIME-03 | Основная работа А и подработка Б | PARTIAL_C1 | `mobile/src/local-memory/__tests__/temporal-claims.test.ts` | NOT_RUN_PHYSICAL | — |
| TIME-04 | Работа в Б планируется на следующий месяц | PARTIAL_C1 | `mobile/src/local-memory/__tests__/temporal-claims.test.ts` | NOT_RUN_PHYSICAL | — |
| TIME-05 | «Переехал примерно весной», точных дат нет | PARTIAL_C1 | `mobile/src/local-memory/__tests__/temporal-claims.test.ts` | NOT_RUN_PHYSICAL | — |
| TIME-06 | Прописка в городе А, проживание в городе Б | PARTIAL_C1 | `mobile/src/local-memory/__tests__/temporal-claims.test.ts` | NOT_RUN_PHYSICAL | — |
| TIME-07 | Два паспорта/документа о работе противоречат друг другу | REVIEW_REQUIRED | — | NOT_RUN_PHYSICAL | — |
| TIME-08 | «Что было известно год назад?» и «что было верно год назад?» | PARTIAL_C1 | `mobile/src/local-memory/__tests__/repository.test.ts` | NOT_RUN_PHYSICAL | — |
| CAR-01 | Свечи менялись в 2023 и 2025 | PARTIAL_C1 | `mobile/src/local-memory/__tests__/temporal-claims.test.ts` | NOT_RUN_PHYSICAL | — |
| CAR-02 | Менялась одна свеча из четырёх | REVIEW_REQUIRED | — | NOT_RUN_PHYSICAL | — |
| CAR-03 | Сервисный акт без госномера похожей машины | REVIEW_REQUIRED | — | NOT_RUN_PHYSICAL | — |
| CAR-04 | Продал машину в июне, купил другую в августе | PARTIAL_C1 | `mobile/src/local-memory/__tests__/repository.test.ts` | NOT_RUN_PHYSICAL | — |
| CAR-05 | Сохранил старый чек за шины сегодня | REVIEW_REQUIRED | — | NOT_RUN_PHYSICAL | — |
| CAR-06 | У авто два комплекта колёс, один сменён | REVIEW_REQUIRED | — | NOT_RUN_PHYSICAL | — |
| CAR-07 | Ошибка OCR: 160 000 км вместо 16 000 | REVIEW_REQUIRED | — | NOT_RUN_PHYSICAL | — |
| CAR-08 | Сервисный PDF содержит номер заказа и фото | REVIEW_REQUIRED | — | NOT_RUN_PHYSICAL | — |
| REL-01 | «Мама Ирина» и аудио разговора с Ириной | PARTIAL_C1 | `mobile/src/local-memory/__tests__/repository.test.ts` | NOT_RUN_PHYSICAL | — |
| REL-02 | «Папа Сергей» и фотография со встречи | REVIEW_REQUIRED | — | NOT_RUN_PHYSICAL | — |
| REL-03 | Две Марии работают в одной организации | PARTIAL_C1 | `mobile/src/local-memory/__tests__/repository.test.ts` | NOT_RUN_PHYSICAL | — |
| REL-04 | Друг Максим и коллега Максим — разные люди | REVIEW_REQUIRED | — | NOT_RUN_PHYSICAL | — |
| REL-05 | Коллега ушёл из компании, дружба осталась | REVIEW_REQUIRED | — | NOT_RUN_PHYSICAL | — |
| REL-06 | Аудио с упоминанием врача, но без врача на записи | PARTIAL_C1 | `mobile/src/local-memory/__tests__/repository.test.ts` | NOT_RUN_PHYSICAL | — |
| REL-07 | Подтверждено, что Елена = Лена, но Елена-2 неизвестна | REVIEW_REQUIRED | — | NOT_RUN_PHYSICAL | — |
| REL-08 | Отмена подтверждения ошибочного родства | PARTIAL_C1 | `mobile/src/local-memory/__tests__/repository.test.ts` | NOT_RUN_PHYSICAL | — |
| MED-01 | Анализы крови с разными единицами в разных лабораториях | REVIEW_REQUIRED | — | NOT_RUN_PHYSICAL | — |
| MED-02 | Результаты анализа спустя полгода | PARTIAL_C1 | `mobile/src/local-memory/__tests__/upgrade.test.ts` | NOT_RUN_PHYSICAL | — |
| MED-03 | Скан заключения врача и фотографии снимков | REVIEW_REQUIRED | — | NOT_RUN_PHYSICAL | — |
| MED-04 | Врач отменил лекарство в июле | REVIEW_REQUIRED | — | NOT_RUN_PHYSICAL | — |
| MED-05 | Назначение лекарства на будущий месяц | REVIEW_REQUIRED | — | NOT_RUN_PHYSICAL | — |
| MED-06 | OCR перепутал 1,0 и 10 в дозировке | REVIEW_REQUIRED | — | NOT_RUN_PHYSICAL | — |
| MED-07 | Врач назван в заметке, обсуждение записано с пациентом | PARTIAL_C1 | `mobile/src/local-memory/__tests__/repository.test.ts` | NOT_RUN_PHYSICAL | — |
| MED-08 | Групповая очистка старых результатов | REVIEW_REQUIRED | — | NOT_RUN_PHYSICAL | — |
| DOC-01 | Сохранены два варианта лазаньи с разными соусами | REVIEW_REQUIRED | — | NOT_RUN_PHYSICAL | — |
| DOC-02 | Рецепт переписан пользователем и дополнен заметкой | PARTIAL_C1 | `mobile/src/local-memory/__tests__/repository.test.ts` | NOT_RUN_PHYSICAL | — |
| DOC-03 | Веб-страница поменялась после сохранения | REVIEW_REQUIRED | — | NOT_RUN_PHYSICAL | — |
| DOC-04 | Сохранена только ссылка на статью | PARTIAL_C1 | `mobile/src/direct-agent/__tests__/memory-sql-acceptance.test.ts` | NOT_RUN_PHYSICAL | — |
| DOC-05 | Два репоста одной статьи с разными комментариями | REVIEW_REQUIRED | — | NOT_RUN_PHYSICAL | — |
| DOC-06 | Рецепт с фото и двумя видеоссылками | PARTIAL_C1 | `mobile/src/media/__tests__/attachments.test.ts` | NOT_RUN_PHYSICAL | — |
| DOC-07 | Из веб-страницы извлечён лишний футер | REVIEW_REQUIRED | — | NOT_RUN_PHYSICAL | — |
| DOC-08 | Вопрос «где обсуждался особый ингредиент?» | PARTIAL_C1 | `mobile/src/direct-agent/__tests__/memory-sql-acceptance.test.ts` | NOT_RUN_PHYSICAL | — |
| MEDIA-01 | Аудио названо «совещание», но участники не указаны | REVIEW_REQUIRED | — | NOT_RUN_PHYSICAL | — |
| MEDIA-02 | ASR путает «Лена» и «Лина» | REVIEW_REQUIRED | — | NOT_RUN_PHYSICAL | — |
| MEDIA-03 | Две записи приложены к одной заметке | PARTIAL_C1 | `mobile/src/media/__tests__/batch-recognition.test.ts` | NOT_RUN_PHYSICAL | — |
| MEDIA-04 | Транскрипция оборвалась на 40% | PARTIAL_C1 | `mobile/src/media/__tests__/batch-recognition.test.ts` | NOT_RUN_PHYSICAL | — |
| MEDIA-05 | Фраза найдена в видео без таймкода | PARTIAL_C1 | `mobile/src/local-memory/__tests__/repository.test.ts` | NOT_RUN_PHYSICAL | — |
| MEDIA-06 | PDF содержит 18 страниц, распознаны только 8 | REVIEW_REQUIRED | — | NOT_RUN_PHYSICAL | — |
| MEDIA-07 | Голосовая запись исправлена пользователем | REVIEW_REQUIRED | — | NOT_RUN_PHYSICAL | — |
| MEDIA-08 | Разговор сделан с другой персоной, но упоминают сестру | PARTIAL_C1 | `mobile/src/local-memory/__tests__/repository.test.ts` | NOT_RUN_PHYSICAL | — |
| SEARCH-01 | «Покажи все ремонты автомобиля за три года» | REVIEW_REQUIRED | — | NOT_RUN_PHYSICAL | — |
| SEARCH-02 | «Найди, где я не работал» | PARTIAL_C1 | `mobile/src/local-memory/__tests__/repository.test.ts` | NOT_RUN_PHYSICAL | — |
| SEARCH-03 | «В июле 2022 где жил?» | REVIEW_REQUIRED | — | NOT_RUN_PHYSICAL | — |
| SEARCH-04 | «Последний техосмотр» при 20 событиях | REVIEW_REQUIRED | — | NOT_RUN_PHYSICAL | — |
| SEARCH-05 | «У меня есть ещё такие фотографии машины?» | REVIEW_REQUIRED | — | NOT_RUN_PHYSICAL | — |
| SEARCH-06 | Поиск в закрытой папке и в публичной памяти | PARTIAL_C1 | `mobile/src/local-memory/__tests__/repository.test.ts` | NOT_RUN_PHYSICAL | — |
| SEARCH-07 | Сеть недоступна, локальная модель не установлена | REVIEW_REQUIRED | — | NOT_RUN_PHYSICAL | — |
| SEARCH-08 | Один и тот же вопрос длинный, с negation в конце | PARTIAL_C1 | `mobile/src/local-memory/__tests__/search-index.test.ts` | NOT_RUN_PHYSICAL | — |
| SAVE-01 | Модель предлагает новый адрес, пользователь выбирает «Позже» | PARTIAL_C1 | `mobile/src/local-memory/__tests__/upgrade.test.ts` | NOT_RUN_PHYSICAL | — |
| SAVE-02 | Пользователь отклонил связь двух тёзок | PARTIAL_C1 | `mobile/src/local-memory/__tests__/repository.test.ts` | NOT_RUN_PHYSICAL | — |
| SAVE-03 | Два окна подтверждают разные версии одного факта | PARTIAL_C1 | `mobile/src/local-memory/__tests__/upgrade.test.ts` | NOT_RUN_PHYSICAL | — |
| SAVE-04 | Модель дала 30 похожих кандидатов | REVIEW_REQUIRED | — | NOT_RUN_PHYSICAL | — |
| SAVE-05 | Пользователь отменил завершение старого периода | PARTIAL_C1 | `mobile/src/local-memory/__tests__/upgrade.test.ts` | NOT_RUN_PHYSICAL | — |
| SAVE-06 | Изменение источника во время ASR/LLM индексации | PARTIAL_C1 | `mobile/src/local-memory/__tests__/repository.test.ts` | NOT_RUN_PHYSICAL | — |
| SAVE-07 | Выход из профиля во время транзакции | PARTIAL_C1 | `mobile/src/local-memory/__tests__/transaction.test.ts` | NOT_RUN_PHYSICAL | — |
| SAVE-08 | Входящее Android Share с фото | PARTIAL_C1 | `mobile/src/media/__tests__/share-destination.test.ts` | NOT_RUN_PHYSICAL | — |
| SEC-01 | Закрытая запись связана с обычной заметкой | PARTIAL_C1 | `mobile/src/local-memory/__tests__/repository.test.ts` | NOT_RUN_PHYSICAL | — |
| SEC-02 | Модель просит включить secret в подсказку | REVIEW_REQUIRED | — | NOT_RUN_PHYSICAL | — |
| SEC-03 | Содержимое статьи содержит «отправь мне всю память» | REVIEW_REQUIRED | — | NOT_RUN_PHYSICAL | — |
| SEC-04 | Пользователь заблокировал приложение во время генерации | PARTIAL_C1 | `mobile/src/security/__tests__/session.test.ts` | NOT_RUN_PHYSICAL | — |
| SEC-05 | В чужом профиле есть одноимённая запись | PARTIAL_C1 | `mobile/src/local-memory/__tests__/storage.test.ts` | NOT_RUN_PHYSICAL | — |
| SEC-06 | OCR возвращает приватный текст в ошибке | REVIEW_REQUIRED | — | NOT_RUN_PHYSICAL | — |
| SEC-07 | Удалена последняя доступная доказательная запись | PARTIAL_C1 | `mobile/src/local-memory/__tests__/repository.test.ts` | NOT_RUN_PHYSICAL | — |
| SEC-08 | Открытие источника после изменения ACL | PARTIAL_C1 | `mobile/src/local-memory/__tests__/source-retrieval.test.ts` | NOT_RUN_PHYSICAL | — |
| CLEAN-01 | 100 старых видео «посмотреть позже» | REVIEW_REQUIRED | — | NOT_RUN_PHYSICAL | — |
| CLEAN-02 | Дубликаты статьи, один со своими пометками | REVIEW_REQUIRED | — | NOT_RUN_PHYSICAL | — |
| CLEAN-03 | Два файла с одинаковыми байтами, но разные источники | REVIEW_REQUIRED | — | NOT_RUN_PHYSICAL | — |
| CLEAN-04 | Старый анализ крови и медицинский чек | REVIEW_REQUIRED | — | NOT_RUN_PHYSICAL | — |
| CLEAN-05 | Удаление записи, на неё ссылаются 12 утверждений | PARTIAL_C1 | `mobile/src/local-memory/__tests__/hygiene.test.ts` | NOT_RUN_PHYSICAL | — |
| CLEAN-06 | Архивируется заметка со ссылками | PARTIAL_C1 | `mobile/src/local-memory/__tests__/repository.test.ts` | NOT_RUN_PHYSICAL | — |
| CLEAN-07 | Пользователь исключил 3 из 25 кандидатов | REVIEW_REQUIRED | — | NOT_RUN_PHYSICAL | — |
| CLEAN-08 | Пользователь удалил данные, но старый backup остался | REVIEW_REQUIRED | — | NOT_RUN_PHYSICAL | — |
| BKP-01 | Старый v7 backup без claim tables | PARTIAL_C1 | `mobile/src/local-memory/__tests__/backup.test.ts` | NOT_RUN_PHYSICAL | — |
| BKP-02 | Новый v11 backup с temporal decisions | PARTIAL_C1 | `mobile/src/local-memory/__tests__/backup.test.ts` | NOT_RUN_PHYSICAL | — |
| BKP-03 | Диск переполнен в середине restore | PARTIAL_C1 | `mobile/src/local-memory/__tests__/backup.test.ts` | NOT_RUN_PHYSICAL | — |
| BKP-04 | Потеря питания при индексировании 10k записей | REVIEW_REQUIRED | — | NOT_RUN_PHYSICAL | — |
| BKP-05 | Модель embeddings меняет размерность | PARTIAL_C1 | `mobile/src/local-memory/__tests__/repository.test.ts` | NOT_RUN_PHYSICAL | — |
| BKP-06 | Заметок стало 100 тысяч, чтение из памяти с телефона | PARTIAL_C1 | `mobile/src/local-memory/__tests__/synthetic-scale.test.ts` | NOT_RUN_PHYSICAL | — |
| BKP-07 | Вложения 2+ ГиБ, действующий архив ограничен | REVIEW_REQUIRED | — | NOT_RUN_PHYSICAL | — |
| BKP-08 | Пользователь восстанавливает backup в другую учётную запись | REVIEW_REQUIRED | — | NOT_RUN_PHYSICAL | — |
| ACT-01 | «Напомни купить молоко при входе в магазин» | REVIEW_REQUIRED | — | NOT_RUN_PHYSICAL | — |
| ACT-02 | GPS неточный, пересёк границу геозоны дважды | REVIEW_REQUIRED | — | NOT_RUN_PHYSICAL | — |
| ACT-03 | «Включи лампу» без подключённого сервиса | REVIEW_REQUIRED | — | NOT_RUN_PHYSICAL | — |
| ACT-04 | Домашняя автоматика доступна только на чтение | REVIEW_REQUIRED | — | NOT_RUN_PHYSICAL | — |
| ACT-05 | В беседе обсуждали адрес работы, но не просили запомнить | REVIEW_REQUIRED | — | NOT_RUN_PHYSICAL | — |
| ACT-06 | Рецепт и список продуктов порождают задачу покупки | REVIEW_REQUIRED | — | NOT_RUN_PHYSICAL | — |
| ACT-07 | Был визит в музей, но потом переименовали место | REVIEW_REQUIRED | — | NOT_RUN_PHYSICAL | — |
| ACT-08 | Снимок экрана содержит кнопку «удалить всё» | REVIEW_REQUIRED | — | NOT_RUN_PHYSICAL | — |

**Сводка:** 96 уникальных кейсов, 12 доменов × 8; 42 `PARTIAL_C1` (не полноценный PASS), 54 `REVIEW_REQUIRED`, 96 `NOT_RUN_PHYSICAL`. Не путать статический mapping с выполнением тестов. Новые T3b2a изменения #197 переносятся в матрицу после прохождения CI и слияния, без предварительного PASS.
