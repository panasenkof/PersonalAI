# TDLib: официальная воспроизводимая сборка (PR2.B1)

Срез 10.11.2026. **Это подготовка нативного артефакта, не работающий Telegram-клиент.**

- TDLib: официальный tdlib/td, commit c8828d50f5eac2fc7089ce1089d7ce9095c61b5e.
- OpenSSL: официальный release openssl-3.5.9 (из LTS 3.5), фиксированный tag.
- Android NDK 27.0.12077973; minSdk 26; интерфейс JSONJava;
  ABI arm64-v8a (Vivo) + x86_64 (CI emulator).
- Ручной workflow .github/workflows/telegram-tdlib-source.yml выполняет
  официальные example/android/build-openssl.sh и build-tdlib.sh,
  не доверяет сторонним .aar и не меняет обычный APK.
- Артефакт содержит libtdjsonjava.so под обе архитектуры и официальную
  JsonClient.java; проверяются SHA-256, ELF64 architecture, размеры, точный
  whitelist файлов и manifest с версией исходников.
- Проверка хэшей предотвращает случайную порчу, **не доказывает происхождение**
  сама по себе: требуется сверить run CI, исходный commit и код builder.
- Перед Android-развёртыванием отдельно проверить 16 KiB page alignment,
  JNI ABI, R8, SSL symbols, лицензии, x86_64/ARM64, размер, очистку сессии.
- Никогда не хранить ключ Telegram/TDLib в исходниках или бэкапах по умолчанию.

## Архитектурная сверка C0-A/C3-B до/после

Существуют canonical SQLCipher writer saveMediaNote, одна память/поиск,
AppLock и резервный Telegram Bot API. PR2.B1 не добавляет вторую БД,
второй индекс, сетевой агент, бэкграунд-сервис или новые permissions.
Доступ к сообщениям через TDLib НЕ включён: до PR2.B2 не выдавать READY.

## Следующие PR

1. PR2.B2: узкий Expo native bridge к официальному JSONJava, один receiver,
   авторизация через TDLib states, защищённый keychain/TDLib cache, revoke.
2. PR2.B3: Telegram user auth UI (номер, код, 2FA, email/QR по состоянию),
   fail closed, интеграция library gate в Android CI.
3. PR3/4: Self Saved Messages и Saved Messages Topics, bounded pagination,
   canonical import/дедуп, LLM разметка только после согласия, on_open только
   после AppLock. Проверка APK и физического Vivo отдельно.
