# Telegram B11 — закреплённая сборка TDLib: две ABI и страницы 16 КиБ

10.11.2026. Пакет **сборочной инфраструктуры**. Не содержит бинарники, не меняет авторизацию и не означает готовность Telegram в обычном APK.

## Аудит до PR (C0-A)
- Canonical SQLCipher writer, on_open после AppLock, резервный Bot API, read-only TDLib/topics уже присутствуют. **Никаких вторых механизмов хранения или исполнения**.
- Ручной source workflow на ubuntu-24.04 использует официальный tdlib/td @ `c8828d50f5eac2fc7089ce1089d7ce9095c61b5e`, OpenSSL 3.5.9 с проверенным объектом release tag, Android NDK 27.0.12077973.
- Официальный скрипт `build-openssl.sh` по умолчанию компилирует **четыре** ABI (arm64-v8a, armeabi-v7a, x86_64, x86), тогда как PersAI нужны только **arm64-v8a и x86_64**. Это расход GitHub Actions без пользы.
- Для NDK r27 при сборке TDLib явно включаем `ANDROID_SUPPORT_FLEXIBLE_PAGE_SIZES=ON` и linker `-z max-page-size=16384`, иначе проверка ELF64 PT_LOAD ≥16384 может отклонить бинарник на Android 15/16.

## B11
- После `git checkout` фиксированного upstream SHA `patch-upstream.cjs` сверяет два **точных** известных исходных фрагмента, до записи обоих файлов; при изменении upstream fails closed.
- OpenSSL builder собирает только ABI, входящие в обязательный артефакт. JNI TDLib linker выравнивается под 16-КБ страницы.
- Результат всё равно проходит прежние SHA-256/ELF64/PT_LOAD/manifest/ZIP/R8/SDK provenance/CI checks. Патч **явно отражён в коде PersAI** и не подменяет независимую проверку бинарника.
- В CI/source workflow добавлены проверки патча, недоступность повторного применения, неправильная версия upstream вызывает отказ.
- Запуск manual workflow по-прежнему **не автоматический**, чтобы не расходовать GitHub Actions без необходимости; timeout ограничен, обычный CI не компилирует TDLib.

## Критерии приёмки
1. Source-run на `main` (ручной) на точном SHA, артефакт verified, обе ABI, обе ELF выравниваются ≥16К.
2. Следующий manual source-to-APK workflow подтверждает provenance, JNI/R8, Expo/SQLCipher, release APK, emulator.
3. Отдельный reviewed PR pin digest в обычный signed upgrade APK.
4. На Vivo X200 Pro Android 16 реальный номер/код/2FA, logout, AppLock, «Избранное»/подборки и дедуп. **NOT_RUN_PHYSICAL**.

## Postflight C0-A/C3-B
Только скрипты source-build и CI тесты/документация. Обычные APK без официального TDLib binary остаются fail-closed. Внешний API-ключ, TDLib database key и сообщение Telegram не уходят в CI.
