# Конструкция

1. В одном `phaseFilament.ts` определить `intensity, RGB, pulseHz, waveFrequency, animated` для 7 фаз и функцию `getFilamentUniforms`. `idle` задаётся нулевыми значениями.
2. В `hybridShader.ts` точно переиспользовать `deformation` и `d`; строить узкую линию в `d≈1` из центрального ядра и 2 halo; подмешивать в `outputColor` после `mix(bg,plasma,mask)`. Движение происходит через `uTime` и профиль; не подменять B texture процедурным кружком.
3. В `NebulaSkiaExperiment` отделить animated `useClock` от статичного `StaticSkiaOrb` без живого таймера. Для `offline/error/reduceMotion/background/lowPower` при работающем Skia использовать статичную форму и фазовый контур; fallback REF-ORB-B только на ошибке графики или ручном выключении.
4. В Lab поменять `previewSpeed 1|2.5` на `1|5`, переименовать кнопку, пояснить, что ×5 ускоряет **время**, а не интенсивность.
5. Тесты на фазовые профили, инварианты, прежний `CanvasKit RuntimeEffect.Make`, реальную native release сборку и ручной осмотр.

Не менять исходную PNG/JFIF, `uEnergy` или общую схему управления фазой. Screen reader получает состояние текстом.
