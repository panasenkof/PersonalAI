# Дизайн-разработка: заменить статичную сферу Home живой Skia Nebula

**Основание:** пользователь показал Home с большим пустым светлым холстом и чёрным круглым PNG. Он разрешил продолжить интеграцию согласованной B+C, не менять экран блокировки.

**Нормативная спецификация:** [NEBULA_HOME_NATIVE_INTEGRATION.md](../../../docs/design/NEBULA_HOME_NATIVE_INTEGRATION.md).

**В объёме:** native Skia live orb и статусная нить с реальными фазами речи/LLM, тёмная Home-композиция, theme override только в Home, корректный tab bar, web QA fallback и полная регрессия.

**Не входит:** Figma, редизайн Memory/Settings, новые инструменты агента, изменение API/memory/SQLCipher/auth, добавление вложений в LLM-чат, экраны блокировки.
