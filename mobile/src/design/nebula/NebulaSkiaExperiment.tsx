import React, { useEffect, useMemo, useState } from "react";
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
import { useDerivedValue } from "react-native-reanimated";
import { resolveNebulaScene, type NebulaPhase } from "./motion";
import { nebulaColors } from "./tokens";
import { NEBULA_ENERGY, NEBULA_HYBRID_SKSL } from "./hybridShader";

/**
 * RESEARCH ONLY: B detail (original image) + C dynamics (native SkSL).
 * Not connected to HomeScreen or production navigator.
 * Shader can fail on a specific Android GPU: the quality fallback is always
 * the unflattened REF-ORB-B poster, NOT a synthetic gradient circle.
 */
const poster = require("./assets/nebula-orb-ref-b.png");

// Do not use makeImageFromView: Expo 57 / Skia 2.6.2 known mismatch.
const nebulaEffect = Skia.RuntimeEffect.Make(NEBULA_HYBRID_SKSL);

export interface NebulaSkiaExperimentProps {
  phase: NebulaPhase;
  size?: number;
  /** Optional override for lab; defaults to OS accessibility preference. */
  reduceMotion?: boolean;
  /** Wire to actual battery/thermal status in future app integration. */
  powerConstrained?: boolean;
  /** Explicit stop switch for renderer comparison and device profiling. */
  enableNativeShader?: boolean;
}

function AnimatedSkiaOrb({ size, phase }: { size: number; phase: NebulaPhase }) {
  const image = useImage(poster);
  const clock = useClock();
  const energy = NEBULA_ENERGY[phase];
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
}: NebulaSkiaExperimentProps) {
  const [appActive, setAppActive] = useState(AppState.currentState === "active");
  const [osReduceMotion, setOsReduceMotion] = useState(true); // fail closed until OS query
  useEffect(() => {
    let mounted = true;
    const appSub = AppState.addEventListener("change", state => {
      if (mounted) setAppActive(state === "active");
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
    reduceMotion: reduceMotion ?? osReduceMotion,
    appActive,
    powerConstrained,
    preferredQuality: "full",
  }), [phase, reduceMotion, osReduceMotion, appActive, powerConstrained]);

  const animated = enableNativeShader && scene.animateCore && scene.quality === "full";
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
          ? <AnimatedSkiaOrb size={size} phase={phase} />
          : <Image testID="nebula-skia-poster" source={poster}
              resizeMode="cover" accessibilityIgnoresInvertColors
              style={{ width: size, height: size }} />}
      </View>
      {scene.status ? <Text accessibilityLiveRegion="polite"
        style={{ color: colors.textSecondary, textAlign: "center", fontSize: 13 }}>
        {scene.status}
      </Text> : null}
    </View>
  );
}
