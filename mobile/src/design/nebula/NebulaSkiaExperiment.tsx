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
  /** Laboratory-only acceleration for checking whether subtle membranes move. */
  previewSpeed?: 1 | 2.5;
}

function AnimatedSkiaOrb({ size, phase, speed, onImageReady, onClockTick }: {
  size: number;
  phase: NebulaPhase;
  speed: number;
  onImageReady: (ready: boolean) => void;
  onClockTick: (beat: number) => void;
}) {
  const image = useImage(poster);
  const clock = useClock();
  const energy = NEBULA_ENERGY[phase] * speed;
  useEffect(() => { onImageReady(Boolean(image)); }, [image, onImageReady]);
  // Clock observations originate on the UI thread. A static fallback no longer
  // looks like a successful running shader; this proves whether time advances.
  useAnimatedReaction(
    () => Math.floor(clock.value / 750),
    (beat, previous) => {
      if (beat !== previous) runOnJS(onClockTick)(beat);
    },
    [onClockTick],
  );
  const uniforms = useDerivedValue(() => ({
    uTime: clock.value * 0.001,
    uSize: size,
    uEnergy: energy,
    uOffline: 0,
  }), [size, energy]);

  // Correct-art fallback when SkSL is not supported by the device.
  if (!nebulaEffect || !image) {
    return <Image testID="nebula-skia-static-fallback" source={poster}
      accessibilityIgnoresInvertColors style={{ width: size, height: size }} />;
  }

  return (
    <Canvas testID="nebula-skia-canvas" style={{ width: size, height: size }}>
      <Fill>
        <Shader source={nebulaEffect} uniforms={uniforms}>
          <ImageShader image={image} fit="cover"
            rect={{ x: 0, y: 0, width: size, height: size }} />
        </Shader>
      </Fill>
    </Canvas>
  );
}

export function NebulaSkiaExperiment({
  phase,
  size = 168,
  reduceMotion,
  powerConstrained = false,
  enableNativeShader = true,
  showDiagnostics = false,
  previewSpeed = 1,
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

  const animated = enableNativeShader && scene.animateCore && scene.quality === "full"
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
          backgroundColor: colors.canvas, borderRadius: size / 2 }}>
        {animated
          ? <AnimatedSkiaOrb size={size} phase={phase}
              speed={previewSpeed} onImageReady={onImageReady} onClockTick={onClockTick} />
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
      {scene.status ? <Text accessibilityLiveRegion="polite"
        style={{ color: colors.textSecondary, textAlign: "center", fontSize: 13 }}>
        {scene.status}
      </Text> : null}
    </View>
  );
}
