import React from "react";
import { useIsFocused } from "@react-navigation/native";
import { View } from "react-native";
import { NebulaSkiaExperiment } from "./NebulaSkiaExperiment";
import type { NebulaPhase } from "./motion";

/**
 * Android/iOS: use the real B+C Skia RuntimeEffect, not the lab's original PNG
 * and never the circular cropped 176px sticker of Home phase A.
 * Navigation focus completely unmounts the Skia clock when switching tabs.
 */
export function NebulaHomeArtwork({ size = 288, phase = "idle" }: {
  size?: number; phase?: NebulaPhase;
}) {
  const isFocused = useIsFocused();
  return <View testID="nebula-home-approved-art" pointerEvents="none"
    accessibilityElementsHidden importantForAccessibility="no-hide-descendants"
    style={{ width: size, minHeight: size, justifyContent: "center", alignItems: "center" }}>
    {isFocused
      ? <NebulaSkiaExperiment phase={phase} size={size}
          clipToCircle={false} homeCanvas />
      : null}
  </View>;
}
