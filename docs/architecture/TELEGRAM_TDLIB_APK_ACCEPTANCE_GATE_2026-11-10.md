# Telegram B9 — проверенный TDLib в Android acceptance APK

Статус 10.11.2026: **CODE_CANDIDATE / TDLib binary NOT_BUILT / Vivo NOT_RUN_PHYSICAL**. В этом пакете создаётся ручной контур поставки официального артефакта в подписанный тестовый Android APK. Обычный APK для пользователей пока не содержит TDLib.

## Preflight C0-A / C3-B

В main уже существуют узкий TDLib Expo JSONJava bridge, авторизация, чтение Saved Messages/Topics, один canonical saveMediaNote (SQLCipher/FTS) и отдельный резервный Bot API. Бинарники JNI и официальный Java ABI в обычном APK отсутствуют. Никаких вторых writer/index/agent/storage создавать нельзя.

## Два ручных workflow на доверенном main

1. **Build official TDLib JSONJava bundle (manual)**: закреплённый tdlib/td commit c8828d50f5eac2fc7089ce1089d7ce9095c61b5e, OpenSSL tag openssl-3.5.9, NDK 27.0.12077973; arm64-v8a и x86_64. Проверка SHA-256, ELF64 и 16 KiB PT_LOAD. Публикуется артефакт GitHub Actions (retention 30 дней), но не APK.
2. **TDLib official-source Android APK acceptance (manual)**: ввод run ID успешного первого workflow. Использует тот же reusable mobile-native-sqlcipher.yml, что и основной CI: Expo/SQLCipher/vision, подписанный одноразовым ключом release APK и Android emulator smoke. Не публикует пользовательский APK.

## Доверенный источник и безопасность

При opt-in загрузке проверяются числовой run ID, точный workflow name/path, completed+success, event workflow_dispatch, head_branch main, совпадение source/head repository с PersonalAI и принадлежность source SHA к истории текущего main (git merge-base --is-ancestor).

Имя запрашиваемого артефакта привязано к source SHA. Пакет раскрывается только по whitelist: нет произвольных путей, символических/жёстких ссылок, устройств, дубликатов, превышений размеров. Далее штатный bundle.cjs заново проверяет manifest, исходный commit и OpenSSL tag, SHA-256 содержимого, ELF architecture и 16 KiB. В Expo-модуль попадают только две libtdjsonjava.so и оригинальный JsonClient.java. R8 consumer-rules.pro сохраняет JNI имена. В Android x86_64 APK проверяется библиотека и 16 KiB ZIP alignment. Обычные сборки с пустым input проверяют, что случайной TDLib библиотеки в них нет.

Никаких новых Android permission, разрешений контактов, серверов, внешних LLM-вызовов, SQL миграций, второго хранилища или обходного импорта. Ключи/коды авторизации Telegram остаются только на устройстве, не передаются в GitHub Actions и не включаются в обычный backup PersAI.

## Приёмка и следующий шаг

1. После слияния B9 в main и CI SUCCESS зайти в GitHub Actions, запустить Build official TDLib JSONJava bundle (manual) на main **один раз**; сохранить run ID. Сборка может быть ресурсоёмкой, автоматический запуск на каждом PR запрещён.
2. Запустить TDLib official-source Android APK acceptance (manual) на main, указать run ID первой сборки. Убедиться в успехе checks provenance/stage/SDK/R8/JNI/16 KiB/Expo/SQLCipher/emulator.
3. Отдельным PR зафиксировать проверенный артефакт и его digest, включить его в официальный подписанный arm64 APK с сохранением существующего ключа подписи. Не выдавать APK с одноразовым CI-ключом за обновление обычного PersAI.
4. На Vivo X200 Pro Android 16 проверить номер/код/2FA/email, AppLock, logout/reconnect, Saved Messages и Topics, duplicate/retry, offline, импорт текста и сохранение приватности. Физически всё ещё NOT_RUN_PHYSICAL.

**Остаётся:** реальный официальный TDLib binary source-run, принятый APK, оригиналы фото/видео/документов и альбомы, полный backfill (автоимпорт сейчас до 20 текстов за запуск), тест на Vivo.

## Postflight C0-A / C3-B

Новое только provenance/архив validation и opt-in интеграция в единый native workflow. Нет новых слоёв хранения, записи заметок, индекса, агентных команд или фоновых сервисов. Точный CI HEAD SHA — обязательный gate до merge.
