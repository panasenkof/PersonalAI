# PR2.B10 — доставка официальной TDLib в подписанный APK (ручная приёмка)

Дата: 11.11.2026. Статус: **CODE_CANDIDATE; TDLib source build NOT_RUN; Android acceptance NOT_RUN; Vivo NOT_RUN_PHYSICAL.**

## Цель и архитектурные ограничения C0-A
До пакета имеются TDLib JSONJava мост, чтение собственного «Избранного»/подборок, SQLCipher canonical writer, резервный бот, ручной source build и ephemeral Android acceptance. Обычная публикация APK автоматически запускается после зелёного CI и **не содержит TDLib**. Не добавлять ни нового writer/индекса, ни второго пути доверия к артефакту.

B10 использует **тот же** `mobile/scripts/tdlib/stage-reviewed-run.sh` как в ephemeral Android gate, так и в официальной подписанной сборке. Входной бинарник нельзя передать URL/путём или скачать из произвольной ветки.

## Что изменено

- Ручной `Publish Android release APK` (`workflow_dispatch`) принимает пару **tdlib_source_run_id + tdlib_archive_sha256**. Пустая пара означает привычный APK без Telegram TDLib; частично заполненная пара — ошибка до сборки.
- Ровно для ручной заявки с двумя параметрами скачивается артефакт успешного официального TDLib source workflow, на доверенном `main`; сверяются идентификатор/репозиторий/event/name/path/status, родословная SHA коммита, SHA-256 всего tar.gz, whitelist архива, manifest, ELF, обе ABI и 16-КБ PT_LOAD.
- Библиотека и Java ABI добавляются в существующий Expo-модуль до `expo prebuild`; нет отдельного APK-пайплайна. Подпись сохраняется прежней (release key), пакет `com.persai.app`.
- Подписанный arm64 APK дополнительно проверяется на `libtdjsonjava.so`, 16-КБ ZIP alignment, наличие JNI `JsonClient` в DEX, apksigner и точное совпадение сертификата с релизным ключом.
- Автоматический `workflow_run` **никогда не включает TDLib**. Если в обычный APK попадёт JNI без явного opt-in, публикация прерывается. В release notes явно указано, присутствует библиотека или нет.
- Отдельные regression tests проверяют защиту от веток PR, некорректного run ID/digest и однообразие source staging.

## Обязательная последовательность выхода на телефон

1. Убедиться, что B10 попал в main и CI прошёл на том же SHA; исходный B11 в main.
2. В GitHub → **Actions** → **Build official TDLib JSONJava bundle (manual)** → **Run workflow**, ветка `main`. Ждать **success**. Войти в run, сохранить его цифровой ID; открыть этап `Verify manifest and package artifact` и скопировать SHA-256 файла `official-tdlib-jsonjava-android.tar.gz`. Это **не** SHA ZIP-артефакта GitHub.
3. В Actions → **TDLib official-source Android APK acceptance (manual)** → Run workflow, `main`, указать только `tdlib_source_run_id`. Требовать **success** для Expo/SQLCipher/emulator, R8/JNI/16 KiB, provenance. Провал — не обходить ручным release.
4. В Actions → **Publish Android release APK** → Run workflow, `main`, заполнить **обе** опции: `tdlib_source_run_id` (из пункта 2) и `tdlib_archive_sha256` (из пункта 2). Без успешного пункта 3 этот шаг **не запускать**. Только эта сборка официально подписана для обновления установленного PersAI; emulator APK из пункта 3 имеет иной временный сертификат.
5. Найти новый `android-test-b…` release, проверить, что примечание содержит `Telegram TDLib: official source`, сохранить APK checksum и записать commit SHA. Установить **поверх предыдущей версии**, без удаления данных.
6. На Vivo X200 Pro Android 16: Telegram API credentials, авторизация номером/кодом/2FA, AppLock, logout, «Избранное», подборки, повторный импорт без дублей, отсутствие доступа к чужим чатам, offline/retry/rollback; записать доказательства и ошибки в `docs/testing/reports/`.

## Важные ограничения

- Этот PR **не запускает** ручные workflow и **не гарантирует** работоспособность TDLib до source/emulator/physical gates.
- B10 не добавляет оригиналы фото/видео/документов/альбомов; существующий TDLib импорт — **тексты/ссылки по 20**, а неподдержанные медиа пропускаются.
- Пара `run_id + SHA-256` вводится только оператором; код не должен автоматически брать «последний успешный» TDLib artifact.
- Пока source run не получен, **статус Telegram Personal Account = BLOCKED_ON_NATIVE_BINARY**, резервный Bot API остаётся самостоятельным текстовым каналом.

## Postflight C3-B
Общий `stage-reviewed-run.sh` — единственный путь provenance, source artifact и release используют одну проверку. База SQLCipher, LLM, Media writer, backup/restore, AppLock и networking TDLib не изменены. Физические тесты и реальные бинарники отсутствуют; не отмечать READY.
