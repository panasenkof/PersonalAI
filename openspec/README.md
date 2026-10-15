# OpenSpec для PersAI

- `specs/<область>/spec.md` — что приложение умеет сейчас. Каждое требование подтверждается тестами.
- `changes/<изменение>/` — запланированное изменение: `proposal.md` (зачем и что), `design.md` (как), `tasks.md` (задачи с галочками), `specs/` (какие требования добавятся или изменятся).
- `changes/archive/` — выполненные изменения с датой в имени.

Сводный план и порядок работ — в [`PLAN.md`](../PLAN.md). Формат — [OpenSpec](https://github.com/Fission-AI/OpenSpec): требования со словом SHALL и сценарии WHEN/THEN.

## Контекст проекта

- Мобильное приложение на Expo (сейчас SDK 54, React Native 0.81), код в `mobile/`. Своего сервера нет.
- Память — SQLCipher на телефоне (`expo-sqlite` с `useSQLCipher`), FTS5 внутри зашифрованной базы.
- Модели — по выбору пользователя: OpenAI Responses, OpenAI-совместимые (DeepSeek, YandexGPT, OpenRouter, локальные), Anthropic Messages. Ключи в `expo-secure-store`.
- Интернет-поиск — Яндекс (Yandex Cloud Search API), Tavily или встроенный поиск OpenAI.
- Проверки: `npm run typecheck`, `npm test`, `node scripts/verify-mobile-ui.cjs`, нативная сборка APK в CI.
