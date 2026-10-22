# PersAI Android APK — корректировка проверки RG-04 (CI)

Дата: 22.10.2026.

## Предпосылка
PR #94 был слит, но [main CI #39822139651](https://github.com/panasenkof/PersonalAI/actions/runs/39822139651) завершился с ошибкой на тесте `RG-04`. Единственная падающая проверка `assert.doesNotMatch(workflow, /env\\.TARGET_SHA/)` ошибочно запрещает **легальные** GitHub Actions substitutions `${{ env.TARGET_SHA }}` в checkout и аргументах версии приложения. Она была введена для защиты от предыдущего неверного `gh api --jq` выражения `.head_sha == env.TARGET_SHA`.

## Требования
- REG-01: оставить разрешёнными `ref: ${{ env.TARGET_SHA }}`, `PIA_ANDROID_BUILD_SHA: ${{ env.TARGET_SHA }}`, поскольку они необходимы для проверки идентичности сборки.
- REG-02: запретить прежний `gh --jq` фильтр `.head_sha == env.TARGET_SHA` в релизном workflow; сохранять внешний `verify-main-ci.cjs` и точный `main` SHA gate.
- REG-03: не менять нативный код, кэш, сертификат, `SQLCipher`, `versionCode`, логики `Nebula` и AppLock.
- REG-04: новый `main` CI должен быть зелёным; только после этого `Publish Android release APK` может выпустить APK с #93/#94/#95. Существующий release b254-a1 не содержит #93.

## Исполнение и QA
Изменить **только** тест `verify-main-ci.test.cjs` и документированный план; запустить regression tests через CI PR. Любые заявления о фактическом новом APK должны подтверждаться GitHub Release с `.apk` вложением и exact commit SHA. Реальный Android FPS/GPU, thermal и UX остаются NOT RUN.
