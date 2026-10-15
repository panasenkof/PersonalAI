# Design: схема памяти v3

## Таблицы (все внутри SQLCipher)

| Таблица | Поля | Назначение |
| --- | --- | --- |
| `memory_entities` (есть) | + `kind TEXT NOT NULL DEFAULT 'note'` | Тип записи |
| `memory_chunks` (новая) | `id`, `entity_id` → entities, `ord`, `text`, `content_hash`, `created_at` | Куски для поиска и передачи модели |
| `memory_aliases` (новая) | `entity_id`, `alias`, `normalized`, UNIQUE(entity_id, normalized) | Имена и прозвища |
| `memory_index_terms` (новая) | `entity_id`, `terms`, `source` (`user` / `model:<имя>`), `created_at` | Индексные слова |
| `memory_vectors` (новая) | `chunk_id` → chunks, `model`, `dim`, `vector BLOB` (float32), `content_hash` | Векторы; пересчёт, если `content_hash` или `model` изменились |
| `memory_search_fts` (новая FTS5) | `entity_id UNINDEXED`, `chunk_id UNINDEXED`, `title`, `body`, `terms`, `aliases`; `prefix='2 3 4'` | Поиск: фраза, слова, основы, индексные слова, имена |

`memory_notes_fts` остаётся до конца миграции, затем удаляется.

## Миграция
1. `BEGIN IMMEDIATE`; создать новые таблицы.
2. Для каждой записи: `kind` = `note` (или `person` для раздела «Люди»), куски из `payload.body`, строка в `memory_search_fts`.
3. `PRAGMA user_version = 3`; `COMMIT`. Ошибка — `ROLLBACK`, база остаётся v2.
4. Индексные слова и векторы для старых записей строятся позже, в фоне.

## Поиск
Ранжирование — RRF по спискам: FTS (bm25), имена/связи, векторы; поправка на свежесть (`updated_at`, `valid_until`) и раздел. В модель — не больше пяти кусков, только из обычных разделов.
