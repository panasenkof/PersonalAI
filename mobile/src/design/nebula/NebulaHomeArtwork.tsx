import React from "react";
import { Image, View } from "react-native";

/**
 * Approved original REF-ORB-B, only as a high-quality STILL for the Home
 * migration. The final stateful Skia integration is a separate PR and needs
 * a native FPS/battery gate. Never substitute a simple gradient/circle.
 */
const orb = require("./assets/nebula-orb-ref-b.png");

export function NebulaHomeArtwork({ size = 176 }: { size?: number }) {
  return <View pointerEvents="none" accessibilityElementsHidden importantForAccessibility="no-hide-descendants"
    testID="nebula-home-approved-art" style={{
      width: size, height: size, borderRadius: size / 2, overflow: "hidden",
    }}>
    <Image source={orb} accessibilityIgnoresInvertColors
      resizeMode="cover" style={{ width: size, height: size }} />
  </View>;
}
