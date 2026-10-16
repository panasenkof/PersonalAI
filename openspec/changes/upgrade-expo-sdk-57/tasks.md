# Tasks

## 1. Обновление зависимостей
- [x] 1.1 Задача GitHub Actions `deps-upgrade.yml`: на push в `deps/**` выполняет обновление и коммитит `package.json` и `package-lock.json` обратно в ветку
- [x] 1.2 Сразу на `expo@57.0.30` (RN 0.86.3, React 19.2.3) с `npx expo install --fix`; промежуточные SDK не понадобились
- [x] 1.3 Удалены `react-native-sse`, `expo-linear-gradient`, `expo-image-picker`, `fast-xml-parser`, `expo-video-thumbnails` (убран в SDK 56); плагин `expo-image-picker` убран из `app.json`
- [x] 1.4 `@expo/vector-icons` уже указан явно; добавлен его обязательный `expo-font`

## 2. Совместимость кода
- [x] 2.1 TypeScript 6.0.3: в `tsconfig` явно `types: ["jest", "node"]`, добавлен `@types/node`; `tsc` без ошибок
- [x] 2.2 Оставлен fetch React Native (`EXPO_PUBLIC_USE_RN_FETCH=1` в `.env.production` и `.env.development`): загрузка аудио шлёт `FormData` с `{ uri }`; потоковые ответы и так идут через XHR
- [x] 2.3 Кадры видео — `player.generateThumbnailsAsync` + `expo-image-manipulator`; `expo-file-system/legacy` остаётся; `expo-speech-recognition` 57.1.1. Заставка — плагин `expo-splash-screen` вместо удалённого поля `splash`
- [ ] 2.4 Edge-to-edge на Android 16: отступы вкладок и полей ввода

## 3. Проверка
- [x] 3.1 `expo-doctor` 21/21, `tsc`, Jest 189/189, `expo install --check`, бандлы Android и iOS, `prebuild` с `usesCleartextTraffic` — в задаче обновления; CI — в этом PR
- [ ] 3.2 Нативная сборка APK с SQLCipher, манифест с `usesCleartextTraffic`
- [ ] 3.3 Приёмка на телефоне: вход, память, диктовка, файлы, обновление поверх `b54` без потери данных
