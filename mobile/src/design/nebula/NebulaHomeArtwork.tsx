import React from "react";
import { Image, View } from "react-native";
import type { NebulaPhase } from "./motion";

/**
 * Web/browser-QA fallback. Metro loads .native.tsx on Android/iOS instead.
 * Retain the approved unmodified artwork; this fallback does NOT claim Skia
 * or real motion outside the native environment.
 */
const orb = require("./assets/nebula-orb-ref-b.png");

export function NebulaHomeArtwork({ size = 288, phase: _phase = "idle" }: {
  size?: number; phase?: NebulaPhase;
}) {
  return <View pointerEvents="none" accessibilityElementsHidden
    importantForAccessibility="no-hide-descendants"
    testID="nebula-home-approved-art"
    style={{ width: size, height: size, justifyContent: "center", alignItems: "center" }}>
    <Image source={orb} accessibilityIgnoresInvertColors resizeMode="contain"
      style={{ width: size, height: size }} />
  </View>;
}
