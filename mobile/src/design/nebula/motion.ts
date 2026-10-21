/**
 * State-to-motion mapping. Operations own the phase: the animation never
 * invents progress, starts recording, or overrides real microphone status.
 * No animation/rendering dependency is imported into the live app.
 */
export type NebulaPhase = "idle" | "listening" | "transcribing" | "thinking" | "responding" | "offline" | "error";
export type NebulaMotionQuality = "full" | "reduced" | "static";
export interface NebulaEnvironment {
  /** Android AccessibilityInfo.isReduceMotionEnabled or OS remove animations. */
  reduceMotion: boolean;
  /** AppState === 'active'. */
  appActive: boolean;
  /** Device is constrained by power saver / thermal budget. */
  powerConstrained: boolean;
  /** Developer/user quality preference; static override wins. */
  preferredQuality: NebulaMotionQuality;
}
export interface NebulaScene {
  phase: NebulaPhase;
  quality: NebulaMotionQuality;
  animateCore: boolean;
  animateBackground: boolean;
  /** Allowed only for explicitly requested transitions, never per message. */
  starFlight: boolean;
  /** Core is visually sophisticated even in static mode (REF-ORB-B). */
  staticArtwork: "REF-ORB-B";
  /** Text and screen-reader status must accompany all non-idle phases. */
  status: string | null;
}
const phaseStatus: Record<NebulaPhase, string | null> = {
  idle: null,
  listening: "Идёт запись",
  transcribing: "Распознаю речь",
  thinking: "Обрабатываю запрос",
  responding: "Формирую ответ",
  offline: "Соединение недоступно",
  error: "Не удалось выполнить действие",
};
export const nebulaTiming = {
  idleBreathMs: 9000,
  listeningPulseMs: 460,
  transcribingCycleMs: 1500,
  thinkingCycleMs: 3400,
  respondingFadeMs: 280,
  errorAccentMs: 360,
  starFlightMs: 1800,
} as const;

/** Pure policy shared by all future RN renderers; rendered image is separate. */
export function resolveNebulaScene(
  phase: NebulaPhase,
  environment: NebulaEnvironment,
  requestedStarFlight = false,
): NebulaScene {
  const quality: NebulaMotionQuality =
    !environment.appActive || environment.reduceMotion || environment.preferredQuality === "static"
      ? "static"
      : environment.powerConstrained || environment.preferredQuality === "reduced"
        ? "reduced"
        : "full";

  // Busy/recording, failed and offline states must never hide real status in a star flight.
  const starFlight = requestedStarFlight && quality === "full" && phase === "idle";
  return {
    phase,
    quality,
    animateCore: quality !== "static" && phase !== "offline" && phase !== "error",
    animateBackground: quality === "full" && phase === "idle",
    starFlight,
    staticArtwork: "REF-ORB-B",
    status: phaseStatus[phase],
  };
}
