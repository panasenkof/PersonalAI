import React, { useState } from "react";
import { Pressable, SafeAreaView, ScrollView, Text, View } from "react-native";
import { NebulaSkiaExperiment } from "./NebulaSkiaExperiment";
import type { NebulaPhase } from "./motion";
import { NEBULA_FILAMENT, NEBULA_ORB_SPEED, NEBULA_FILAMENT_SPEED } from "./phaseFilament";
import { nebulaColors, nebulaSpacing } from "./tokens";

/**
 * Manual research harness only. Exported for an INTERNAL Android test build.
 * Accessible only through Settings -> Diagnostics -> Lab in a test APK.
 * NOT a production Home widget or a fourth bottom tab.
 */
const phases: NebulaPhase[] = [
  "idle", "listening", "transcribing", "thinking", "responding", "offline", "error",
];

export function NebulaSkiaLabScreen() {
  const [phase, setPhase] = useState<NebulaPhase>("idle");
  const [size, setSize] = useState(168);
  const [reduced, setReduced] = useState(false);
  const [lowPower, setLowPower] = useState(false);
  const [shader, setShader] = useState(true);
  const [compareSlow, setCompareSlow] = useState(false);
  const theme = nebulaColors("dark");
  function labToggle(text: string, active: boolean, onPress: () => void) {
    return <Pressable accessibilityRole="button"
      accessibilityLabel={text} accessibilityState={{ selected: active }}
      onPress={onPress} key={text} style={{
        minWidth: 48, minHeight: 48, padding: 12, borderWidth: 1,
        borderRadius: 13, borderColor: theme.border,
        backgroundColor: active ? theme.accent : theme.surfaceElevated,
      }}>
      <Text style={{ color: active ? theme.textOnAccent : theme.text, fontSize: 13 }}>{text}</Text>
    </Pressable>;
  }
  return <SafeAreaView style={{ flex: 1, backgroundColor: theme.canvas }}>
    <ScrollView contentContainerStyle={{ padding: nebulaSpacing.md, gap: nebulaSpacing.md }}
      accessibilityLabel="Лаборатория Skia Nebula">
      <Text accessibilityRole="header" style={{ color: theme.text, fontSize: 22, fontWeight: "700" }}>
        Nebula — Skia B+C Lab
      </Text>
      <Text style={{ color: theme.textSecondary, lineHeight: 20 }}>
        Только технический тест. Внешность и скорость не приняты; статусы здесь симулируются вручную,
        к микрофону и LLM обращений нет.
      </Text>
      <View style={{ alignItems: "center", minHeight: 220, justifyContent: "center" }}>
        <NebulaSkiaExperiment phase={phase} size={size}
          reduceMotion={reduced} powerConstrained={lowPower}
          enableNativeShader={shader} showDiagnostics
          previewSpeed={compareSlow ? NEBULA_ORB_SPEED.compare : NEBULA_ORB_SPEED.working} />
      </View>
      <Text accessibilityRole="header" style={{ color: theme.text, fontSize: 17, fontWeight: "600" }}>
        Состояние
      </Text>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 9 }}>
        {phases.map(x => labToggle(x, phase === x, () => setPhase(x)))}
      </View>
      <Text testID="nebula-motion-speeds" style={{
        color: theme.textSecondary, fontSize: 13, fontWeight: "600",
      }}>
        {"Сфера ×" + (compareSlow ? NEBULA_ORB_SPEED.compare : NEBULA_ORB_SPEED.working)
          + " · Нить ×" + NEBULA_FILAMENT_SPEED}
      </Text>
      <Text testID="nebula-state-color" style={{
        color: NEBULA_FILAMENT[phase].colorHex ?? theme.textSecondary,
        fontSize: 12,
        fontWeight: "600",
      }}>
        {phase === "idle"
          ? "Покой: неоновой нити нет"
          : `Статусная нить: ${NEBULA_FILAMENT[phase].colorHex} · интенсивность ${NEBULA_FILAMENT[phase].intensity}`}
      </Text>
      <Text accessibilityRole="header" style={{ color: theme.text, fontSize: 17, fontWeight: "600" }}>
        Режим и размеры
      </Text>
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 9 }}>
        {labToggle("44 dp", size === 44, () => setSize(44))}
        {labToggle("168 dp", size === 168, () => setSize(168))}
        {labToggle("Reduce Motion", reduced, () => setReduced(v => !v))}
        {labToggle("Экономия", lowPower, () => setLowPower(v => !v))}
        {labToggle("Skia / оригинал", shader, () => setShader(v => !v))}
        {labToggle("Сфера ×1 — сравнить", compareSlow, () => setCompareSlow(v => !v))}
      </View>
      <Text style={{ color: theme.textSecondary, fontSize: 12, lineHeight: 18 }}>
        Вверху отображается причина статичной сферы и реальный счётчик таймера
        Skia. Сфера работает на ×5, неоновая нить — ×1. Для сравнения
        формы можно временно включить «Сфера ×1 — сравнить». Если показано «SkSL не скомпилировался», сделайте снимок
        экрана и отправьте логи приложения для диагностики. Offline и error
        намеренно статичны; Android Reduce Motion имеет приоритет над тестовым
        переключателем.
      </Text>
      <Text style={{ color: theme.textSecondary, fontSize: 12, lineHeight: 18 }}>
        Процедурный шейдер использует исходный REF-ORB-B; сравнение с видео B,
        FPS p50/p95 и расход батареи необходимо выполнить отдельно в реальном APK.
      </Text>
    </ScrollView>
  </SafeAreaView>;
}
