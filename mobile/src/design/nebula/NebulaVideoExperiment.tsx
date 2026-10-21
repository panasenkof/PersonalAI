import React, { useEffect, useMemo, useState } from "react";
import { AccessibilityInfo, AppState, Image, Text, View } from "react-native";
import { VideoView, useVideoPlayer } from "expo-video";
import { nebulaColors } from "./tokens";
import { resolveNebulaScene, type NebulaPhase } from "./motion";

/**
 * Isolated candidate B: pre-rendered non-rigid orb based on user REF-ORB-B.
 * Only mount on an explicit R&D screen. Never substitute this for the final
 * Skia-vs-video acceptance without native device measurements and approval.
 *
 * `assets/nebula-orb-rnd.mp4` and poster are derived reproducibly from
 * original approved ZIP by scripts/generate-nebula-motion.py.
 */
const motionVideo = require("./assets/nebula-orb-rnd.mp4");
const staticPoster = require("./assets/nebula-orb-rnd-poster.png");

export interface NebulaVideoExperimentProps {
  phase: NebulaPhase;
  size?: number;
  powerConstrained?: boolean;
  /** Test/user override; Android AccessibilityInfo normally owns this. */
  reduceMotion?: boolean;
}

/** Player exists only while visible; unmount releases native video resources. */
function PlayingOrb({ size }: { size: number }) {
  const player = useVideoPlayer(motionVideo, instance => {
    instance.loop = true;
    instance.muted = true; // decorative motion NEVER interrupts voice recognition
  });
  useEffect(() => {
    player.play();
    return () => {
      player.pause();
    };
  }, [player]);
  return <VideoView
    testID="nebula-video-candidate"
    nativeControls={false}
    allowsFullscreen={false}
    contentFit="cover"
    player={player}
    style={{ width: size, height: size }}
  />;
}

export function NebulaVideoExperiment({
  phase, size = 168, powerConstrained = false, reduceMotion,
}: NebulaVideoExperimentProps) {
  const [appActive, setAppActive] = useState(AppState.currentState === "active");
  const [osReduceMotion, setOsReduceMotion] = useState(false);
  useEffect(() => {
    let mounted = true;
    const sub = AppState.addEventListener("change", state => setAppActive(state === "active"));
    void AccessibilityInfo.isReduceMotionEnabled().then(value => {
      if (mounted) setOsReduceMotion(value);
    }).catch(() => undefined);
    const subReduce = AccessibilityInfo.addEventListener("reduceMotionChanged", setOsReduceMotion);
    return () => {
      mounted = false;
      sub.remove();
      subReduce.remove();
    };
  }, []);
  const scene = useMemo(() => resolveNebulaScene(phase, {
    reduceMotion: reduceMotion ?? osReduceMotion,
    appActive,
    powerConstrained,
    preferredQuality: "full",
  }), [phase, reduceMotion, osReduceMotion, appActive, powerConstrained]);
  // The initial native trial has only 24 fps video playback. Reduced mode
  // deliberately uses the high-quality still until a lower-cost renderer exists.
  const playback = scene.quality === "full" && scene.animateCore;
  const palette = nebulaColors("dark");
  return <View testID="nebula-motion-experiment" style={{ alignItems: "center", gap: 6 }}>
    <View pointerEvents="none" accessibilityElementsHidden importantForAccessibility="no-hide-descendants"
      style={{ width: size, height: size, overflow: "hidden", borderRadius: size / 2,
        backgroundColor: palette.canvas }}>
      {playback
        ? <PlayingOrb size={size} />
        : <Image testID="nebula-reference-poster" source={staticPoster}
            style={{ width: size, height: size }} resizeMode="cover" />}
    </View>
    {scene.status ? <Text accessibilityLiveRegion="polite"
      style={{ color: palette.textSecondary, fontSize: 13, textAlign: "center" }}>
      {scene.status}
    </Text> : null}
  </View>;
}
