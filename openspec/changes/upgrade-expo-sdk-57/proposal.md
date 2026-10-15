# Переход на Expo SDK 57

## Why
Векторы на телефоне через `react-native-executorch` требуют Expo SDK 55+ (React Native 0.83+), New Architecture и `react-native-worklets` 0.10–0.12. Проект на SDK 54. SDK 56 содержит утечку памяти Hermes v1 с worklets; в `expo@57.0.9` (React Native 0.86.2) она исправлена ([SDK 56](https://expo.dev/changelog/sdk-56.md), [SDK 57](https://expo.dev/changelog/sdk-57.md)).

## What Changes
- `expo` 54 → 57.0.9+, React Native 0.81 → 0.86.2, React 19.1 → 19.2, все `expo-*` пакеты — версии из `expo install --fix`.
- TypeScript 5.9 → 6.0 (требование SDK 56+).
- `@expo/vector-icons` указывается явно (SDK 56 перестал тянуть его через `expo`).
- С SDK 56 глобальный `fetch` — это `expo/fetch`; проверить совместимость наших запросов через XMLHttpRequest и `fetchWithTimeout`.
- Удаляются неиспользуемые пакеты: `react-native-sse`, `expo-linear-gradient`, `expo-image-picker` (и его разрешения в `app.json`).
- Зависимости обновляются задачей GitHub Actions, которая коммитит `package.json` и `package-lock.json` в ветку: из среды разработки реестр npm недоступен.

## Impact
- Минимальный iOS — 16.4. Минимальный Android не меняется.
- Затронуты: `mobile/package.json`, `mobile/package-lock.json`, `mobile/app.json`, `.github/workflows/*`, возможные правки импортов.
- Риск: `expo-speech-recognition` и SQLCipher-сборка `expo-sqlite` — проверяются нативной сборкой и приёмкой на телефоне.
