import type { AppStateStatus } from "react-native";
import type { NebulaPhase, NebulaMotionQuality } from "./motion";

/**
 * Explain why an experimental native orb has become static.
 * This is a diagnostic guard, not a replacement visual implementation.
 */
export type NebulaRendererReason =
  | "animated"
  | "shader-compilation-failed"
  | "source-image-loading"
  | "shader-disabled"
  | "app-background"
  | "reduce-motion"
  | "low-power"
  | "nonanimated-phase";

export interface NebulaRendererSignals {
  phase: NebulaPhase;
  quality: NebulaMotionQuality;
  appActive: boolean;
  reduceMotion: boolean;
  powerConstrained: boolean;
  enableNativeShader: boolean;
  compiled: boolean;
  imageReady: boolean;
}

/** An initial unknown AppState is NOT evidence that the lab is backgrounded. */
export function isNebulaLabForeground(state: AppStateStatus | null | undefined): boolean {
  return state !== "background" && state !== "inactive";
}

export function nebulaRendererReason(signals: NebulaRendererSignals): NebulaRendererReason {
  if (!signals.appActive) return "app-background";
  if (signals.reduceMotion) return "reduce-motion";
  if (signals.powerConstrained || signals.quality === "reduced") return "low-power";
  if (signals.phase === "offline" || signals.phase === "error") return "nonanimated-phase";
  if (!signals.enableNativeShader) return "shader-disabled";
  if (!signals.compiled) return "shader-compilation-failed";
  if (!signals.imageReady) return "source-image-loading";
  return "animated";
}

export const nebulaRendererLabels: Record<NebulaRendererReason, string> = {
  animated: "Skia включена: шейдер скомпилирован и текстура загружена",
  "shader-compilation-failed": "SkSL не скомпилировался: показан исходный REF-ORB-B",
  "source-image-loading": "Загружается исходная текстура REF-ORB-B",
  "shader-disabled": "Режим «Оригинал»: Skia отключена вручную",
  "app-background": "Приложение не активно: анимация остановлена",
  "reduce-motion": "Уменьшение анимации Android или лаборатории: статичный оригинал",
  "low-power": "Режим экономии: статичный оригинал",
  "nonanimated-phase": "Для offline/error предусмотрено статичное состояние",
};
