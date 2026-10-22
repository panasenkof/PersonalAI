# Дизайн реализации

1. Чистая функция `nebulaEmptyOrbSize` принимает `listHeight,windowHeight,windowWidth,composerOccluded`, возвращает 0–320dp; во время клавиатуры максимум 96dp, а если места мало — 0.
2. `nebulaConversationOrbSize` ограничивает статусную сферу при Gboard до 80dp или скрывает, чтобы не заслонять строку ввода/чат.
3. `PromptInput` выдаёт `onFocusChange` только через необязательное свойство; `Keyboard.keyboardDidShow/Hide` замыкают случай Android IME, фокус может оставаться при Back.
4. Home измеряет реальную высоту FlatList через `onLayout` и **не вызывает scrollToEnd при пустых rows/streamText**, предотвращая обрезание рисунка.
5. Сохранить нативный Skia B+C, 5×/1×, реальные voice/LLM стадии, тёмную палитру, History, File/Camera, stop, memory, другие вкладки.
