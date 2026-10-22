import React, { useCallback, useEffect, useMemo, useState } from "react";
import {
  AccessibilityInfo,
  AppState,
  Image,
  Text,
  View,
} from "react-native";
import {
  Canvas,
  Fill,
  ImageShader,
  Shader,
  Skia,
  useClock,
  useImage,
} from "@shopify/react-native-skia";
import { runOnJS, useAnimatedReaction, useDerivedValue } from "react-native-reanimated";
import { resolveNebulaScene, type NebulaPhase } from "./motion";
import { nebulaColors } from "./tokens";
import { NEBULA_ENERGY, NEBULA_HYBRID_SKSL } from "./hybridShader";
import { getFilamentUniforms, getNebulaMotionParameters, NEBULA_ORB_SPEED, type NebulaOrbSpeed } from "./phaseFilament";
import { isNebulaLabForeground, nebulaRendererLabels, nebulaRendererReason } from "./rendererDiagnostics";

/**
 * RESEARCH ONLY: B detail (original image) + C dynamics (native SkSL).
 * Not connected to HomeScreen or production navigator.
 * Shader can fail on a specific Android GPU: the quality fallback is always
 * the unflattened REF-ORB-B poster, NOT a synthetic gradient circle.
 */
const poster = require("./assets/nebula-orb-ref-b.png");

// Do not use makeImageFromView: Expo 57 / Skia 2.6.2 known mismatch.
const nebulaEffect = (() => {
  try {
    const effect = Skia.RuntimeEffect.Make(NEBULA_HYBRID_SKSL);
    if (!effect) console.warn("[NebulaLab] SkSL RuntimeEffect.Make returned null; showing original artwork.");
    return effect;
  } catch (error) {
    console.warn("[NebulaLab] SkSL compilation raised an exception:", error);
    return null;
  }
})();

export interface NebulaSkiaExperimentProps {
  phase: NebulaPhase;
  size?: number;
  /** Optional override for lab; defaults to OS accessibility preference. */
  reduceMotion?: boolean;
  /** Wire to actual battery/thermal status in future app integration. */
  powerConstrained?: boolean;
  /** Explicit stop switch for renderer comparison and device profiling. */
  enableNativeShader?: boolean;
  /** Enables the laboratory status and actual Skia-clock activity indicator. */
  showDiagnostics?: boolean;
  /** Defaults to approved working orb speed ×5; ×1 only for lab comparison. */
  previewSpeed?: NebulaOrbSpeed;
  /** Home: full rectangular cosmic canvas, never a clipped black disk. */
  clipToCircle?: boolean;
  /** Match the surrounding dark Home background without a square seam. */
  homeCanvas?: boolean;
  /** A/B profiler: same Skia artwork, but fully static (no useClock subtree). */
  pauseAnimation?: boolean;
  /** Hide phase caption when this is an inline 56dp progress indicator. */
  showStatusText?: boolean;
}

/**
 * Diagnostic observer lives in its OWN subtree. The production Home renderer
 * must not wake the JS thread / React tree every 750ms for an invisible counter.
 */
function SkiaClockMeter({ clock, onClockTick }: {
  clock: ReturnType<typeof useClock>;
  onClockTick: (beat: number) => void;
}) {
  useAnimatedReaction(
    () => Math.floor(clock.value / 750),
    (beat, previous) => {
      if (beat !== previous) runOnJS(onClockTick)(beat);
    },
    [onClockTick],
  );
  return null;
}

function AnimatedSkiaOrb({ size, phase, speed, homeCanvas, onImageReady, onClockTick, showClockDiagnostics }: {
  size: number;
  phase: NebulaPhase;
  speed: NebulaOrbSpeed;
  homeCanvas: boolean;
  onImageReady: (ready: boolean) => void;
  onClockTick: (beat: number) => void;
  showClockDiagnostics: boolean;
}) {
  const image = useImage(poster);
  const clock = useClock();
  // Speed multiplies elapsed TIME only, never deformation/energy/intensity.
  const energy = NEBULA_ENERGY[phase];
  const filament = useMemo(() => getFilamentUniforms(phase, true), [phase]);
  const motion = useMemo(() => getNebulaMotionParameters(phase, speed), [phase, speed]);
  const orbSpeed = motion.orbSpeed, lineSpeed = motion.lineSpeed, thinking = motion.thinking;
  useEffect(() => { onImageReady(Boolean(image)); }, [image, onImageReady]);
  // Shader clock stays entirely on UI/GPU; bridge diagnostics only in the lab.
  const uniforms = useDerivedValue(() => ({
    uTime: clock.value * 0.001 * orbSpeed,
    uLineTime: clock.value * 0.001 * lineSpeed,
    uThinking: thinking,
    uSize: size,
    uEnergy: energy,
    uOffline: 0,
    uHomeCanvas: homeCanvas ? 1 : 0,
    uLineR: filament.uLineR,
    uLineG: filament.uLineG,
    uLineB: filament.uLineB,
    uLineIntensity: filament.uLineIntensity,
    uLinePulseHz: filament.uLinePulseHz,
    uLineWave: filament.uLineWave,
    uLineAnimate: filament.uLineAnimate,
  }), [size, energy, orbSpeed, lineSpeed, thinking, filament, homeCanvas]);

  // Correct-art fallback when SkSL is not supported by the device.
  if (!nebulaEffect || !image) {
    return <Image testID="nebula-skia-static-fallback" source={poster}
      accessibilityIgnoresInvertColors style={{ width: size, height: size }} />;
  }

  return (
    <>
      {showClockDiagnostics ? <SkiaClockMeter clock={clock} onClockTick={onClockTick} /> : null}
      <Canvas testID="nebula-skia-canvas" style={{ width: size, height: size }}>
        <Fill>
          <Shader source={nebulaEffect} uniforms={uniforms}>
            <ImageShader image={image} fit="cover"
              rect={{ x: 0, y: 0, width: size, height: size }} />
          </Shader>
        </Fill>
      </Canvas>
    </>
  );
}

/**
 * Statically shader-rendered B+C artwork WITH the current status filament.
 * No useClock / no loop; offline, error, reduced-motion, background and
 * low-power states therefore remain accessible and truly motionless.
 */
function StaticSkiaOrb({ size, phase, homeCanvas, onImageReady }: {
  size: number;
  phase: NebulaPhase;
  homeCanvas: boolean;
  onImageReady: (ready: boolean) => void;
}) {
  const image = useImage(poster);
  useEffect(() => { onImageReady(Boolean(image)); }, [image, onImageReady]);
  const uniforms = useMemo(() => ({
    uTime: 0,
    uLineTime: 0,
    uThinking: phase === "thinking" ? 1 : 0,
    uSize: size,
    uEnergy: NEBULA_ENERGY[phase],
    uOffline: phase === "offline" ? 1 : 0,
    uHomeCanvas: homeCanvas ? 1 : 0,
    ...getFilamentUniforms(phase, false),
  }), [size, phase, homeCanvas]);
  if (!nebulaEffect || !image) {
    return <Image testID="nebula-skia-static-fallback" source={poster}
      accessibilityIgnoresInvertColors style={{ width: size, height: size }} />;
  }
  return <Canvas testID="nebula-skia-static-canvas" style={{ width: size, height: size }}>
    <Fill>
      <Shader source={nebulaEffect} uniforms={uniforms}>
        <ImageShader image={image} fit="cover"
          rect={{ x: 0, y: 0, width: size, height: size }} />
      </Shader>
    </Fill>
  </Canvas>;
}

export function NebulaSkiaExperiment({
  phase,
  size = 168,
  reduceMotion,
  powerConstrained = false,
  enableNativeShader = true,
  showDiagnostics = false,
  previewSpeed = NEBULA_ORB_SPEED.working,
  clipToCircle = true,
  homeCanvas = false,
  pauseAnimation = false,
  showStatusText = true,
}: NebulaSkiaExperimentProps) {
  const [appActive, setAppActive] = useState(isNebulaLabForeground(AppState.currentState));
  const [imageReady, setImageReady] = useState(false);
  const [clockBeat, setClockBeat] = useState(0);
  const onImageReady = useCallback((ready: boolean) => setImageReady(ready), []);
  const onClockTick = useCallback((beat: number) => setClockBeat(beat), []);
  const [osReduceMotion, setOsReduceMotion] = useState(true); // fail closed until OS query
  useEffect(() => {
    let mounted = true;
    // AppState can initially be null while React Native initializes native
    // state; a visible diagnostic screen is presumed foreground until known
    // otherwise, and later background events correctly stop animation.
    if (mounted) setAppActive(isNebulaLabForeground(AppState.currentState));
    const appSub = AppState.addEventListener("change", state => {
      if (mounted) setAppActive(isNebulaLabForeground(state));
    });
    void AccessibilityInfo.isReduceMotionEnabled()
      .then(enabled => { if (mounted) setOsReduceMotion(enabled); })
      .catch(() => { if (mounted) setOsReduceMotion(true); });
    const motionSub = AccessibilityInfo.addEventListener(
      "reduceMotionChanged", enabled => {
        if (mounted) setOsReduceMotion(enabled);
      });
    return () => {
      mounted = false;
      appSub.remove();
      motionSub.remove();
    };
  }, []);

  const scene = useMemo(() => resolveNebulaScene(phase, {
    reduceMotion: Boolean(osReduceMotion || reduceMotion),
    appActive,
    powerConstrained,
    preferredQuality: "full",
  }), [phase, reduceMotion, osReduceMotion, appActive, powerConstrained]);

  const animated = enableNativeShader && !pauseAnimation && scene.animateCore && scene.quality === "full"
    && Boolean(nebulaEffect);
  const reason = nebulaRendererReason({
    phase,
    quality: scene.quality,
    appActive,
    reduceMotion: Boolean(osReduceMotion || reduceMotion),
    powerConstrained,
    enableNativeShader,
    compiled: Boolean(nebulaEffect),
    imageReady,
    pauseAnimation,
  });
  const colors = nebulaColors("dark");
  // The Skia subtree is UNMOUNTED when inactive/reduced/offline rather than
  // trying to keep a hidden animation clock running in the background.
  return (
    <View testID="nebula-skia-experiment"
      style={{ alignItems: "center", justifyContent: "center", gap: 8 }}>
      <View pointerEvents="none"
        accessibilityElementsHidden importantForAccessibility="no-hide-descendants"
        style={{ width: size, height: size, overflow: "hidden",
          backgroundColor: colors.canvas, borderRadius: clipToCircle ? size / 2 : 0 }}>
        {animated
          ? <AnimatedSkiaOrb size={size} phase={phase}
              speed={previewSpeed} homeCanvas={homeCanvas}
              onImageReady={onImageReady} onClockTick={onClockTick}
              showClockDiagnostics={showDiagnostics} />
          : enableNativeShader && Boolean(nebulaEffect)
            ? <StaticSkiaOrb size={size} phase={phase} homeCanvas={homeCanvas} onImageReady={onImageReady} />
            : <Image testID="nebula-skia-poster" source={poster}
                resizeMode="cover" accessibilityIgnoresInvertColors
                style={{ width: size, height: size }} />}
      </View>
      {showDiagnostics ? <View style={{ alignItems: "center", gap: 3, paddingHorizontal: 8 }}>
        <Text testID="nebula-renderer-reason" accessibilityRole="text"
          style={{ color: reason === "animated" ? colors.success : colors.warning,
            fontSize: 12, textAlign: "center" }}>
          {nebulaRendererLabels[reason]}
        </Text>
        <Text testID="nebula-clock-beat" style={{
          color: colors.textSecondary, fontSize: 11, textAlign: "center",
        }}>
          {animated ? `Skia clock: ${clockBeat} × 750 мс`
            : "Таймер остановлен (статичный оригинал)"}
        </Text>
      </View> : null}
      {showStatusText && scene.status ? <Text accessibilityLiveRegion="polite"
        style={{ color: colors.textSecondary, textAlign: "center", fontSize: 13 }}>
        {scene.status}
      </Text> : null}
    </View>
  );
}
