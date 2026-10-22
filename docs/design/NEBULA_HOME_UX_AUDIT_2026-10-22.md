# PersAI · Этап 87 — первичный UX-аудит Home и сценария системной клавиатуры

**22 октября 2026 · source-based / CI evidence.** Владельцем согласована компоновка Home v0.3, утверждён Nebula B+C core ×5 / filament ×1 и единственная **системная клавиатура Android**. Этот документ — **первый этап аудита исходного кода и автоматических браузерных проверок**, а **не** завершённая визуальная проверка реального APK. Нативные скриншоты, фактические Android IME Insets, fps и battery — **NOT RUN**.

Источники: `mobile/src/screens/HomeScreen.tsx`, `mobile/src/components/PromptInput.tsx`, `mobile/src/components/IconAction.tsx`, `mobile/src/navigation.tsx`, `mobile/app.json`, `mobile/src/screens/DeviceSettingsScreen.tsx`, `mobile/scripts/verify-mobile-ui.cjs`, а также [одобренный макет](../prototypes/nebula-home-composition-v03.html) из PR #87.

## Решение по IME — обязательное правило

- Использовать **только выбранную пользователем системную клавиатуру** Android: Gboard, SwiftKey, стандартную OEM и любую IME по умолчанию. **Никаких** кастомных раскладок, собственных кнопок клавиатуры и фальшивых визуализаций внутри приложения.
- В действующем коде `PromptInput` использует React Native `TextInput multiline`, то есть штатный механизм IME **уже применяется**. Проблема — не реализация ввода символов, а **изменение доступного размера и расположение composer при открытии IME**.
- Сохранять фокус после «Очистить» (существующее поведение в `PromptInput`) и не терять черновик при закрытии/открытии IME.
- Текущее `tabBarHideOnKeyboard: true` в React Navigation сохраняем до проверки на устройстве; **не добавлять** экспериментальные обработчики клавиатуры, которые могут создавать двойное смещение.
- `Expo Android softwareKeyboardLayoutMode` по умолчанию `resize`. Выбрать `resize` или `pan` **после** двух реальных Android сравнений с Insets и статусбаром, не менять наугад: `resize` уменьшает доступный viewport, `pan` перемещает окно и иногда скрывает контекст.
- Официальные источники: [Expo keyboard handling](https://docs.expo.dev/guides/keyboard-handling/), [React Native Keyboard](https://reactnative.dev/docs/keyboard.html), [Expo Android layout mode](https://docs.expo.dev/versions/v55.0.0/config/app/#softwarekeyboardlayoutmode).

## Подтверждённые по исходникам проблемы

| ID | Приоритет | Наблюдение / конкретное место | Исправление / PR |
| --- | --- | --- | --- |
| UX-01 | **P0** | Кнопка `Файл` в **composer Home** вызывает `navigation.navigate("MemoryImport")`, а `Камера` — `MemoryImport {camera:true}`. Это **сохранение/импорт в память**, не прикрепление к диалогу, хотя рядом с полем ввода воспринимается как вложение в сообщение. | Не переименовывать эту кнопку в «Прикрепить к чату», пока не реализован message-attachment транспорт. В первом Home PR сделать действие явно «В память» и/или вынести к secondary sheet, потом отдельная функциональная спека для chat attachments. |
| UX-02 | **P1** | Шапка Home в два ряда: крупный бренд `fontSize:25` плюс отдельная строка «Интернет включён / диалоги сохраняются», съедающая высоту; не совпадает с согласованной компактной шапкой. | `NebulaHomeHeader` с одной строкой brand/model/history/new chat, соблюсти width 320dp + динамический font. Индикацию сети перенести в подробности модели при необходимости. |
| UX-03 | **P1** | Пустой Home содержит большой заголовок `Чем помочь сегодня?`, рекламно-поясняющую фразу и сетку 4 подсказок по ~78dp. Пользователь **уже отказался** от этого UI. | Убрать заголовок/сетки в пользу утверждённой объёмной Nebula сферы, без потери first-run ModelConnections, сохранить лёгкий путь подключения при отсутствии API-ключа. |
| UX-04 | **P1** | `IconAction` имеет `minWidth:56` + текстовые ярлыки для всех 5–6 действий; composer `flexWrap: "wrap"`, поэтому на 320dp кнопки распределяются на 2 ряда, поле ввода отдельно — визуальная перегрузка. | Компактная строка с понятными иконками/доступными hints, primary send/mic, secondary actions через sheet. Hit target >=48dp, реальные accessibility labels сохранять. |
| UX-05 | **P1 (проверка устройства)** | `HomeScreen` использует `KeyboardAvoidingView` с `behavior="height"` на Android поверх таб-навигации (`tabBarHideOnKeyboard`), `insets.top` и многострочного `PromptInput`. Возможны двойной сдвиг, скачок и перекрытие при IME. **Нельзя заявлять реальный баг без screenshot/device.** | Отдельный нативный тест 320/360/390/430dp, Gboard + OEM/SwiftKey, gestures/3-button, font 1.5×. Настроить `adjustResize`/KAV **только по измерению**, с тестами видимости composer; не рисовать свою клавиатуру. |
| UX-06 | **P1** | `FlatList.onContentSizeChange` безусловно `scrollToEnd({ animated: true })`. При потоковом ответе/обновлении длинного чата может тянуть читателя вниз, даже если он изучает старые сообщения. | Добавить `isNearBottom` (threshold), автопрокрутку только при nearBottom/собственной отправке и «Вниз к ответу» при ручной прокрутке вверх. Проверить streaming/regression. |
| UX-07 | **P1** | В `ListFooterComponent` одновременно streaming bubble, status spinner и предложения «Запомнить?», всё в одном потоке, но визуальная иерархия/хроматика не соответствует v0.3. | Дизайн-системные `ChatBubble`, `MemoryProposalCard`, `AssistantProgress`; раздельные статусы без укрытия входа или подмены реального LLM. |
| UX-08 | **P1** | Лабораторный Skia `NebulaSkiaExperiment` не подключен к Home. Там используется старый `FloatingBrand`; реальные статусы voice/LLM не сопоставлены. | Отдельный feature-flagged `NebulaHomeOrb` с точными состояниями и graceful fallback; экраны чата не должны постоянно рендерить большую анимацию в foreground. Измерить после интеграции. |
| UX-09 | **P1** | `DeviceSettingsScreen` — единый длинный `ScrollView` из настроек модели, логов, лимитов, поиска, голоса, резервных копий, с длинными пояснениями; жалобы на скролл/нагромождение обоснованы структурой. | После Home — разделение по компактным категориям с nested routes, секции без повторений, удерживать сохранение каждого параметра. |
| UX-10 | **P2** | Отображение исходников в виде открытых длинных `url` и плотных `Pressable`-карт памяти растягивает чат, link label не человекочитаемый. | Краткие source chips с доступным полным URL по действию; ссылка должна открываться в том же безопасном flow. |
| UX-11 | **P2** | `IconAction` подсказка показывается при первом нажатии на каждый label, с absolute-позиционированием. При узком экране, клавиатуре и Accessibility увеличении она может перекрыть соседний control. | Перейти к контекстным hints с измеряемой позицией/insets; не ломать существующий shortcut и события `onPress`. |

## Что пока нельзя считать проверенным

- Клавиатура в Android APK, resize/pan, поведение OEM IME, loss of focus при смене вкладок (нужен смартфон + adb/UIAutomator или ручное видео).
- Native layout при dynamic font, split-screen, TalkBack, cutout и gesture/3-button nav; браузерный smoke в CI — недостаточно.
- Плавность Skia в Home, CPU/GPU, frame times, battery, thermal — ожидаем главный performance gate после интеграции основных частей Home.
- Мультимодальная передача фото/PDF/аудио **в диалог**: согласно текущему коду не реализована; макет показывает только UX сценарий, не готовую функцию.

## Порядок исправлений после макета

1. **PR-A (Home foundation P1):** отдельный компактный `NebulaHomeHeader` и пустой чат без рекламных панелей, сохранив ModelConnections/память/переключение сессий; нижний composer ещё без переписывания асинхронного отправителя.
2. **PR-B (Composer P1):** compact single-line actions, insets/IME тесты и явно разграниченные «В память» vs «В диалог»; отсутствие fake attachment controls до реализации chat upload.
3. **PR-C (Чат P1):** scrollNearBottom, сообщения/streaming/memory suggestions, regression по длинным диалогам.
4. **PR-D (Skia Home P1):** только после стабилизации текста и навигации, renderer feature flag и реальные состояния LLM/voice, resource pause/fallback.
5. **Performance gate:** как только вместе работают core B+C, звездный фон, streaming history и voice; тогда baseline vs ON, fps p50/p95, память, батарея/thermal. Не ждать Settings/Memory redesign.
6. Затем Memory/Settings/Import по принципам design-system и реальным потокам.

## Android QA чек-лист для ближайшего APK

- Включить стороннюю/стандартную системную IME и переключить язык; фокус TextInput вызывает **именно системную** клавиатуру, нет копии клавиш PersAI.
- 320/360/390/430dp, 1×/1.5× font, жестовый и 3-button navbar: текстовое поле, микрофон и отправка **видны над IME**, никакие кнопки не уходят за рамки.
- Длинное multiline сообщение/прикреплённые данные и отображение подсказок не должны раздвигать composer выше допустимой зоны.
- Переключение вкладок, вход/выход из ModelConnections, работа LLM во время клавиатуры, поворот (если поддерживается) — отсутствие потерянного draft/history.
- VoiceInput, normalization и отправка должны остаться работоспособны; никакие ложные новшества обработки файлов не допускаются.

**Статус:** Составлен source-based аудит с приоритизацией и сценариями. **NOT RUN:** UI screenshots реального APK / визуальная валидация Android. Выполнять при PR-A/B (можно дать пользователю подробный чек-лист), не выдавать этот документ за финальную приемку.
