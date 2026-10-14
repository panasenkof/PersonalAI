# Сборка и публикация Android APK

Сборка: [Android test APK — GitHub Actions](https://github.com/panasenkof/PersonalAI/actions/workflows/android-test-apk.yml). Постоянные APK: [GitHub Releases](https://github.com/panasenkof/PersonalAI/releases).

После успешного CI в ветке `main` workflow собирает новую версию, если последний коммит затронул `mobile/` или сам workflow. Ручной запуск возможен через `Actions → Publish Android test APK → Run workflow` (ветка main), но тоже требует зелёного CI на **том же коммите**. Он никогда не подписывает/публикует APK из PR, с красным CI или из устаревшей ветки.

## Однократная настройка владельцем репозитория

1. Выберите **постоянный Android package ID**, например `com.yourcompany.persai`. Менять его после установки нельзя без фактической установки отдельного приложения.
2. Создайте отдельный **долговременный** ключ подписи Android, например установленным JDK через `keytool -genkeypair -v -keystore pia-release.jks -alias persai -keyalg RSA -keysize 3072 -validity 10000`. Установите сильные пароли и сохраните сам JKS/PKCS12 в надёжном офлайновом хранилище. Не добавляйте файл и пароли в Git.
3. В `Settings → Secrets and variables → Actions → Variables` создайте:
   - `PIA_ANDROID_PACKAGE` = выбранный идентификатор. Для уже установленных у пользователей сборок это `com.paigent.app` — не меняйте его.
   - Переменная `PIA_ANDROID_API_BASE` больше не используется: у приложения нет сервера. Её можно удалить.
4. В том же разделе в **Repository secrets** создайте:
   - `PIA_ANDROID_KEYSTORE_B64` — base64-содержимое JKS/PKCS12. PowerShell: `[Convert]::ToBase64String([IO.File]::ReadAllBytes((Resolve-Path .\pia-release.jks)))`. Скопируйте результат **только в GitHub Secret**, не публикуйте в PR, сообщениях, логах.
   - `PIA_ANDROID_KEY_ALIAS` — alias из keytool
   - `PIA_ANDROID_STORE_PASSWORD` — пароль хранилища
   - `PIA_ANDROID_KEY_PASSWORD` — пароль ключа (если отдельный пароль не задан, используйте пароль хранилища)
5. Откройте `Actions → Publish Android test APK → Run workflow`. После успешных шагов сборки получите prerelease с вложениями `.apk` и `.sha256`.
6. Убедитесь, что для Actions разрешена запись в Contents через настройки репозитория и политики организации: workflow явно запрашивает `contents: write`. Никогда не используйте pull_request_target для публикации.

Никакой регистрации в EAS для этого варианта не нужно; используется GitHub-hosted Linux runner, Expo prebuild, Gradle assembleRelease и штатная Android-подпись. Без настроенных Secrets/Variables сборка **останавливается с понятной ошибкой** и не публикует фиктивный APK.

## Установка и обновление телефона

На Android откройте GitHub Releases, выберите последнюю **Android test** prerelease, скачайте `PersAI-android-test-bNN-aN.apk` (выпуски до перехода на мобильную версию назывались `PersonalAI-…`), разрешите установку из этого источника при запросе Android. Это автономный release-бинарник, Metro для работы не нужен. Ключ API модели вводится на телефоне. Для входа нужна блокировка экрана телефона: PIN-код, пароль, графический ключ или биометрия.

Устанавливайте новый APK **поверх** прежнего, не удаляя приложение: обновление сохранит зашифрованную память только при одинаковых Android package ID и ключе подписи и при корректных миграциях приложения. Версия Android `versionCode` растёт на основе номера workflow. Если Android сообщает о несовпадении подписи или понижении версии, **не удаляйте приложение для обхода ошибки**: сначала сохраните и проверьте резервную копию локальной памяти, затем исправьте конфигурацию публикации.

Проверка каждого тестового APK: вход, создание локальной заметки, закрытие/перезапуск, биометрия, работа без сети, сохранность при обновлении, экспорт зашифрованной копии и восстановление в отдельном **пустом** профиле с правильным и неправильным кодом. См. [DEVICE_QA.md](DEVICE_QA.md) и [MEMORY_AND_SECURITY.md](MEMORY_AND_SECURITY.md).

**Важно:** выпуск в GitHub Releases пока не означает Android runtime sign-off или готовность к публичному релизу. Сохраните отдельную резервную копию keystore; потеря ключа подписи блокирует нормальное обновление установленных приложений.

Для локального тестирования Node-скриптов без Android SDK: `cd mobile && node --test scripts/prepare-android-release.test.cjs`. Нативную сборку проверяет сам workflow после объединения PR. В PR выполняется существующая SQLCipher debug-компиляция и тесты, но до настройки секретов невозможна проверка настоящего подписанного APK.

## Проверка нативной сборки в pull request

Workflow `mobile-native-sqlcipher.yml` для каждого PR с изменениями в `mobile/` выполняет `expo prebuild --clean` с плагином SQLCipher, собирает debug-APK и release-APK с одноразовым ключом CI. Это доказывает, что нативная часть компилируется, но не то, что шифрование работает на устройстве.
