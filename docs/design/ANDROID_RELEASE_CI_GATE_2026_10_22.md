# PersAI — корректная проверка CI перед публикацией Android APK
Дата: 22.10.2026. Инцидент: [Publish #258](https://github.com/panasenkof/PersonalAI/actions/runs/39817910758) отказал «No successful main CI» для `6d31db5141553ef79b8cbf0e2d3add39aa481567`, хотя [CI #39817524008](https://github.com/panasenkof/PersonalAI/actions/runs/39817524008) успешно завершился на точно этом commit SHA.

## Диагноз
Старый релизный workflow повторно запрашивал API `actions/workflows/ci.yml/runs`, затем применял `gh api --jq` с выражением `env.TARGET_SHA`. На практике получен ложный ноль при существующем успешном main CI. В результате PR #93 слит, а опубликованный APK b254-a1 содержит только PR #92.

## Контракт решения
- При `workflow_run` использовать **само доверенное GitHub событие о завершении CI**, строго проверить: `action=completed`, `name=CI`, `event=push`, `head_branch=main`, `head_sha=TARGET_SHA`, `status=completed`, `conclusion=success`, исходный репозиторий совпадает. Это устраняет вторичный поиск/гонку индекса и проблему `--jq env`.
- При `workflow_dispatch` (ручной вызов) обязательно запросить `actions/runs?branch=main&head_sha=<TARGET_SHA>` и проверить наличие **успешного push CI** для этого SHA. Нельзя принять проверку PR, старого коммита, другого workflow, другого репозитория, частично выполненного CI или отсутствующие результаты.
- Сохранить защиту `git rev-parse HEAD == TARGET_SHA`, `main == TARGET_SHA`, выпуск только из актуального main и неизменённые проверки подписи, SQLCipher, versionCode и последнего выпущенного APK.
- Релизный скрипт `mobile/scripts/verify-main-ci.cjs` содержит чистые проверяемые функции для событий и API-ответа; workflow вызывает его после проверки актуальности main.
- В CI добавить автоматические тесты позитивных и негативных сценариев. После слияния проверить появление нового релиза с SHA *включая PR #93*. Native-device QA пока NOT RUN.

## Acceptance
RG-01: успешный push CI на точном SHA в `workflow_run` допускает следующий этап выпуска.
RG-02: PR CI, failed/cancelled CI, foreign repo, old SHA и незавершённый CI отклоняются.
RG-03: `workflow_dispatch` требует существующий успешный push CI на актуальном SHA, не полагается на `env.TARGET_SHA` внутри gh --jq.
RG-04: gate не изменяет подпись, SQLCipher, приложение, Nebula B+C, биометрию или память.
RG-05: публикация нового APK и реальный Android-test должны подтверждаться отдельно.
