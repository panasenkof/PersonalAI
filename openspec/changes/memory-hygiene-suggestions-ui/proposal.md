# №79б/в · Опциональные предложения групп для ревизии памяти

## Проблема
В `main` уже существуют read-only bounded `MemoryHygieneService.discoverGroups(100)` и отдельная ручная групповая ревизия (`previewWithExclusions` → `changeNotes` с CAS guard → `undoNotes`). Но пользователь не мог открыть обнаруженные группы без ручного выделения записей. Новый поисковый механизм или экран верхнего уровня не нужны.

## Решение / границы
- В существующем меню «Память» — опция «Предложения для ревизии».
- При явном нажатии запускается единственный bounded read-only scan стандартных активных источников. Результат объясняет, что совпадение *точного* URL не означает дубль, а `read_later` не означает бесполезности.
- Для группы показывается основание и число записей, но **никакие действия автоматически не применяются**. Для частичного результата показывать `partial`; не утверждать «дублей нет во всей памяти».
- При нажатии на группу: existing `previewWithExclusions` revalidates source versions, collection ACL and item ACL **before** fetching titles. Reject stale/deleted/closed sources. Use existing `repository.entity` just for checked record metadata; validate current exact versions, standard-only, unlocked profile.
- Передать полученные записи в тот же `hygieneReviewOpen` bottom sheet — per-item exclusions, change archive→trash choice, confirm, rollback, existing `changeNotes/undoNotes`. Do not add a second write, store, queue, new status, LLM or model calls.
- On AppLock, profile/collection/filter change, sheet close: clear suggestions, selected review copies, pending preview/confirmation and discard late asynchronous results. Reader/writer enforce their own session checks.
- Original manual selection→preview path continues unchanged. UI respects system Back and current Nebula primitives; no global «выбрать всё».
- Out of scope: detecting semantic duplicates, deciding that an older article/video is outdated, automatic cleanup, original purge, background scheduling, fetching arbitrary number of sources, private/secret scan. These are `Plans/MEMORY_OPTIONAL_AFTER_ACCEPTANCE.md` if optional.

## C0-A / C3-B архитектура
Before: one SQLCipher `memory_entities` and `memory_cleanup_preferences`; one `hygiene().discoverGroups`, `previewWithExclusions`, `changeNotes`, `undoNotes`; one `LocalMemoryScreen` list. Confirmed after: no new database migration or persistent state; UI-only bounded workflow on same canonical reader/writer, CAS and ACL repeated on apply.

## Сценарные проверки
- CLEAN-01/02/07: exact URL group, read-only list, partial/truncated warning, exclusions, never auto apply; explicit final confirmation applies only eligible included ID versions through `changeNotes`.
- SEC-01: if source privacy/version changes after scan, do not read its title or open review.
- SEC-04: lock clears UI and cancels applying late data.
- CLEAN-05/08: guarded writer handles relationships, pin/defer/never_suggest, stale policy/source and undo as in existing native SQLite tests.
- Android CI (TypeScript/Jest/browser/native) before merge; physical C2 separately NOT RUN unless specifically tested.

**Exit:** User can access eligible group suggestions, review and exclude each item, confirm/undo manually, and read-only discovery never mutates source data.
