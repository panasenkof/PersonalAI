# Tasks

## 1. Обновление зависимостей
- [ ] 1.1 Задача GitHub Actions `deps-upgrade.yml`: на push в `deps/**` выполняет обновление и коммитит `package.json` и `package-lock.json` обратно в ветку
- [ ] 1.2 Последовательно 54 → 55 → 56 → 57: `npx expo install expo@^<N>.0.0 --fix` на каждом шаге
- [ ] 1.3 Удалить `react-native-sse`, `expo-linear-gradient`, `expo-image-picker`; убрать плагин `expo-image-picker` из `app.json`
- [ ] 1.4 Добавить `@expo/vector-icons` явно

## 2. Совместимость кода
- [ ] 2.1 TypeScript 6: исправить новые ошибки `tsc`
- [ ] 2.2 Проверить запросы к моделям при `expo/fetch` как глобальном `fetch`; при проблемах — `EXPO_PUBLIC_USE_RN_FETCH=1`
- [ ] 2.3 `expo-video`, `expo-file-system/legacy`, `expo-speech-recognition` — проверить изменения API
- [ ] 2.4 Edge-to-edge на Android 16: отступы вкладок и полей ввода

## 3. Проверка
- [ ] 3.1 CI: typecheck, Jest, `expo install --check`, бандлы, проверка экранов
- [ ] 3.2 Нативная сборка APK с SQLCipher, манифест с `usesCleartextTraffic`
- [ ] 3.3 Приёмка на телефоне: вход, память, диктовка, файлы, обновление поверх `b54` без потери данных
