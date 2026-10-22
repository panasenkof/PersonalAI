import React, { useCallback, useState } from "react";
import { useFocusEffect, useIsFocused } from "@react-navigation/native";
import { View } from "react-native";
import { NebulaSkiaExperiment } from "./NebulaSkiaExperiment";
import type { NebulaPhase } from "./motion";
import { getNebulaVisualMode } from "./visualPreference";
import type { NebulaVisualMode } from "./visualMode";

/**
 * Android/iOS: use the real B+C Skia RuntimeEffect, not the lab's original PNG
 * and never the circular cropped 176px sticker of Home phase A.
 * Navigation focus completely unmounts the Skia clock when switching tabs.
 */
export function NebulaHomeArtwork({ size = 288, phase = "idle" }: {
  size?: number; phase?: NebulaPhase;
}) {
  const isFocused = useIsFocused();
  const [mode, setMode] = useState<NebulaVisualMode>("live");
  // Refresh after navigating back from the Diagnostics screen. The async
  // store access is never required for opening the encrypted chat itself.
  useFocusEffect(useCallback(() => {
    let current = true;
    void getNebulaVisualMode()
      .then(saved => { if (current) setMode(saved); })
      .catch(() => { if (current) setMode("live"); });
    return () => { current = false; };
  }, []));
  // The Skia canvas hides itself from TalkBack, while its textual status
  // remains readable: do not hide the entire subtree.
  return <View testID="nebula-home-approved-art" pointerEvents="none"
    style={{ width: size, minHeight: size, justifyContent: "center", alignItems: "center" }}>
    {isFocused
      ? <NebulaSkiaExperiment phase={phase} size={size}
          clipToCircle={false} homeCanvas pauseAnimation={mode === "static"} />
      : null}
  </View>;
}
